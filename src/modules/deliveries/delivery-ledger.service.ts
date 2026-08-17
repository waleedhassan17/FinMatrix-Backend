import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { Delivery } from './entities/delivery.entity';
import { DeliveryItem } from './entities/delivery-item.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { SalesOrder } from '../sales-orders/entities/sales-order.entity';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { SalesOrdersService } from '../sales-orders/sales-orders.service';
import { InvoicesService } from '../invoices/invoices.service';
import { PaymentsService } from '../payments/payments.service';
import { CreditMemosService } from '../credit-memos/credit-memos.service';
import {
  ACCT_COGS,
  ACCT_GOODS_IN_TRANSIT,
  ACCT_INVENTORY,
} from '../accounts/accounts.constants';
import { toDecimal, MONEY_TOLERANCE } from '../../common/utils/money.util';

/**
 * Result of the Stage-1 commit, echoed to the admin UI so the dispatcher sees
 * the accounting consequence of assigning the delivery.
 */
export interface DispatchLedgerResult {
  committed: boolean;
  alreadyCommitted?: boolean;
  salesOrderId?: string | null;
  salesOrderNumber?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  goodsInTransitCost?: string;
  journalEntryId?: string | null;
}

export interface ApprovalLedgerResult {
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceTotal: string | null;
  paymentId: string | null;
  cogsJournalEntryId: string | null;
  cogsAmount: string;
  restockedCost: string;
  paidStatus: 'paid' | 'unpaid';
  /** Prepaid deliveries only: credit raised for goods the customer sent back. */
  creditMemoId: string | null;
  creditMemoNumber: string | null;
  creditMemoTotal: string | null;
}

/**
 * phase1.md — links the delivery lifecycle to the accounting ledger.
 *
 * STAGE 1 (admin assigns):   Sales Order (non-posting; Invoice+Payment when
 *                            prepaid) + Dr Goods in Transit 1250 / Cr
 *                            Inventory 1200 at frozen cost + on-hand reduced.
 * STAGE 3 (admin approves):  SO → Invoice (revenue: A/R or, when the rider
 *                            collected cash, A/R immediately cleared by a
 *                            recorded Payment) + Dr COGS 5000 / Cr GIT 1250
 *                            for the delivered part, Dr Inventory / Cr GIT for
 *                            the returned/undelivered part.
 * REJECT:                    full reversal Dr Inventory / Cr GIT + restock.
 *
 * Every method REQUIRES the caller's EntityManager so posting + stock movement
 * commit or roll back together. All journal lines go through the shared
 * PostingService — no posting logic lives here beyond assembling lines.
 */
@Injectable()
export class DeliveryLedgerService {
  constructor(
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly salesOrders: SalesOrdersService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly creditMemos: CreditMemosService,
  ) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Put returned units back on the shelf and fold them into the weighted
   * average AT THE COST THEY LEFT AT.
   *
   *   (Q·A + q·f) / (Q + q)
   *
   * The journal entry for a return moves Inventory 1200 by q × f, the cost
   * frozen on the delivery line at dispatch. Raising quantityOnHand without
   * touching unitCost moves the valuation report (qty × unit_cost) by q × A
   * instead, so the subledger and the control account drift apart by
   * q × (A − f) — invariant I13.
   *
   * Nothing showed it because it needs the average to MOVE while the goods are
   * on the van: dispatch 5 at 100, receive 10 at 200 (average → 166.6667),
   * then return the 5. Measured on that exact sequence, the books drifted by
   * 333.35 — 5 × (166.6667 − 100), to the cent.
   *
   * Credit-memo restock has always done this and explains why in a comment
   * (credit-memos.service.ts). The delivery paths never got the same treatment.
   *
   * Mutates the item; the caller saves it.
   */
  private absorbReturnIntoAverage(
    item: InventoryItem,
    qty: Decimal,
    frozenUnitCost: Decimal,
  ): Decimal {
    const onHand = toDecimal(item.quantityOnHand);
    const newQty = onHand.plus(qty);
    if (newQty.greaterThan(0)) {
      const nextValue = onHand
        .times(toDecimal(item.unitCost))
        .plus(qty.times(frozenUnitCost));
      item.unitCost = nextValue
        .dividedBy(newQty)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
        .toFixed(4);
    }
    item.quantityOnHand = newQty.toFixed(4);
    return newQty;
  }

  /**
   * Dispatched quantity of a delivery line. orderedQty is canonical; rows
   * written before the DTO fix (whitelist stripped orderedQty → 0) carried
   * the real amount in `quantity`, so fall back to it.
   */
  private lineQty(line: DeliveryItem): Decimal {
    const ordered = toDecimal(line.orderedQty);
    return ordered.greaterThan(0) ? ordered : toDecimal(line.quantity);
  }

  /**
   * STAGE 1 — commit stock when a delivery is assigned to a rider.
   * Idempotent: a delivery whose stock was already committed is a no-op.
   * Caller must invoke this INSIDE its own transaction.
   */
  async commitStockOnAssign(
    em: EntityManager,
    companyId: string,
    userId: string,
    deliveryId: string,
  ): Promise<DispatchLedgerResult> {
    const deliveryRepo = em.getRepository(Delivery);
    const itemRepo = em.getRepository(DeliveryItem);

    // Row-lock the delivery so two concurrent assigns can't both commit.
    const delivery = await deliveryRepo
      .createQueryBuilder('d')
      .setLock('pessimistic_write')
      .where('d.id = :id AND d.companyId = :cid', { id: deliveryId, cid: companyId })
      .getOne();
    if (!delivery) throw new NotFoundException('Delivery not found');

    if (delivery.stockCommittedAt) {
      return {
        committed: false,
        alreadyCommitted: true,
        salesOrderId: delivery.salesOrderId,
        invoiceId: delivery.invoiceId,
        journalEntryId: delivery.gitJournalEntryId,
      };
    }

    const items = await itemRepo.find({ where: { deliveryId: delivery.id } });
    // Stock moves in whole units only. The DTO already rejects bad input on
    // the HTTP surface; this guards every other path (auto-assign, legacy
    // rows, direct service calls) so a zero/negative/fractional line can
    // never silently dispatch or corrupt the books.
    for (const line of items) {
      const q = this.lineQty(line);
      if (!q.isInteger() || q.lessThanOrEqualTo(0)) {
        throw new UnprocessableEntityException({
          code: 'INVALID_QUANTITY',
          message: `Cannot dispatch ${q.toString()} x ${line.itemName ?? line.itemId}: quantity must be a positive whole number.`,
        });
      }
    }
    const activeItems = items;
    if (activeItems.length === 0) {
      // Nothing physical to dispatch — no stock movement, no documents.
      return { committed: false };
    }

    // ---- Move the stock off the shelf at frozen weighted-average cost ----
    const invRepo = em.getRepository(InventoryItem);
    const moveRepo = em.getRepository(InventoryMovement);
    let totalCost = new Decimal(0);

    for (const line of activeItems) {
      const item = await invRepo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i.companyId = :cid', { id: line.itemId, cid: companyId })
        .getOne();
      if (!item) {
        throw new NotFoundException({
          code: 'ITEM_NOT_FOUND',
          message: `Inventory item for delivery line '${line.itemName ?? line.itemId}' not found`,
        });
      }

      const qty = this.lineQty(line);
      const onHand = toDecimal(item.quantityOnHand);
      if (onHand.lessThan(qty)) {
        throw new UnprocessableEntityException({
          code: 'INSUFFICIENT_STOCK',
          message: `Cannot dispatch ${qty.toFixed(0)} x ${item.name}: only ${onHand.toFixed(0)} on hand.`,
        });
      }

      const newQty = onHand.minus(qty);
      item.quantityOnHand = newQty.toFixed(4);
      await invRepo.save(item);

      // Freeze the cost basis on the delivery line (see delivery-item entity).
      line.unitCost = toDecimal(item.unitCost).toFixed(4);
      await itemRepo.save(line);
      totalCost = totalCost.plus(qty.times(toDecimal(item.unitCost)));

      await moveRepo.save(
        moveRepo.create({
          companyId,
          itemId: item.id,
          date: this.today(),
          type: 'delivery',
          quantityChange: qty.negated().toFixed(4),
          balanceAfter: newQty.toFixed(4),
          reference: delivery.referenceNo ?? delivery.id,
          sourceType: 'delivery_dispatch',
          sourceId: delivery.id,
          createdBy: userId,
          description: `dispatched: ${delivery.referenceNo ?? delivery.id}`,
        }),
      );
    }

    // ---- Sale document: SO (non-posting) or Invoice+Payment when prepaid ----
    const soLines = activeItems.map((l) => ({
      description: l.itemName ?? l.itemId,
      quantity: this.lineQty(l).toFixed(4),
      unitPrice: toDecimal(l.unitPrice).toFixed(4),
      taxRate: toDecimal(l.taxRate ?? '0').toFixed(4),
    }));

    let salesOrderId: string | null = null;
    let salesOrderNumber: string | null = null;
    let invoiceId: string | null = null;
    let invoiceNumber: string | null = null;

    if (delivery.prepaid) {
      // Pre-paid before dispatch: Invoice posts Dr A/R / Cr Sales / Cr Tax and
      // the recorded Payment posts Dr Cash / Cr A/R — net Dr Cash / Cr Sales.
      // Lines carry NO itemId: the cost side flows through Goods in Transit,
      // not the invoice COGS path (which would double-relieve Inventory).
      const invoice = await this.invoices.createInTransaction(em, companyId, userId, {
        customerId: delivery.customerId,
        invoiceDate: this.today(),
        dueDate: this.today(),
        status: 'sent',
        notes: `Pre-paid delivery ${delivery.referenceNo ?? delivery.id}`,
        lines: soLines,
      });
      invoiceId = invoice.id;
      invoiceNumber = invoice.invoiceNumber;
      await this.payments.receiveInTransaction(em, companyId, userId, {
        customerId: delivery.customerId,
        paymentDate: this.today(),
        paymentMethod: 'cash',
        amount: invoice.total,
        reference: delivery.referenceNo ?? undefined,
        memo: `Pre-paid before dispatch — delivery ${delivery.referenceNo ?? delivery.id}`,
        applications: [{ invoiceId: invoice.id, amount: invoice.total }],
      });
      delivery.paidStatus = 'paid';
    } else {
      const so = await this.salesOrders.createInTransaction(em, companyId, userId, {
        customerId: delivery.customerId,
        orderDate: this.today(),
        notes: `Delivery ${delivery.referenceNo ?? delivery.id}`,
        lines: soLines,
      });
      salesOrderId = so.id;
      salesOrderNumber = so.orderNumber;
    }

    // ---- The Stage-1 posting: Dr Goods in Transit / Cr Inventory at cost ----
    let journalEntryId: string | null = null;
    if (totalCost.abs().greaterThan(MONEY_TOLERANCE)) {
      const git = await this.accounts.getOrCreateSystemAccount(
        em,
        companyId,
        ACCT_GOODS_IN_TRANSIT,
      );
      const inventory = await this.accounts.getByNumberOrFail(
        companyId,
        ACCT_INVENTORY,
        em,
      );
      const value = totalCost.toFixed(4);
      const entry = await this.posting.createEntry(em, {
        companyId,
        date: this.today(),
        memo: `Delivery ${delivery.referenceNo ?? delivery.id} dispatched — stock in transit`,
        createdBy: userId,
        status: 'posted',
        sourceType: 'delivery_dispatch',
        sourceId: delivery.id,
        lines: [
          { accountId: git.id, description: 'Goods in transit (at cost)', debit: value, credit: '0', lineOrder: 0 },
          { accountId: inventory.id, description: 'Inventory dispatched to rider', debit: '0', credit: value, lineOrder: 1 },
        ],
      });
      journalEntryId = entry.id;
    }

    delivery.salesOrderId = salesOrderId;
    delivery.invoiceId = invoiceId;
    delivery.gitJournalEntryId = journalEntryId;
    delivery.stockCommittedAt = new Date();
    delivery.ledgerStatus = 'in_transit';
    await deliveryRepo.save(delivery);

    return {
      committed: true,
      salesOrderId,
      salesOrderNumber,
      invoiceId,
      invoiceNumber,
      goodsInTransitCost: totalCost.toFixed(4),
      journalEntryId,
    };
  }

  /**
   * STAGE 3 — admin approval: the posting moment.
   *
   * deliveredByItem maps itemId → quantity the customer actually accepted
   * (from the rider's inventory-update request). Items without an entry are
   * treated as fully delivered. Anything dispatched but not delivered returns
   * to Inventory. Goods in Transit is relieved IN FULL at the frozen cost, so
   * it nets to zero for the delivery.
   */
  async commitApproval(
    em: EntityManager,
    companyId: string,
    userId: string,
    deliveryId: string,
    deliveredByItem: Map<string, string>,
  ): Promise<ApprovalLedgerResult> {
    const deliveryRepo = em.getRepository(Delivery);
    const itemRepo = em.getRepository(DeliveryItem);

    const delivery = await deliveryRepo
      .createQueryBuilder('d')
      .setLock('pessimistic_write')
      .where('d.id = :id AND d.companyId = :cid', { id: deliveryId, cid: companyId })
      .getOne();
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (delivery.ledgerStatus === 'committed') {
      throw new ConflictException({
        code: 'ALREADY_COMMITTED',
        message: 'This delivery has already been posted to the ledger.',
      });
    }
    if (delivery.ledgerStatus !== 'in_transit') {
      throw new BadRequestException({
        code: 'NOT_IN_TRANSIT',
        message: `Delivery ledger status is '${delivery.ledgerStatus}' — nothing to approve.`,
      });
    }

    const paidStatus: 'paid' | 'unpaid' = delivery.paidStatus === 'paid' ? 'paid' : 'unpaid';
    const items = await itemRepo.find({ where: { deliveryId: delivery.id } });
    const activeItems = items.filter((i) => this.lineQty(i).greaterThan(0));

    // ---- Split each dispatched line into delivered vs returned-to-stock ----
    const invRepo = em.getRepository(InventoryItem);
    const moveRepo = em.getRepository(InventoryMovement);
    let cogsCost = new Decimal(0);
    let restockCost = new Decimal(0);
    const invoiceLines: { description: string; quantity: string; unitPrice: string; taxRate: string }[] = [];
    // Prepaid only: the undelivered portion, valued at SALE price. A prepaid
    // delivery is invoiced in full at dispatch, so anything the customer sends
    // back has to be credited or revenue and tax stay overstated.
    const returnedSaleLines: { description: string; quantity: string; unitPrice: string; taxRate: string }[] = [];
    let returnedSaleValue = new Decimal(0);

    for (const line of activeItems) {
      const dispatched = this.lineQty(line);
      const requested = deliveredByItem.has(line.itemId)
        ? toDecimal(deliveredByItem.get(line.itemId)!)
        : dispatched; // no rider line → fully delivered
      const delivered = requested.greaterThan(dispatched)
        ? dispatched
        : requested.lessThan(0)
          ? new Decimal(0)
          : requested;
      const returned = dispatched.minus(delivered);
      const unitCost = toDecimal(line.unitCost);

      cogsCost = cogsCost.plus(delivered.times(unitCost));

      line.deliveredQty = delivered.toFixed(4);
      line.returnedQty = returned.toFixed(4);
      await itemRepo.save(line);

      if (delivered.greaterThan(0)) {
        invoiceLines.push({
          description: line.itemName ?? line.itemId,
          quantity: delivered.toFixed(4),
          unitPrice: toDecimal(line.unitPrice).toFixed(4),
          taxRate: toDecimal(line.taxRate ?? '0').toFixed(4),
        });
      }

      if (returned.greaterThan(0)) {
        // NOTE: no itemId on this line. The restock happens immediately below
        // as part of the delivery ledger; letting the credit memo restock it
        // too would put the units back twice and break I13.
        returnedSaleLines.push({
          description: line.itemName ?? line.itemId,
          quantity: returned.toFixed(4),
          unitPrice: toDecimal(line.unitPrice).toFixed(4),
          taxRate: toDecimal(line.taxRate ?? '0').toFixed(4),
        });
        returnedSaleValue = returnedSaleValue.plus(returned.times(toDecimal(line.unitPrice)));
        const item = await invRepo
          .createQueryBuilder('i')
          .setLock('pessimistic_write')
          .where('i.id = :id AND i.companyId = :cid', { id: line.itemId, cid: companyId })
          .getOne();
        // Only owe the GL what the subledger can actually absorb: the restock
        // cost is added AFTER the item is known to exist, so a deleted item
        // can never leave 1200 debited for stock nobody holds (I13).
        if (item) {
          restockCost = restockCost.plus(returned.times(unitCost));
          const newQty = this.absorbReturnIntoAverage(item, returned, unitCost);
          await invRepo.save(item);
          await moveRepo.save(
            moveRepo.create({
              companyId,
              itemId: item.id,
              date: this.today(),
              type: 'return',
              quantityChange: returned.toFixed(4),
              balanceAfter: newQty.toFixed(4),
              reference: delivery.referenceNo ?? delivery.id,
              sourceType: 'delivery_return',
              sourceId: delivery.id,
              createdBy: userId,
              description: `undelivered/returned on approval: ${delivery.referenceNo ?? delivery.id}`,
            }),
          );
        }
      }
    }

    // ---- Revenue entry: SO → Invoice (skipped when prepaid — already posted) ----
    let invoiceId: string | null = delivery.invoiceId;
    let invoiceNumber: string | null = null;
    let invoiceTotal: string | null = null;
    let paymentId: string | null = null;
    let creditMemoId: string | null = null;
    let creditMemoNumber: string | null = null;
    let creditMemoTotal: string | null = null;

    if (!delivery.prepaid && invoiceLines.length > 0) {
      const invoice = await this.invoices.createInTransaction(em, companyId, userId, {
        customerId: delivery.customerId,
        invoiceDate: this.today(),
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        status: 'sent',
        notes: `Delivery ${delivery.referenceNo ?? delivery.id} approved${
          delivery.salesOrderId ? ' — converted from sales order' : ''
        }`,
        lines: invoiceLines,
      });
      invoiceId = invoice.id;
      invoiceNumber = invoice.invoiceNumber;
      invoiceTotal = invoice.total;

      if (delivery.salesOrderId) {
        const soRepo = em.getRepository(SalesOrder);
        const so = await soRepo.findOne({
          where: { id: delivery.salesOrderId, companyId },
        });
        if (so && so.status !== 'invoiced') {
          so.status = 'invoiced';
          so.invoiceId = invoice.id;
          await soRepo.save(so);
        }
      }

      if (paidStatus === 'paid') {
        // Rider collected cash on the doorstep: clear the invoice now.
        // Net effect of invoice + payment = Dr Cash / Cr Sales / Cr Tax.
        const payment = await this.payments.receiveInTransaction(em, companyId, userId, {
          customerId: delivery.customerId,
          paymentDate: this.today(),
          paymentMethod: 'cash',
          amount: invoice.total,
          reference: delivery.referenceNo ?? undefined,
          memo: `Collected by rider — delivery ${delivery.referenceNo ?? delivery.id}`,
          applications: [{ invoiceId: invoice.id, amount: invoice.total }],
        });
        paymentId = payment.id;
      }
    } else if (delivery.prepaid && returnedSaleValue.greaterThan(MONEY_TOLERANCE)) {
      // A prepaid delivery was invoiced and paid IN FULL at dispatch, and the
      // branch above deliberately skips invoicing at approval. Without this,
      // goods the customer sent back left revenue and output tax overstated by
      // the undelivered value forever — the cost side reversed correctly while
      // the sale side did not. Unreachable until riders could record a partial
      // delivery, which is why it went unnoticed.
      //
      // The memo credits Sales Revenue and Tax Payable against A/R, leaving an
      // open credit the customer can apply to a later invoice or take as a
      // refund. Its lines carry no itemId: the units were already restocked
      // above, and crediting them again would double the stock and drift the
      // inventory subledger away from account 1200 (invariant I13).
      //
      // Guarded on VALUE, not on line count. Returning only zero-priced units
      // (a free sample on an otherwise paid delivery) yields a zero-total memo,
      // whose journal line would carry neither a debit nor a credit —
      // PostingService rejects that, and since this runs inside the approval's
      // transaction the whole approval would roll back, leaving the admin
      // unable to approve the delivery at all. Nothing is owed back for goods
      // that were never charged for, so there is nothing to credit.
      const creditMemo = await this.creditMemos.createInTransaction(em, companyId, userId, {
        customerId: delivery.customerId,
        date: this.today(),
        originalInvoiceId: delivery.invoiceId ?? undefined,
        reason: `Undelivered goods returned — delivery ${delivery.referenceNo ?? delivery.id}`,
        lines: returnedSaleLines,
      });
      creditMemoId = creditMemo.id;
      creditMemoNumber = creditMemo.creditMemoNumber;
      creditMemoTotal = creditMemo.total;
    } else if (!delivery.prepaid && invoiceLines.length === 0 && delivery.salesOrderId) {
      // Nothing was delivered — cancel the sales order; the stock reversal
      // below returns everything to the shelf.
      const soRepo = em.getRepository(SalesOrder);
      const so = await soRepo.findOne({ where: { id: delivery.salesOrderId, companyId } });
      if (so && so.status !== 'invoiced') {
        so.status = 'cancelled';
        await soRepo.save(so);
      }
    }

    // ---- Cost entry: relieve Goods in Transit IN FULL at the frozen cost ----
    // Dr COGS (delivered part) + Dr Inventory (returned part) / Cr GIT (total).
    let cogsJournalEntryId: string | null = null;
    const totalGitRelief = cogsCost.plus(restockCost);
    if (totalGitRelief.abs().greaterThan(MONEY_TOLERANCE)) {
      const git = await this.accounts.getOrCreateSystemAccount(
        em,
        companyId,
        ACCT_GOODS_IN_TRANSIT,
      );
      const lines = [];
      if (cogsCost.abs().greaterThan(MONEY_TOLERANCE)) {
        const cogs = await this.accounts.getByNumberOrFail(companyId, ACCT_COGS, em);
        lines.push({
          accountId: cogs.id,
          description: 'Cost of goods delivered',
          debit: cogsCost.toFixed(4),
          credit: '0',
          lineOrder: lines.length,
        });
      }
      if (restockCost.abs().greaterThan(MONEY_TOLERANCE)) {
        const inventory = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, em);
        lines.push({
          accountId: inventory.id,
          description: 'Undelivered/returned goods restocked',
          debit: restockCost.toFixed(4),
          credit: '0',
          lineOrder: lines.length,
        });
      }
      lines.push({
        accountId: git.id,
        description: 'Goods in Transit relieved',
        debit: '0',
        credit: totalGitRelief.toFixed(4),
        lineOrder: lines.length,
      });
      const entry = await this.posting.createEntry(em, {
        companyId,
        date: this.today(),
        memo: `Delivery ${delivery.referenceNo ?? delivery.id} approved — ${paidStatus.toUpperCase()}`,
        createdBy: userId,
        status: 'posted',
        sourceType: 'delivery_approval',
        sourceId: delivery.id,
        lines,
      });
      cogsJournalEntryId = entry.id;
    }

    delivery.invoiceId = invoiceId;
    delivery.paidStatus = paidStatus;
    delivery.ledgerStatus = 'committed';
    await deliveryRepo.save(delivery);

    return {
      invoiceId,
      invoiceNumber,
      invoiceTotal,
      paymentId,
      cogsJournalEntryId,
      cogsAmount: cogsCost.toFixed(4),
      restockedCost: restockCost.toFixed(4),
      paidStatus,
      creditMemoId,
      creditMemoNumber,
      creditMemoTotal,
    };
  }

  /**
   * Reject / return path: reverse Stage 1 exactly — Dr Inventory / Cr Goods in
   * Transit at the frozen cost, restock everything. Idempotent via
   * ledgerStatus.
   *
   * For a POSTPAID delivery no revenue is touched, because none was ever
   * recognised — the sales order is simply cancelled.
   *
   * For a PREPAID delivery the sale WAS posted at dispatch (invoice + payment,
   * see commitStockOnAssign), so reversing only the stock left Sales, output
   * tax and Cash overstated forever with the goods back on the shelf. A credit
   * memo reverses it, mirroring what the partial-return path at approval
   * already does — an auditable document rather than a silent reversal, and it
   * handles the tax leg for free.
   */
  async releaseOnReject(
    em: EntityManager,
    companyId: string,
    userId: string,
    deliveryId: string,
  ): Promise<{
    reversed: boolean;
    journalEntryId: string | null;
    restockedCost: string;
    creditMemoId: string | null;
    creditMemoNumber: string | null;
  }> {
    const deliveryRepo = em.getRepository(Delivery);
    const itemRepo = em.getRepository(DeliveryItem);

    const delivery = await deliveryRepo
      .createQueryBuilder('d')
      .setLock('pessimistic_write')
      .where('d.id = :id AND d.companyId = :cid', { id: deliveryId, cid: companyId })
      .getOne();
    if (!delivery) throw new NotFoundException('Delivery not found');
    if (delivery.ledgerStatus !== 'in_transit') {
      // Never dispatched under the ledger flow, or already resolved — no-op.
      return {
        reversed: false,
        journalEntryId: null,
        restockedCost: '0.0000',
        creditMemoId: null,
        creditMemoNumber: null,
      };
    }

    const items = await itemRepo.find({ where: { deliveryId: delivery.id } });
    const invRepo = em.getRepository(InventoryItem);
    const moveRepo = em.getRepository(InventoryMovement);
    let totalCost = new Decimal(0);

    for (const line of items) {
      const qty = this.lineQty(line);
      if (!qty.greaterThan(0)) continue;
      const item = await invRepo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i.companyId = :cid', { id: line.itemId, cid: companyId })
        .getOne();
      // Refuse rather than skip. Accumulating the cost first and then
      // continuing past a missing item debits Inventory 1200 for stock that is
      // never restored — the subledger and the control account part company
      // permanently (I13). commitStockOnAssign already throws here; this path
      // must too.
      if (!item) {
        throw new NotFoundException({
          code: 'ITEM_NOT_FOUND',
          message: `Inventory item ${line.itemId} no longer exists, so this delivery cannot be returned to stock.`,
        });
      }
      totalCost = totalCost.plus(qty.times(toDecimal(line.unitCost)));
      const newQty = this.absorbReturnIntoAverage(item, qty, toDecimal(line.unitCost));
      await invRepo.save(item);
      await moveRepo.save(
        moveRepo.create({
          companyId,
          itemId: item.id,
          date: this.today(),
          type: 'return',
          quantityChange: qty.toFixed(4),
          balanceAfter: newQty.toFixed(4),
          reference: delivery.referenceNo ?? delivery.id,
          sourceType: 'delivery_return',
          sourceId: delivery.id,
          createdBy: userId,
          description: `delivery rejected — stock restored: ${delivery.referenceNo ?? delivery.id}`,
        }),
      );
    }

    let journalEntryId: string | null = null;
    if (totalCost.abs().greaterThan(MONEY_TOLERANCE)) {
      const git = await this.accounts.getOrCreateSystemAccount(
        em,
        companyId,
        ACCT_GOODS_IN_TRANSIT,
      );
      const inventory = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, em);
      const value = totalCost.toFixed(4);
      const entry = await this.posting.createEntry(em, {
        companyId,
        date: this.today(),
        memo: `Delivery ${delivery.referenceNo ?? delivery.id} rejected — goods returned to stock`,
        createdBy: userId,
        status: 'posted',
        sourceType: 'delivery_return',
        sourceId: delivery.id,
        reversalOfId: delivery.gitJournalEntryId ?? null,
        lines: [
          { accountId: inventory.id, description: 'Stock restored from Goods in Transit', debit: value, credit: '0', lineOrder: 0 },
          { accountId: git.id, description: 'Goods in Transit reversed', debit: '0', credit: value, lineOrder: 1 },
        ],
      });
      journalEntryId = entry.id;
    }

    // A prepaid delivery was invoiced AND paid at dispatch. Reverse the sale;
    // the stock has already gone back above.
    let creditMemoId: string | null = null;
    let creditMemoNumber: string | null = null;
    if (delivery.prepaid && delivery.invoiceId) {
      const saleLines = items
        .filter((line) => this.lineQty(line).greaterThan(0))
        .map((line) => ({
          description: line.itemName ?? line.itemId,
          quantity: this.lineQty(line).toFixed(4),
          unitPrice: toDecimal(line.unitPrice).toFixed(4),
          taxRate: toDecimal(line.taxRate ?? '0').toFixed(4),
          // Deliberately no itemId: the units were restocked by the loop above,
          // and letting the memo restock them again would double the stock and
          // drift the subledger away from account 1200 (I13).
        }));

      const saleValue = saleLines.reduce(
        (sum, l) => sum.plus(toDecimal(l.quantity).times(toDecimal(l.unitPrice))),
        new Decimal(0),
      );

      // Guarded on VALUE for the same reason as the approval path: a memo
      // totalling zero would produce a journal line with neither a debit nor a
      // credit, PostingService would reject it, and the whole rejection would
      // roll back — leaving the admin unable to reject the delivery at all.
      if (saleValue.greaterThan(MONEY_TOLERANCE)) {
        const creditMemo = await this.creditMemos.createInTransaction(em, companyId, userId, {
          customerId: delivery.customerId,
          date: this.today(),
          originalInvoiceId: delivery.invoiceId ?? undefined,
          reason: `Prepaid delivery ${delivery.referenceNo ?? delivery.id} rejected — sale reversed`,
          lines: saleLines,
        });
        creditMemoId = creditMemo.id;
        creditMemoNumber = creditMemo.creditMemoNumber;
      }
    }

    // Cancel the (never-invoiced) sales order.
    if (delivery.salesOrderId) {
      const soRepo = em.getRepository(SalesOrder);
      const so = await soRepo.findOne({ where: { id: delivery.salesOrderId, companyId } });
      if (so && so.status !== 'invoiced' && so.status !== 'cancelled') {
        so.status = 'cancelled';
        await soRepo.save(so);
      }
    }

    delivery.ledgerStatus = 'returned';
    await deliveryRepo.save(delivery);

    return {
      reversed: true,
      journalEntryId,
      restockedCost: totalCost.toFixed(4),
      creditMemoId,
      creditMemoNumber,
    };
  }
}
