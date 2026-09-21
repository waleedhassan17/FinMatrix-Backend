import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { PurchaseOrder } from './entities/purchase-order.entity';
import { PurchaseOrderLine } from './entities/purchase-order-line.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import {
  CreateBillFromPoDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  PurchaseOrderLineDto,
  ReceivePurchaseOrderDto,
} from './dto/purchase-order.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { MONEY_TOLERANCE, toDecimal } from '../../common/utils/money.util';
import { assertSufficientStock } from '../../common/utils/stock.util';
import { recordInventoryMovement } from '../../common/utils/inventory-movement.util';
import { nextDocumentNumber, yearOf } from '../../common/utils/sequence.util';
import { applyTextSearch } from '../../common/utils/search-query.util';
import { BillsService, PoBillLineLink } from '../bills/bills.service';
import { Bill } from '../bills/entities/bill.entity';
import { PostingService, PostingLineInput } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { ACCT_COGS, ACCT_GRNI, ACCT_INVENTORY } from '../accounts/accounts.constants';
import { Account } from '../accounts/entities/account.entity';
import { Company } from '../companies/entities/company.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { PurchaseOrderStatus } from '../../types';
import { addDaysIso, businessToday, termsDays } from '../../common/utils/business-date.util';

const round4 = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

/** Options for creating a PO outside a normal request. */
export interface CreatePurchaseOrderOptions {
  /**
   * A staff PO request filed before lines had to name an item or an expense
   * account. Approving it must still work; its free-text lines are asked for
   * an account when they are billed instead.
   */
  allowUnclassifiedLines?: boolean;
}

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly bills: BillsService,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    @InjectRepository(PurchaseOrder)
    private readonly repo: Repository<PurchaseOrder>,
  ) {}

  async list(
    companyId: string,
    query: ListPurchaseOrdersQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('o')
      // Lines are what the list's received-vs-ordered progress is computed
      // from; without them every row reads 0 / 0.
      .leftJoinAndSelect('o.lines', 'lines')
      .where('o.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('o.status = :s', { s: query.status });
    if (query.vendorId) qb.andWhere('o.vendorId = :v', { v: query.vendorId });
    applyTextSearch(qb, query.search, companyId, {
      columns: ['o.poNumber', 'o.notes'],
      vendorColumn: 'o.vendorId',
    });
    qb.orderBy('o.orderDate', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);
    const [data, total] = await qb.getManyAndCount();

    const vendorIds = [...new Set(data.map((o) => o.vendorId).filter(Boolean))];
    const vendorList = vendorIds.length
      ? await this.dataSource.getRepository(Vendor).findByIds(vendorIds)
      : [];
    const vendorNameMap = Object.fromEntries(vendorList.map((v) => [v.id, v.companyName]));

    return {
      data: data.map((o) => ({
        ...o,
        ...this.valueSummary(o.lines ?? []),
        vendorName: vendorNameMap[o.vendorId] ?? '',
      })),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string, manager?: EntityManager) {
    const runner = manager ?? this.dataSource.manager;
    const po = await runner.findOne(PurchaseOrder, {
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!po) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found' });
    }
    po.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    // Every bill raised from this PO, newest last. billId / billNumber stay as
    // the latest one for clients that only know about a single bill.
    const bills = await runner.find(Bill, {
      where: { companyId, purchaseOrderId: po.id },
      order: { createdAt: 'ASC' },
    });
    const latest = bills[bills.length - 1];
    return Object.assign(po, {
      ...this.valueSummary(po.lines),
      bills: bills.map((b) => ({
        id: b.id,
        billNumber: b.billNumber,
        billDate: b.billDate,
        total: b.total,
        balance: b.balance,
        status: b.status,
      })),
      billId: latest?.id ?? null,
      billNumber: latest?.billNumber ?? null,
    });
  }

  /**
   * Tax-inclusive values, so they compare with the order total (which has
   * always included tax). The web card used to set received quantity × cost
   * EXCLUDING tax against that total, so a fully received PO read
   * "Rs 40,800 of Rs 47,736 received".
   */
  private valueSummary(lines: PurchaseOrderLine[]) {
    let received = new Decimal(0);
    let billed = new Decimal(0);
    for (const l of lines) {
      const gross = (qty: string) => {
        const base = round4(toDecimal(qty).times(toDecimal(l.unitCost)));
        return base.plus(round4(base.times(toDecimal(l.taxRate)).dividedBy(100)));
      };
      received = received.plus(gross(l.receivedQty));
      billed = billed.plus(gross(l.billedQty ?? '0'));
    }
    return {
      receivedValueGross: received.toFixed(4),
      billedValueGross: billed.toFixed(4),
      unbilledValueGross: Decimal.max(received.minus(billed), 0).toFixed(4),
    };
  }

  async create(
    companyId: string,
    dto: CreatePurchaseOrderDto,
    opts: CreatePurchaseOrderOptions = {},
  ): Promise<PurchaseOrder> {
    return this.dataSource.transaction(async (manager) => {
      const vendor = await manager.findOne(Vendor, { where: { id: dto.vendorId, companyId } });
      if (!vendor) {
        throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found' });
      }
      await this.assertLinesClassified(manager, companyId, dto.lines, opts);
      const { subtotal, tax, calc } = this.computeLines(dto.lines);

      const poNumber = await nextDocumentNumber(manager, companyId, 'PO', yearOf(dto.orderDate));
      const po = manager.create(PurchaseOrder, {
        companyId,
        vendorId: dto.vendorId,
        poNumber,
        orderDate: dto.orderDate,
        expectedDate: dto.expectedDate ?? null,
        subtotal: subtotal.toFixed(4),
        taxAmount: tax.toFixed(4),
        total: subtotal.plus(tax).toFixed(4),
        status: 'draft',
        notes: dto.notes ?? null,
      });
      await manager.save(po);
      const lines = calc.map((l) =>
        manager.create(PurchaseOrderLine, { orderId: po.id, ...l }),
      );
      await manager.save(lines);
      po.lines = lines;
      return po;
    });
  }

  /** Check a PO's lines without creating anything (a staff request is filed only if they pass). */
  async assertLinesValid(companyId: string, lines: PurchaseOrderLineDto[]): Promise<void> {
    await this.assertLinesClassified(this.dataSource.manager, companyId, lines, {});
  }

  private computeLines(lines: PurchaseOrderLineDto[]) {
    let subtotal = new Decimal(0);
    let tax = new Decimal(0);
    const calc = lines.map((l, i) => {
      const qty = toDecimal(l.orderedQty);
      const cost = toDecimal(l.unitCost);
      const rate = toDecimal(l.taxRate ?? '0');
      const base = qty.times(cost);
      const t = base.times(rate).dividedBy(100);
      subtotal = subtotal.plus(base);
      tax = tax.plus(t);
      return {
        description: l.description,
        orderedQty: qty.toFixed(4),
        receivedQty: '0',
        billedQty: '0',
        grniAccrued: '0',
        grniCleared: '0',
        unitCost: cost.toFixed(4),
        taxRate: rate.toFixed(4),
        lineTotal: base.plus(t).toFixed(4),
        itemId: l.itemId ?? null,
        accountId: l.accountId ?? null,
        lineOrder: i,
      };
    });
    return { subtotal, tax, calc };
  }

  /**
   * Every purchase line is either STOCK (an inventory item: receiving it adds
   * to the shelf and accrues GRNI) or an EXPENSE (no stock: it bills to the
   * expense account it names).
   *
   * Free-text lines with neither used to be allowed. They never touched
   * inventory when received — QA's "inventory didn't update" — and when billed
   * silently fell back to Cost of Goods Sold.
   */
  private async assertLinesClassified(
    manager: EntityManager,
    companyId: string,
    lines: PurchaseOrderLineDto[],
    opts: CreatePurchaseOrderOptions,
  ): Promise<void> {
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((id): id is string => !!id))];
    if (itemIds.length) {
      const found = await manager.find(InventoryItem, {
        where: { id: In(itemIds), companyId },
        select: ['id'],
      });
      if (found.length !== itemIds.length) {
        throw new BadRequestException({
          code: 'ITEM_NOT_FOUND',
          message: 'One or more lines reference an inventory item that does not exist',
        });
      }
    }
    const accountIds = [...new Set(lines.map((l) => l.accountId).filter((id): id is string => !!id))];
    if (accountIds.length) {
      const found = await manager.find(Account, { where: { id: In(accountIds), companyId } });
      if (found.length !== accountIds.length) {
        throw new BadRequestException({
          code: 'ACCOUNT_NOT_FOUND',
          message: "A line's expense account does not exist in this company's chart of accounts",
        });
      }
      const inactive = found.find((a) => !a.isActive);
      if (inactive) {
        throw new BadRequestException({
          code: 'ACCOUNT_INACTIVE',
          message: `Account ${inactive.accountNumber} — ${inactive.name} is inactive`,
        });
      }
    }
    for (const [i, l] of lines.entries()) {
      if (l.lineKind === 'item' && !l.itemId) {
        throw new BadRequestException({
          code: 'LINE_ITEM_REQUIRED',
          message: `Line ${i + 1} (${l.description || 'no description'}): pick the inventory item this line buys.`,
        });
      }
      if (!l.itemId && !l.accountId && !opts.allowUnclassifiedLines) {
        throw new BadRequestException({
          code: 'EXPENSE_ACCOUNT_REQUIRED',
          message:
            `Line ${i + 1} (${l.description || 'no description'}): pick an inventory item, ` +
            'or choose the expense account for a non-stock purchase.',
        });
      }
    }
  }

  private async lockPo(manager: EntityManager, companyId: string, id: string): Promise<PurchaseOrder> {
    const po = await manager
      .createQueryBuilder(PurchaseOrder, 'o')
      .setLock('pessimistic_write')
      .where('o.id = :id AND o.companyId = :companyId', { id, companyId })
      .getOne();
    if (!po) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found' });
    }
    po.lines = await manager.find(PurchaseOrderLine, {
      where: { orderId: po.id },
      order: { lineOrder: 'ASC' },
    });
    return po;
  }

  private assertIssued(po: PurchaseOrder, action: string): void {
    if (po.status === 'draft') {
      throw new BadRequestException({
        code: 'PO_NOT_ISSUED',
        message: `${po.poNumber} is still a purchase requisition. Approve and send it to the vendor before you ${action}.`,
      });
    }
    if (po.status === 'closed') {
      throw new BadRequestException({
        code: 'PO_CLOSED',
        message: `${po.poNumber} is closed.`,
      });
    }
  }

  /**
   * Receive goods — stock goes on the shelf NOW, whether or not the vendor has
   * billed or been paid. That is perpetual inventory: the goods are the
   * company's once they arrive, and what is owed for them sits in GRNI until
   * the vendor's bill turns it into Accounts Payable.
   *
   *   Dr 1200 Inventory / Cr 2050 GRNI   at landed cost
   *
   * Landed cost is the unit cost plus the purchase tax when that tax cannot be
   * reclaimed (the company is not sales-tax registered): IAS 2 counts
   * non-recoverable taxes as part of an item's cost. A registered company
   * reclaims it through 1300 on the bill, so its stock is valued net.
   */
  async receive(
    companyId: string,
    userId: string,
    id: string,
    dto: ReceivePurchaseOrderDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockPo(manager, companyId, id);
      this.assertIssued(po, 'receive goods');

      const company = await manager.findOne(Company, {
        where: { id: companyId },
        select: { id: true, salesTaxRegistered: true },
      });
      const netOfTax = !!company?.salesTaxRegistered;
      const today = businessToday();
      const itemRepo = manager.getRepository(InventoryItem);
      const moveRepo = manager.getRepository(InventoryMovement);
      const lineMap = new Map(po.lines.map((l) => [l.id, l]));

      // Net movement per account; one line per account in the entry.
      const net = new Map<string, Decimal>();
      const bump = (account: string, amount: Decimal) =>
        net.set(account, (net.get(account) ?? new Decimal(0)).plus(amount));

      for (const rl of dto.lines) {
        const line = lineMap.get(rl.lineId);
        if (!line) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Line ${rl.lineId} not on this PO`,
          });
        }
        const q = toDecimal(rl.receivedQty);
        if (q.lessThan(0)) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'Received quantity cannot be negative',
          });
        }
        if (q.greaterThan(toDecimal(line.orderedQty))) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Cannot receive more than ordered (${line.orderedQty})`,
          });
        }
        if (q.lessThan(toDecimal(line.billedQty))) {
          throw new BadRequestException({
            code: 'RECEIPT_BELOW_BILLED',
            message:
              `${line.description}: ${toDecimal(line.billedQty).toFixed(0)} have already been billed, ` +
              'so the received quantity cannot go below that. Delete the bill first.',
          });
        }
        // receivedQty is absolute; move stock only by the newly received delta
        // so repeated receive calls never double-count.
        const delta = q.minus(toDecimal(line.receivedQty));
        line.receivedQty = q.toFixed(4);
        if (delta.isZero() || !line.itemId) {
          await manager.save(line);
          continue;
        }

        const item = await itemRepo
          .createQueryBuilder('i')
          .setLock('pessimistic_write')
          .where('i.id = :id AND i.companyId = :companyId', { id: line.itemId, companyId })
          .getOne();
        if (!item) {
          throw new BadRequestException({
            code: 'ITEM_NOT_FOUND',
            message: `${line.description}: its inventory item no longer exists.`,
          });
        }

        const base = round4(delta.abs().times(toDecimal(line.unitCost)));
        const landed = netOfTax ? base : base.plus(round4(base.times(toDecimal(line.taxRate)).dividedBy(100)));
        const onHand = toDecimal(item.quantityOnHand);
        // The signed amount this receipt moves account 1200 by, captured in
        // whichever branch below computes it. Recorded on the stock movement so
        // the per-item value series can be summed back to the control account.
        let inventoryImpact: Decimal;

        if (delta.greaterThan(0)) {
          const newQty = onHand.plus(delta);
          // WEIGHTED-AVERAGE COST. Carry the current value even when on-hand is
          // negative, so the average stays tied to what the GL was debited
          // (invariant I13).
          if (newQty.greaterThan(0)) {
            const value = onHand.times(toDecimal(item.unitCost)).plus(landed);
            item.unitCost = value.dividedBy(newQty).toFixed(4);
          }
          item.quantityOnHand = newQty.toFixed(4);
          line.grniAccrued = toDecimal(line.grniAccrued).plus(landed).toFixed(4);
          bump(ACCT_INVENTORY, landed);
          bump(ACCT_GRNI, landed.negated());
          inventoryImpact = landed;
        } else {
          // A receipt correction: the goods go back out at the item's CURRENT
          // average cost (so the stock subledger keeps tying to 1200), and the
          // GRNI accrued for them is reversed at the rate it was accrued. Any
          // difference is cost of goods.
          const qtyOut = delta.negated();
          assertSufficientStock(item.name, onHand, qtyOut);
          const stockValue = round4(qtyOut.times(toDecimal(item.unitCost)));
          const accruedLeft = toDecimal(line.grniAccrued).minus(toDecimal(line.grniCleared));
          const grniReversal = Decimal.min(landed, Decimal.max(accruedLeft, 0));
          item.quantityOnHand = onHand.minus(qtyOut).toFixed(4);
          line.grniAccrued = toDecimal(line.grniAccrued).minus(grniReversal).toFixed(4);
          bump(ACCT_INVENTORY, stockValue.negated());
          bump(ACCT_GRNI, grniReversal);
          bump(ACCT_COGS, stockValue.minus(grniReversal));
          inventoryImpact = stockValue.negated();
        }
        await itemRepo.save(item);
        await manager.save(line);
        // THE site where the value is not qty x the item's average.
        //
        // A receipt adds `landed` to 1200 — the line's cost plus capitalised
        // tax when the company is not sales-tax registered — and only THEN
        // re-averages the pile, so `delta x item.unitCost` (post-average) and
        // `delta x line.unitCost` (pre-tax) are both different figures from the
        // one the ledger actually moved by. `inventoryImpact` IS the
        // `bump(ACCT_INVENTORY, …)` argument from the branch above, which is
        // the whole point: the movement and the journal entry cannot disagree
        // because they are the same value.
        await recordInventoryMovement(manager, {
          companyId,
          itemId: item.id,
          date: today,
          type: 'receipt',
          quantityChange: delta,
          balanceAfter: item.quantityOnHand,
          valueChange: inventoryImpact,
          reference: po.poNumber,
          sourceType: 'purchase_order',
          sourceId: po.id,
          createdBy: userId,
        });
      }

      const entryLines: PostingLineInput[] = [];
      const descriptions: Record<string, string> = {
        [ACCT_INVENTORY]: `Goods received — ${po.poNumber}`,
        [ACCT_GRNI]: `Received, not yet billed — ${po.poNumber}`,
        [ACCT_COGS]: `Receipt correction cost difference — ${po.poNumber}`,
      };
      for (const [accountNumber, amount] of net) {
        if (amount.abs().lessThan(MONEY_TOLERANCE)) continue;
        const account =
          accountNumber === ACCT_GRNI
            ? await this.accounts.getOrCreateSystemAccount(manager, companyId, ACCT_GRNI)
            : await this.accounts.getByNumberOrFail(companyId, accountNumber, manager);
        entryLines.push({
          accountId: account.id,
          description: descriptions[accountNumber],
          debit: amount.greaterThan(0) ? amount.toFixed(4) : '0',
          credit: amount.lessThan(0) ? amount.negated().toFixed(4) : '0',
          lineOrder: entryLines.length,
        });
      }
      if (entryLines.length >= 2) {
        await this.posting.createEntry(manager, {
          companyId,
          createdBy: userId,
          date: today,
          memo: `Goods received — PO ${po.poNumber}`,
          status: 'posted',
          lines: entryLines,
          sourceType: 'po_receipt',
          sourceId: po.id,
        });
      }

      po.status = this.deriveStatus(po.lines);
      await manager.save(po);
    });
    return this.getById(companyId, id);
  }

  /**
   * Bill what has been received and not yet billed — as many times as goods
   * arrive. A bill used to be allowed once per PO and billed only what had
   * arrived by then, so goods received afterwards could never be billed and
   * their GRNI stayed on the books forever.
   *
   * The bill carries each line's purchase tax, so Accounts Payable and the
   * bill payment include it. Stock lines clear exactly the GRNI their receipts
   * accrued (see BillsService.createJournalEntryForBill).
   */
  async createBill(
    companyId: string,
    userId: string,
    id: string,
    dto: CreateBillFromPoDto,
  ) {
    const billId = await this.dataSource.transaction(async (manager) => {
      const po = await this.lockPo(manager, companyId, id);
      this.assertIssued(po, 'bill it');

      const vendor = await manager.findOne(Vendor, { where: { id: po.vendorId, companyId } });
      const billDate = dto.billDate ?? businessToday();
      const dueDate = dto.dueDate ?? addDaysIso(billDate, termsDays(vendor?.paymentTerms));
      if (dueDate < billDate) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'The due date cannot be before the bill date.',
        });
      }

      const grni = await this.accounts.getOrCreateSystemAccount(manager, companyId, ACCT_GRNI);
      const billLines: Array<{ accountId: string; description: string; amount: string; taxRate: string }> = [];
      const links: PoBillLineLink[] = [];
      const updates: Array<{ line: PurchaseOrderLine; qty: Decimal; grni: Decimal | null }> = [];

      for (const line of po.lines) {
        const qty = toDecimal(line.receivedQty).minus(toDecimal(line.billedQty));
        if (!qty.greaterThan(0)) continue;
        const amount = round4(qty.times(toDecimal(line.unitCost)));
        if (line.itemId) {
          const grniAmount = toDecimal(line.grniAccrued).minus(toDecimal(line.grniCleared));
          billLines.push({ accountId: grni.id, description: line.description, amount: amount.toFixed(4), taxRate: line.taxRate });
          links.push({ purchaseOrderLineId: line.id, quantity: qty.toFixed(4), grniAmount: grniAmount.toFixed(4) });
          updates.push({ line, qty, grni: grniAmount });
        } else {
          const accountId = line.accountId ?? dto.defaultAccountId;
          if (!accountId) {
            throw new BadRequestException({
              code: 'EXPENSE_ACCOUNT_REQUIRED',
              message: `"${line.description}" is not a stock item. Choose the expense account it should be billed to.`,
              details: { lineId: line.id },
            });
          }
          billLines.push({ accountId, description: line.description, amount: amount.toFixed(4), taxRate: line.taxRate });
          links.push({ purchaseOrderLineId: line.id, quantity: qty.toFixed(4), grniAmount: null });
          updates.push({ line, qty, grni: null });
        }
      }
      if (billLines.length === 0) {
        throw new BadRequestException({
          code: 'NOTHING_TO_BILL',
          message: toDecimal(po.lines.reduce((s, l) => s.plus(toDecimal(l.receivedQty)), new Decimal(0))).isZero()
            ? `Nothing has been received on ${po.poNumber} yet.`
            : `Everything received on ${po.poNumber} has already been billed.`,
        });
      }

      const bill = await this.bills.createInTransaction(
        manager,
        companyId,
        userId,
        {
          vendorId: po.vendorId,
          purchaseOrderId: po.id,
          billNumber: dto.billNumber?.trim() || undefined,
          billDate,
          dueDate,
          memo: `Goods received on ${po.poNumber}`,
          status: 'open',
          lines: billLines,
        },
        { poLineLinks: links },
      );

      for (const u of updates) {
        u.line.billedQty = toDecimal(u.line.billedQty).plus(u.qty).toFixed(4);
        if (u.grni) u.line.grniCleared = toDecimal(u.line.grniCleared).plus(u.grni).toFixed(4);
        await manager.save(u.line);
      }
      po.status = this.deriveStatus(po.lines);
      await manager.save(po);
      return bill.id;
    });

    const [po, bill] = await Promise.all([
      this.getById(companyId, id),
      this.bills.getById(companyId, billId),
    ]);
    return { po, billId, bill };
  }

  async update(companyId: string, id: string, dto: CreatePurchaseOrderDto) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockPo(manager, companyId, id);
      if (po.status === 'closed' || po.lines.some((l) => toDecimal(l.receivedQty).greaterThan(0))) {
        // Rebuilding the lines used to reset received quantities to zero while
        // the stock and GRNI they had posted stayed put.
        throw new BadRequestException({
          code: 'PO_HAS_RECEIPTS',
          message: `${po.poNumber} already has goods received against it and can no longer be edited.`,
        });
      }
      if (dto.vendorId && dto.vendorId !== po.vendorId) {
        const vendor = await manager.findOne(Vendor, { where: { id: dto.vendorId, companyId } });
        if (!vendor) {
          throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found' });
        }
        po.vendorId = dto.vendorId;
      }
      if (dto.orderDate !== undefined) po.orderDate = dto.orderDate;
      if (dto.expectedDate !== undefined) po.expectedDate = dto.expectedDate;
      if (dto.notes !== undefined) po.notes = dto.notes;
      if (dto.lines) {
        await this.assertLinesClassified(manager, companyId, dto.lines, {});
        const { subtotal, tax, calc } = this.computeLines(dto.lines);
        po.subtotal = subtotal.toFixed(4);
        po.taxAmount = tax.toFixed(4);
        po.total = subtotal.plus(tax).toFixed(4);
        await manager.delete(PurchaseOrderLine, { orderId: po.id });
        const lines = calc.map((l) => manager.create(PurchaseOrderLine, { ...l, orderId: po.id }));
        await manager.save(lines);
        po.lines = lines;
      }
      await manager.save(po);
    });
    return this.getById(companyId, id);
  }

  async delete(companyId: string, id: string) {
    return this.dataSource.transaction(async (manager) => {
      const po = await this.lockPo(manager, companyId, id);
      const billed = await manager.count(Bill, { where: { companyId, purchaseOrderId: po.id } });
      if (billed > 0 || po.lines.some((l) => toDecimal(l.receivedQty).greaterThan(0))) {
        throw new BadRequestException({
          code: 'PO_HAS_RECEIPTS',
          message: `${po.poNumber} has goods received or bills against it. Close it instead of deleting it.`,
        });
      }
      // A hard delete: the entity has no soft-delete column, so softRemove
      // always threw. The number is not reused — document_sequences remembers it.
      await manager.remove(po);
      return { id, deleted: true };
    });
  }

  /**
   * Move a PO between requisition, sent and closed.
   *
   *   draft  → sent     approve the requisition and send it to the vendor
   *   sent   → draft    back to a requisition, only while nothing is received
   *   sent / partial / received → closed   no more goods expected
   *   closed → sent     reopen
   *
   * 'partial' and 'received' follow from receipts and are never set by hand.
   * A PO cannot close while received goods are still unbilled: billing a
   * closed PO is refused, so their GRNI would be stranded.
   */
  async updateStatus(companyId: string, id: string, status: PurchaseOrderStatus) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockPo(manager, companyId, id);
      if (po.status === status) return;
      const anyReceived = po.lines.some((l) => toDecimal(l.receivedQty).greaterThan(0));
      const refuse = (message: string) => {
        throw new BadRequestException({ code: 'INVALID_STATUS_TRANSITION', message });
      };
      switch (status) {
        case 'sent':
          if (po.status === 'closed') {
            po.status = this.deriveStatus(po.lines, { ignoreBilling: true });
          } else if (po.status === 'draft') {
            po.status = 'sent';
          } else {
            refuse(`${po.poNumber} is already with the vendor.`);
          }
          break;
        case 'draft':
          if (po.status !== 'sent' || anyReceived) {
            refuse(`${po.poNumber} can only go back to a requisition before anything is received.`);
          }
          po.status = 'draft';
          break;
        case 'closed': {
          if (po.status === 'draft') refuse('A requisition cannot be closed. Delete it instead.');
          const unbilled = po.lines.some((l) =>
            toDecimal(l.receivedQty).greaterThan(toDecimal(l.billedQty)),
          );
          if (unbilled) {
            throw new BadRequestException({
              code: 'PO_HAS_UNBILLED_RECEIPTS',
              message: `Bill the goods received on ${po.poNumber} before closing it.`,
            });
          }
          po.status = 'closed';
          break;
        }
        default:
          refuse(`'${status}' follows from goods received and cannot be set directly.`);
      }
      await manager.save(po);
    });
    return this.getById(companyId, id);
  }

  private deriveStatus(
    lines: PurchaseOrderLine[],
    opts: { ignoreBilling?: boolean } = {},
  ): PurchaseOrderStatus {
    let allReceived = lines.length > 0;
    let anyReceived = false;
    let allBilled = lines.length > 0;
    for (const l of lines) {
      const o = toDecimal(l.orderedQty);
      const r = toDecimal(l.receivedQty);
      if (r.greaterThan(0)) anyReceived = true;
      if (r.lessThan(o)) allReceived = false;
      if (toDecimal(l.billedQty).lessThan(o)) allBilled = false;
    }
    if (allReceived && allBilled && !opts.ignoreBilling) return 'closed';
    if (allReceived) return 'received';
    if (anyReceived) return 'partial';
    return 'sent';
  }
}
