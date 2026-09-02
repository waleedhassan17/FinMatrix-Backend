import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { CreditMemo, CreditMemoStatus } from './entities/credit-memo.entity';
import { CreditMemoLine } from './entities/credit-memo-line.entity';
import { Customer } from '../customers/entities/customer.entity';
// Entity only, deliberately: stamping the reversal link needs one UPDATE, and
// importing InventoryApprovalsService for it would couple these two modules.
import { InventoryUpdateRequest } from '../inventory-approvals/entities/inventory-update-request.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import {
  ApplyCreditMemoDto, CreateCreditMemoDto, CreditMemoLineDto, ListCreditMemosQueryDto,
} from './dto/credit-memo.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { addMoney, MONEY_TOLERANCE, toDecimal } from '../../common/utils/money.util';
import { assertSufficientStock } from '../../common/utils/stock.util';
import { formatYearlyRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { InvoicesService } from '../invoices/invoices.service';
import { Invoice } from '../invoices/entities/invoice.entity';
import { ACCT_AR, ACCT_CASH, ACCT_COGS, ACCT_INVENTORY, ACCT_SALES_REVENUE, ACCT_TAX_PAYABLE } from '../accounts/accounts.constants';

@Injectable()
export class CreditMemosService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly invoices: InvoicesService,
    @InjectRepository(CreditMemo) private readonly repo: Repository<CreditMemo>,
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
  ) {}

  async list(companyId: string, query: ListCreditMemosQueryDto, pagination: PaginationParams) {
    const qb = this.repo.createQueryBuilder('c').where('c.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('c.status = :s', { s: query.status });
    if (query.customerId) qb.andWhere('c.customerId = :cust', { cust: query.customerId });
    if (query.search) qb.andWhere('c.creditMemoNumber ILIKE :q', { q: `%${query.search}%` });
    qb.orderBy('c.date', 'DESC').addOrderBy('c.createdAt', 'DESC').take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();
    const ids = [...new Set(data.map((c) => c.customerId))];
    const customers = ids.length ? await this.customerRepo.findByIds(ids) : [];
    const nameMap = Object.fromEntries(customers.map((c) => [c.id, c.name]));
    return {
      data: data.map((c) => ({ ...c, customerName: nameMap[c.customerId] ?? '' })),
      pagination: { page: pagination.page, limit: pagination.limit, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) },
    };
  }

  async getById(companyId: string, id: string): Promise<CreditMemo> {
    const cm = await this.repo.findOne({ where: { id, companyId }, relations: { lines: true } });
    if (!cm) throw new NotFoundException({ code: 'CREDIT_MEMO_NOT_FOUND', message: 'Credit memo not found' });
    cm.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return cm;
  }

  async create(companyId: string, userId: string, dto: CreateCreditMemoDto): Promise<CreditMemo> {
    return this.dataSource.transaction(async (manager) =>
      this.createInTransaction(manager, companyId, userId, dto),
    );
  }

  /**
   * Create the memo and settle it against the invoice it reverses, as one act.
   *
   * Reversing a delivery is one intention, not two. Creating the memo posts
   * the reversal (Dr Sales + Dr Tax / Cr A/R, Dr Inventory / Cr COGS), but on
   * its own it leaves the original invoice still showing a balance with a
   * floating credit beside it — so the customer's statement reads as though
   * they owe money they do not. Applying is what closes that.
   *
   * Applies only what the invoice can absorb. A prepaid or already-collected
   * delivery has an invoice balance of zero, so there is nothing to settle:
   * the credit stays available (and can be refunded, which is its own gated
   * action). Applying blindly would trip the EXCEEDS_CREDIT guard and fail the
   * whole reversal for a perfectly ordinary case.
   *
   * BOTH roles run this same method — the owner directly, staff via an
   * approved request — which is what makes their accounting identical.
   */
  /**
   * Create the memo, settle it, and record what it reversed — as one act.
   *
   * Reversing a delivery is one intention, not three. Creating the memo posts
   * the reversal (Dr Sales + Dr Output Tax / Cr A/R, Dr Inventory / Cr COGS at
   * cost), but on its own it leaves loose ends that each look like a mistake
   * to whoever reads the books next:
   *
   *   • a CREDIT SALE keeps its invoice showing a balance beside a floating
   *     credit, so the customer appears to owe money they do not — hence the
   *     apply;
   *   • a PREPAID sale has no receivable to clear, so the credit leaves A/R
   *     NEGATIVE (a credit balance inside an asset account, on the aging
   *     report) until somebody separately raises and approves a refund —
   *     hence refundRemainderToCash, which nets the whole reversal to
   *     Dr Sales / Cr Cash;
   *   • nothing linked the memo to the delivery, so a second reversal was one
   *     tap away — hence the stamp.
   *
   * BOTH roles run this same method — the owner directly, staff through an
   * approved request — which is what makes their accounting identical rather
   * than merely similar.
   */
  async createAndApply(
    companyId: string,
    userId: string,
    dto: CreateCreditMemoDto & {
      applyToInvoiceId?: string;
      refundRemainderToCash?: boolean;
      reversesDeliveryRequestId?: string;
    },
  ): Promise<CreditMemo> {
    const {
      applyToInvoiceId,
      refundRemainderToCash,
      reversesDeliveryRequestId,
      ...createDto
    } = dto;

    let memo = await this.create(companyId, userId, createDto);

    if (applyToInvoiceId) {
      const invoice = await this.dataSource
        .getRepository(Invoice)
        .findOne({ where: { id: applyToInvoiceId, companyId } });
      if (!invoice) {
        throw new NotFoundException({
          code: 'INVOICE_NOT_FOUND',
          message: 'The invoice this credit should settle no longer exists.',
        });
      }

      const applicable = Decimal.min(
        toDecimal(memo.balance),
        toDecimal(invoice.balance),
      );
      if (applicable.greaterThan(0)) {
        memo = await this.applyToInvoice(companyId, memo.id, {
          invoiceId: applyToInvoiceId,
          amount: applicable.toFixed(4),
        });
        await this.settleRoundingResidue(companyId, applyToInvoiceId);
      }
    }

    // Whatever the invoice could not absorb goes back as cash, so a prepaid
    // reversal is one approval and never parks a negative receivable.
    if (refundRemainderToCash && toDecimal(memo.balance).greaterThan(0)) {
      memo = await this.refund(companyId, memo.id, userId);
    }

    if (reversesDeliveryRequestId) {
      await this.dataSource
        .getRepository(InventoryUpdateRequest)
        .update(
          { id: reversesDeliveryRequestId, companyId },
          { reversalCreditMemoId: memo.id },
        );
    }

    return memo;
  }

  /**
   * A credit built from the same lines as the invoice it reverses should land
   * exactly on its balance — but "should" is not a guarantee once a tax rate
   * and four decimal places are involved, and rounding the other way leaves a
   * fraction of a paisa behind. That residue keeps the invoice `partial`, so
   * it sits on the A/R aging as an open invoice forever over a rounding error.
   *
   * Settle anything within the tolerance the posting engine already uses,
   * exactly as commitApproval does for a prepaid delivery. Larger balances are
   * left alone: those are real money, not rounding.
   */
  private async settleRoundingResidue(
    companyId: string,
    invoiceId: string,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(Invoice);
    const invoice = await repo.findOne({ where: { id: invoiceId, companyId } });
    if (!invoice) return;

    const balance = toDecimal(invoice.balance);
    if (balance.isZero() || balance.greaterThan(MONEY_TOLERANCE)) return;

    invoice.amountPaid = invoice.total;
    invoice.balance = '0.0000';
    invoice.status = 'paid';
    await repo.save(invoice);
  }

  /**
   * Same as create(), but joins a transaction the caller already owns. Mirrors
   * InvoicesService.createInTransaction. Used by the delivery approval flow,
   * which has to credit a prepaid customer for undelivered goods inside the
   * same transaction that relieves Goods in Transit.
   *
   * Lines WITHOUT an itemId skip the inventory return entirely, so a caller
   * that has already restocked the goods itself can credit revenue and tax
   * without putting the same units back on the shelf twice.
   */
  async createInTransaction(
    manager: EntityManager,
    companyId: string,
    userId: string,
    dto: CreateCreditMemoDto,
  ): Promise<CreditMemo> {
    {
      const customer = await manager.findOne(Customer, { where: { id: dto.customerId, companyId } });
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });

      const totals = this.computeTotals(dto.lines);
      const year = parseInt(dto.date.slice(0, 4), 10);
      const seq = await nextYearlySequence(manager, 'credit_memos', companyId, year, 'date', 'CM', 'credit_memo_number');
      const number = formatYearlyRef('CM', year, seq);

      const cm = manager.create(CreditMemo, {
        companyId, customerId: dto.customerId, creditMemoNumber: number, date: dto.date,
        originalInvoiceId: dto.originalInvoiceId ?? null, reason: dto.reason ?? null,
        subtotal: totals.subtotal, taxAmount: totals.taxAmount, total: totals.total,
        amountApplied: '0', balance: totals.total, status: 'open' as CreditMemoStatus,
        journalEntryId: null, createdBy: userId,
      });
      await manager.save(cm);
      cm.lines = totals.lines.map((l) => manager.create(CreditMemoLine, { creditMemoId: cm.id, ...l }));
      await manager.save(cm.lines);

      // JE: DR Sales Revenue + DR Tax Payable, CR Accounts Receivable.
      const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
      const rev = await this.accounts.getByNumberOrFail(companyId, ACCT_SALES_REVENUE, manager);
      const lines = [
        { accountId: rev.id, description: 'Sales returns / credit', debit: totals.subtotal, credit: '0', lineOrder: 0 },
      ];
      if (toDecimal(totals.taxAmount).greaterThan(0)) {
        const tax = await this.accounts.getByNumberOrFail(companyId, ACCT_TAX_PAYABLE, manager);
        lines.push({ accountId: tax.id, description: 'Tax adjustment', debit: totals.taxAmount, credit: '0', lineOrder: 1 });
      }
      lines.push({ accountId: ar.id, description: `Credit memo ${number}`, debit: '0', credit: totals.total, lineOrder: lines.length });

      // Inventory return side (FinMatrix.md §11): restock item lines and reverse
      // the cost out of COGS — Dr Inventory / Cr COGS at qty × item cost.
      const returnCost = await this.postCreditMemoInventory(manager, cm, userId, false);
      if (returnCost.greaterThan(0)) {
        const inventory = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, manager);
        const cogs = await this.accounts.getByNumberOrFail(companyId, ACCT_COGS, manager);
        lines.push({ accountId: inventory.id, description: 'Inventory returned to stock', debit: returnCost.toFixed(4), credit: '0', lineOrder: lines.length });
        lines.push({ accountId: cogs.id, description: 'COGS reversed on return', debit: '0', credit: returnCost.toFixed(4), lineOrder: lines.length });
      }

      const entry = await this.posting.createEntry(manager, {
        companyId, createdBy: userId, date: dto.date, memo: `Credit memo ${number}`,
        status: 'posted', lines, sourceType: 'credit_memo', sourceId: cm.id,
      });
      cm.journalEntryId = entry.id;
      await manager.save(cm);

      // A credit memo reduces what the customer owes.
      customer.balance = addMoney(customer.balance, toDecimal(totals.total).negated().toFixed(4)).toFixed(4);
      await manager.save(customer);
      return cm;
    }
  }

  async applyToInvoice(companyId: string, id: string, dto: ApplyCreditMemoDto): Promise<CreditMemo> {
    return this.dataSource.transaction(async (manager) => {
      // Lock the credit itself, not just the invoice. Without this two
      // concurrent applies of the same credit both read the same balance,
      // both pass the EXCEEDS_CREDIT check, and the second amountApplied
      // write wins — spending the credit twice (M1).
      const cm = await manager.findOne(CreditMemo, {
        where: { id, companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cm) throw new NotFoundException({ code: 'CREDIT_MEMO_NOT_FOUND', message: 'Credit memo not found' });
      if (cm.status === 'void' || cm.status === 'refunded' || cm.status === 'closed') {
        throw new BadRequestException({ code: 'CREDIT_UNAVAILABLE', message: `Credit memo is ${cm.status}` });
      }
      const amt = toDecimal(dto.amount);
      if (amt.greaterThan(toDecimal(cm.balance))) {
        throw new BadRequestException({ code: 'EXCEEDS_CREDIT', message: 'Amount exceeds available credit balance' });
      }
      // A customer's credit can only settle that customer's invoice.
      const target = await manager.findOne(Invoice, { where: { id: dto.invoiceId, companyId } });
      if (!target) {
        throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
      }
      if (target.customerId !== cm.customerId) {
        throw new BadRequestException({
          code: 'CUSTOMER_MISMATCH',
          message: 'That invoice belongs to a different customer.',
        });
      }
      await this.invoices.applyPayment(manager, companyId, dto.invoiceId, dto.amount);
      cm.amountApplied = addMoney(cm.amountApplied, amt).toFixed(4);
      cm.balance = toDecimal(cm.total).minus(toDecimal(cm.amountApplied)).toFixed(4);
      cm.status = toDecimal(cm.balance).lessThanOrEqualTo(0) ? 'closed' : 'applied';
      await manager.save(cm);
      return cm;
    });
  }

  async refund(companyId: string, id: string, userId: string): Promise<CreditMemo> {
    return this.dataSource.transaction(async (manager) => {
      const cm = await manager.findOne(CreditMemo, { where: { id, companyId } });
      if (!cm) throw new NotFoundException({ code: 'CREDIT_MEMO_NOT_FOUND', message: 'Credit memo not found' });
      const remaining = toDecimal(cm.balance);
      if (remaining.lessThanOrEqualTo(0)) {
        throw new BadRequestException({ code: 'NO_BALANCE', message: 'No remaining balance to refund' });
      }
      const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
      const cash = await this.accounts.getByNumberOrFail(companyId, ACCT_CASH, manager);
      await this.posting.createEntry(manager, {
        companyId, createdBy: userId, date: new Date().toISOString().slice(0, 10),
        memo: `Refund credit memo ${cm.creditMemoNumber}`, status: 'posted',
        lines: [
          { accountId: ar.id, debit: remaining.toFixed(4), credit: '0', lineOrder: 0 },
          { accountId: cash.id, debit: '0', credit: remaining.toFixed(4), lineOrder: 1 },
        ],
        sourceType: 'credit_memo_refund', sourceId: cm.id,
      });
      const customer = await manager.findOne(Customer, { where: { id: cm.customerId, companyId } });
      if (customer) { customer.balance = addMoney(customer.balance, remaining.toFixed(4)).toFixed(4); await manager.save(customer); }
      cm.balance = '0';
      cm.status = 'refunded';
      await manager.save(cm);
      return cm;
    });
  }

  async void(companyId: string, id: string, userId: string): Promise<CreditMemo> {
    return this.dataSource.transaction(async (manager) => {
      const cm = await manager.findOne(CreditMemo, { where: { id, companyId }, relations: { lines: true } });
      if (!cm) throw new NotFoundException({ code: 'CREDIT_MEMO_NOT_FOUND', message: 'Credit memo not found' });
      if (cm.status === 'void') {
        throw new BadRequestException({ code: 'ALREADY_VOID', message: 'Credit memo is already void' });
      }
      // refund() zeroes the balance but leaves amountApplied at 0, so without
      // this the ALREADY_APPLIED guard lets a refunded memo be voided too —
      // the cash has gone out AND the memo gets reversed.
      if (cm.status === 'refunded') {
        throw new BadRequestException({
          code: 'ALREADY_REFUNDED',
          message: 'Cannot void a credit memo that has been refunded.',
        });
      }
      if (toDecimal(cm.amountApplied).greaterThan(0)) {
        throw new BadRequestException({ code: 'ALREADY_APPLIED', message: 'Cannot void a credit memo that has been applied' });
      }
      if (cm.journalEntryId) {
        const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
        const rev = await this.accounts.getByNumberOrFail(companyId, ACCT_SALES_REVENUE, manager);
        const lines = [
          { accountId: ar.id, debit: cm.total, credit: '0', lineOrder: 0 },
          { accountId: rev.id, debit: '0', credit: cm.subtotal, lineOrder: 1 },
        ];
        if (toDecimal(cm.taxAmount).greaterThan(0)) {
          const tax = await this.accounts.getByNumberOrFail(companyId, ACCT_TAX_PAYABLE, manager);
          lines.push({ accountId: tax.id, debit: '0', credit: cm.taxAmount, lineOrder: 2 });
        }
        // Reverse the inventory return: pull the restocked goods back out —
        // qty↓, Dr COGS / Cr Inventory (undo the Dr Inventory / Cr COGS on issue).
        const returnCost = await this.postCreditMemoInventory(manager, cm, userId, true);
        if (returnCost.greaterThan(0)) {
          const cogs = await this.accounts.getByNumberOrFail(companyId, ACCT_COGS, manager);
          const inventory = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, manager);
          lines.push({ accountId: cogs.id, debit: returnCost.toFixed(4), credit: '0', lineOrder: lines.length });
          lines.push({ accountId: inventory.id, debit: '0', credit: returnCost.toFixed(4), lineOrder: lines.length });
        }
        await this.posting.createEntry(manager, {
          companyId, createdBy: userId, date: new Date().toISOString().slice(0, 10),
          memo: `Void credit memo ${cm.creditMemoNumber}`, status: 'posted', lines,
          reversalOfId: cm.journalEntryId, sourceType: 'credit_memo_void', sourceId: cm.id,
        });
      }
      const customer = await manager.findOne(Customer, { where: { id: cm.customerId, companyId } });
      if (customer) { customer.balance = addMoney(customer.balance, cm.total).toFixed(4); await manager.save(customer); }
      cm.status = 'void';
      cm.balance = '0';
      await manager.save(cm);
      return cm;
    });
  }

  async delete(companyId: string, id: string, userId: string) {
    const cm = await this.getById(companyId, id);
    if (cm.status !== 'open') {
      throw new BadRequestException({ code: 'CANNOT_DELETE', message: 'Only open, unapplied credit memos can be deleted' });
    }
    // Reverse the ledger (via void) attributed to the acting user — never an
    // empty createdBy, which would fail the reversal JE's uuid column.
    if (cm.journalEntryId) { await this.void(companyId, id, userId); }
    await this.repo.remove(cm);
    return { id, deleted: true };
  }

  /**
   * Apply (or reverse) the inventory side of a credit memo: a customer return
   * brings item-linked goods back in — quantity↑ and the cost is credited out
   * of COGS. Records movements and returns the total cost value moved (used to
   * build the Inventory/COGS journal lines). Mirrors invoice COGS, inverted.
   *
   * @param reverse false on issue (return: qty↑, COGS reversed); true on void
   *                (undo the return: qty↓, COGS re-recognised).
   */
  private async postCreditMemoInventory(
    manager: EntityManager,
    cm: CreditMemo,
    userId: string,
    reverse: boolean,
  ): Promise<Decimal> {
    const itemRepo = manager.getRepository(InventoryItem);
    const moveRepo = manager.getRepository(InventoryMovement);
    let total = new Decimal(0);
    for (const line of cm.lines ?? []) {
      if (!line.itemId) continue;
      const item = await itemRepo.findOne({ where: { id: line.itemId, companyId: cm.companyId } });
      if (!item) continue;
      const qty = toDecimal(line.quantity);

      // Value the return at the cost FROZEN for this line. Re-reading
      // item.unitCost would use whatever the weighted-average has drifted to
      // since — a single purchase at a new price is enough — and the entry
      // would then not cancel what it is reversing, leaving residue in
      // Inventory and COGS.
      //
      // On ISSUE that frozen cost is either one the caller supplied (a
      // delivery reversal knows what the sale posted COGS at) or today's
      // average, which is the best basis available for an ordinary return
      // where the original cost is unknown. On a VOID it is whatever the issue
      // recorded, so the two cancel exactly.
      const unitCost = toDecimal(line.restockUnitCost ?? item.unitCost);
      const cost = qty.times(unitCost);
      if (cost.lessThanOrEqualTo(0)) continue;
      total = total.plus(cost);

      if (!reverse) {
        line.restockUnitCost = unitCost.toFixed(4);
        await manager.getRepository(CreditMemoLine).save(line);
      }

      const onHand = toDecimal(item.quantityOnHand);
      // Voiding a return pulls the restocked goods back out; if they have
      // since been sold on, refuse cleanly rather than tripping
      // chk_no_negative_stock as a raw 500 (I11).
      if (reverse) assertSufficientStock(item.name, onHand, qty);
      const newQty = reverse ? onHand.minus(qty) : onHand.plus(qty);

      // Fold the movement back into the weighted average, exactly as a
      // purchase receipt does. The journal entry above moves Inventory 1200 by
      // qty × the frozen cost, so unless the average absorbs those units at
      // that same cost, the valuation report (qty × unit_cost) drifts away
      // from the control account by qty × (current average − frozen cost).
      //   restock: (Q·A + q·f) / (Q + q)
      //   void:    (Q·A − q·f) / (Q − q)
      // Both move total value by exactly q·f, which is what keeps the
      // subledger tied to the GL.
      if (newQty.greaterThan(0)) {
        const currentValue = onHand.times(toDecimal(item.unitCost));
        const movedValue = qty.times(unitCost);
        const nextValue = reverse
          ? currentValue.minus(movedValue)
          : currentValue.plus(movedValue);
        item.unitCost = nextValue
          .dividedBy(newQty)
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
          .toFixed(4);
      } else if (reverse) {
        // The void took the last unit out. There is no quantity left to carry
        // an average, and leaving the old one standing means the NEXT receipt
        // re-averages against a cost that no longer values anything: the
        // valuation falls by qty × the stale average while the GL falls by
        // qty × the frozen cost, and the two never meet again (I13).
        // Zero stock at zero cost is the only self-consistent resting state —
        // 0 × anything is 0, and the next receipt sets the cost outright.
        item.unitCost = '0';
      }

      item.quantityOnHand = newQty.toFixed(4);
      await itemRepo.save(item);

      await moveRepo.save(
        moveRepo.create({
          companyId: cm.companyId,
          itemId: item.id,
          date: cm.date,
          type: reverse ? 'sale' : 'return',
          quantityChange: (reverse ? qty.negated() : qty).toFixed(4),
          balanceAfter: newQty.toFixed(4),
          reference: cm.creditMemoNumber,
          sourceType: reverse ? 'credit_memo_void' : 'credit_memo',
          sourceId: cm.id,
          createdBy: userId,
        }),
      );
    }
    return total;
  }

  private computeTotals(lines: CreditMemoLineDto[]) {
    const calc: any[] = [];
    let subtotal = new Decimal(0);
    let tax = new Decimal(0);
    lines.forEach((l, i) => {
      const base = toDecimal(l.quantity).times(toDecimal(l.unitPrice));
      const lineTax = base.times(toDecimal(l.taxRate ?? '0')).dividedBy(100);
      subtotal = subtotal.plus(base);
      tax = tax.plus(lineTax);
      calc.push({
        itemId: l.itemId ?? null,
        description: l.description, quantity: toDecimal(l.quantity).toFixed(4), unitPrice: toDecimal(l.unitPrice).toFixed(4),
        taxRate: toDecimal(l.taxRate ?? '0').toFixed(4), lineTotal: base.plus(lineTax).toFixed(4), lineOrder: i,
        // Seeded when the caller knows the original cost; postCreditMemoInventory
        // prefers it over today's average so a reversal cancels the sale exactly.
        restockUnitCost: l.unitCost ? toDecimal(l.unitCost).toFixed(4) : null,
      });
    });
    return { subtotal: subtotal.toFixed(4), taxAmount: tax.toFixed(4), total: subtotal.plus(tax).toFixed(4), lines: calc };
  }
}
