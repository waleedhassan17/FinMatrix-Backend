import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { CreditMemo, CreditMemoStatus } from './entities/credit-memo.entity';
import { CreditMemoLine } from './entities/credit-memo-line.entity';
import { Customer } from '../customers/entities/customer.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import {
  ApplyCreditMemoDto, CreateCreditMemoDto, CreditMemoLineDto, ListCreditMemosQueryDto,
} from './dto/credit-memo.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { addMoney, toDecimal } from '../../common/utils/money.util';
import { formatYearlyRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { InvoicesService } from '../invoices/invoices.service';
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
    return this.dataSource.transaction(async (manager) => {
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
    });
  }

  async applyToInvoice(companyId: string, id: string, dto: ApplyCreditMemoDto): Promise<CreditMemo> {
    return this.dataSource.transaction(async (manager) => {
      const cm = await manager.findOne(CreditMemo, { where: { id, companyId } });
      if (!cm) throw new NotFoundException({ code: 'CREDIT_MEMO_NOT_FOUND', message: 'Credit memo not found' });
      if (cm.status === 'void' || cm.status === 'refunded' || cm.status === 'closed') {
        throw new BadRequestException({ code: 'CREDIT_UNAVAILABLE', message: `Credit memo is ${cm.status}` });
      }
      const amt = toDecimal(dto.amount);
      if (amt.greaterThan(toDecimal(cm.balance))) {
        throw new BadRequestException({ code: 'EXCEEDS_CREDIT', message: 'Amount exceeds available credit balance' });
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
      const cost = qty.times(toDecimal(item.unitCost));
      if (cost.lessThanOrEqualTo(0)) continue;
      total = total.plus(cost);

      const onHand = toDecimal(item.quantityOnHand);
      const newQty = reverse ? onHand.minus(qty) : onHand.plus(qty);
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
      });
    });
    return { subtotal: subtotal.toFixed(4), taxAmount: tax.toFixed(4), total: subtotal.plus(tax).toFixed(4), lines: calc };
  }
}
