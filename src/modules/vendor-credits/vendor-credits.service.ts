import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { VendorCredit, VendorCreditStatus } from './entities/vendor-credit.entity';
import { VendorCreditLine } from './entities/vendor-credit-line.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import {
  ApplyVendorCreditDto, CreateVendorCreditDto, ListVendorCreditsQueryDto, VendorCreditLineDto,
} from './dto/vendor-credit.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { addMoney, toDecimal } from '../../common/utils/money.util';
import { formatYearlyRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { BillsService } from '../bills/bills.service';
import { Bill } from '../bills/entities/bill.entity';
import { ACCT_AP, ACCT_COGS, ACCT_INPUT_TAX, ACCT_INVENTORY } from '../accounts/accounts.constants';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { assertSufficientStock } from '../../common/utils/stock.util';

@Injectable()
export class VendorCreditsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly bills: BillsService,
    @InjectRepository(VendorCredit) private readonly repo: Repository<VendorCredit>,
    @InjectRepository(Vendor) private readonly vendorRepo: Repository<Vendor>,
  ) {}

  async list(companyId: string, query: ListVendorCreditsQueryDto, pagination: PaginationParams) {
    const qb = this.repo.createQueryBuilder('c').where('c.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('c.status = :s', { s: query.status });
    if (query.vendorId) qb.andWhere('c.vendorId = :v', { v: query.vendorId });
    if (query.search) qb.andWhere('c.vendorCreditNumber ILIKE :q', { q: `%${query.search}%` });
    qb.orderBy('c.date', 'DESC').addOrderBy('c.createdAt', 'DESC').take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();
    const ids = [...new Set(data.map((c) => c.vendorId))];
    const vendors = ids.length ? await this.vendorRepo.findByIds(ids) : [];
    const nameMap = Object.fromEntries(vendors.map((v) => [v.id, v.companyName]));
    return {
      data: data.map((c) => ({ ...c, vendorName: nameMap[c.vendorId] ?? '' })),
      pagination: { page: pagination.page, limit: pagination.limit, total, totalPages: Math.max(1, Math.ceil(total / pagination.limit)) },
    };
  }

  async getById(companyId: string, id: string): Promise<VendorCredit> {
    const vc = await this.repo.findOne({ where: { id, companyId }, relations: { lines: true } });
    if (!vc) throw new NotFoundException({ code: 'VENDOR_CREDIT_NOT_FOUND', message: 'Vendor credit not found' });
    vc.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return vc;
  }

  async create(companyId: string, userId: string, dto: CreateVendorCreditDto): Promise<VendorCredit> {
    return this.dataSource.transaction(async (manager) => {
      const vendor = await manager.findOne(Vendor, { where: { id: dto.vendorId, companyId } });
      if (!vendor) throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found' });

      const cogs = await this.accounts.getByNumberOrFail(companyId, ACCT_COGS, manager);
      const inventoryAcct = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, manager);

      // A line may name an inventory item OR an expense account, never both by
      // accident. Pointing a non-stock line at 1200 would credit the control
      // account while SUM(qty x unit_cost) stayed put — the subledger drift
      // invariant I13 exists to catch, and the reason this module used to
      // credit COGS instead of doing the job properly.
      for (const l of dto.lines) {
        if (!l.itemId && l.accountId === inventoryAcct.id) {
          throw new BadRequestException({
            code: 'INVENTORY_LINE_NEEDS_ITEM',
            message:
              'A line crediting Inventory must name the item and quantity being returned, ' +
              'otherwise stock and the Inventory account would disagree.',
          });
        }
        if (l.itemId && !toDecimal(l.quantity ?? '0').greaterThan(0)) {
          throw new BadRequestException({
            code: 'QUANTITY_REQUIRED',
            message: 'A returned item needs the quantity going back to the supplier.',
          });
        }
      }

      const totals = this.computeTotals(dto.lines);
      const year = parseInt(dto.date.slice(0, 4), 10);
      const seq = await nextYearlySequence(manager, 'vendor_credits', companyId, year, 'date', 'VC', 'vendor_credit_number');
      const number = formatYearlyRef('VC', year, seq);

      const vc = manager.create(VendorCredit, {
        companyId, vendorId: dto.vendorId, vendorCreditNumber: number, date: dto.date,
        originalBillId: dto.originalBillId ?? null, reason: dto.reason ?? null,
        subtotal: totals.subtotal, taxAmount: totals.taxAmount, total: totals.total,
        amountApplied: '0', balance: totals.total,
        status: 'open' as VendorCreditStatus, journalEntryId: null, createdBy: userId,
      });
      await manager.save(vc);
      vc.lines = dto.lines.map((l, i) => manager.create(VendorCreditLine, {
        vendorCreditId: vc.id,
        // Goods going back to the supplier leave Inventory; anything else is
        // a money-only credit against its expense account.
        accountId: l.itemId ? inventoryAcct.id : l.accountId ?? cogs.id,
        itemId: l.itemId ?? null,
        quantity: l.itemId ? toDecimal(l.quantity ?? '0').toFixed(4) : null,
        description: l.description,
        amount: toDecimal(l.amount).toFixed(4),
        taxRate: toDecimal(l.taxRate ?? '0').toFixed(4), lineOrder: i,
      }));
      await manager.save(vc.lines);

      // Relieve the stock in the same transaction as the journal entry, so the
      // subledger and account 1200 can never move apart.
      await this.relieveReturnedStock(manager, companyId, vc, false);

      // JE (mirror of the credit memo, on the AP side): DR Accounts Payable for
      // the gross the vendor no longer owes us; CR the expense/inventory
      // account(s) for the net; CR Sales Tax Recoverable (1300) for the input
      // tax originally claimed on the bill, which is no longer recoverable.
      const ap = await this.accounts.getByNumberOrFail(companyId, ACCT_AP, manager);
      const jeLines = [
        { accountId: ap.id, description: `Vendor credit ${number}`, debit: totals.total, credit: '0', lineOrder: 0 },
        ...vc.lines.map((l, i) => ({ accountId: l.accountId!, description: l.description, debit: '0', credit: l.amount, lineOrder: i + 1 })),
      ];
      if (toDecimal(totals.taxAmount).greaterThan(0)) {
        const inputTax = await this.accounts.getOrCreateSystemAccount(manager, companyId, ACCT_INPUT_TAX);
        jeLines.push({
          accountId: inputTax.id, description: 'Input tax reversed on vendor credit',
          debit: '0', credit: totals.taxAmount, lineOrder: jeLines.length,
        });
      }
      const entry = await this.posting.createEntry(manager, {
        companyId, createdBy: userId, date: dto.date, memo: `Vendor credit ${number}`,
        status: 'posted', lines: jeLines, sourceType: 'vendor_credit', sourceId: vc.id,
      });
      vc.journalEntryId = entry.id;
      await manager.save(vc);

      // The vendor owes us the gross, tax included.
      vendor.balance = addMoney(vendor.balance, toDecimal(totals.total).negated().toFixed(4)).toFixed(4);
      await manager.save(vendor);
      return vc;
    });
  }

  async applyToBill(companyId: string, id: string, dto: ApplyVendorCreditDto): Promise<VendorCredit> {
    return this.dataSource.transaction(async (manager) => {
      // Lock the credit, not just the bill: two concurrent applies of the same
      // credit would otherwise both read the same balance and both pass (M1).
      const vc = await manager.findOne(VendorCredit, {
        where: { id, companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!vc) throw new NotFoundException({ code: 'VENDOR_CREDIT_NOT_FOUND', message: 'Vendor credit not found' });
      if (vc.status === 'void' || vc.status === 'closed') {
        throw new BadRequestException({ code: 'CREDIT_UNAVAILABLE', message: `Vendor credit is ${vc.status}` });
      }
      const amt = toDecimal(dto.amount);
      if (amt.greaterThan(toDecimal(vc.balance))) {
        throw new BadRequestException({ code: 'EXCEEDS_CREDIT', message: 'Amount exceeds available credit balance' });
      }
      // A vendor's credit can only settle that vendor's bill.
      const target = await manager.findOne(Bill, { where: { id: dto.billId, companyId } });
      if (!target) {
        throw new NotFoundException({ code: 'BILL_NOT_FOUND', message: 'Bill not found' });
      }
      if (target.vendorId !== vc.vendorId) {
        throw new BadRequestException({
          code: 'VENDOR_MISMATCH',
          message: 'That bill belongs to a different vendor.',
        });
      }
      await this.bills.applyCredit(manager, companyId, dto.billId, dto.amount);
      vc.amountApplied = addMoney(vc.amountApplied, amt).toFixed(4);
      vc.balance = toDecimal(vc.total).minus(toDecimal(vc.amountApplied)).toFixed(4);
      vc.status = toDecimal(vc.balance).lessThanOrEqualTo(0) ? 'closed' : 'applied';
      await manager.save(vc);
      return vc;
    });
  }

  async void(companyId: string, id: string, userId: string): Promise<VendorCredit> {
    return this.dataSource.transaction(async (manager) => {
      const vc = await manager.findOne(VendorCredit, { where: { id, companyId }, relations: { lines: true } });
      if (!vc) throw new NotFoundException({ code: 'VENDOR_CREDIT_NOT_FOUND', message: 'Vendor credit not found' });
      if (vc.status === 'void') {
        throw new BadRequestException({ code: 'ALREADY_VOID', message: 'Vendor credit is already void' });
      }
      if (toDecimal(vc.amountApplied).greaterThan(0)) {
        throw new BadRequestException({ code: 'ALREADY_APPLIED', message: 'Cannot void a vendor credit that has been applied' });
      }
      if (vc.journalEntryId) {
        // Exact mirror of create(), including the input-tax leg, so the void
        // cancels the original entry to the cent.
        const ap = await this.accounts.getByNumberOrFail(companyId, ACCT_AP, manager);
        const jeLines = [
          { accountId: ap.id, debit: '0', credit: vc.total, lineOrder: 0 },
          ...vc.lines.map((l, i) => ({ accountId: l.accountId!, debit: l.amount, credit: '0', lineOrder: i + 1 })),
        ];
        if (toDecimal(vc.taxAmount).greaterThan(0)) {
          const inputTax = await this.accounts.getOrCreateSystemAccount(manager, companyId, ACCT_INPUT_TAX);
          jeLines.push({
            accountId: inputTax.id, debit: vc.taxAmount, credit: '0', lineOrder: jeLines.length,
          });
        }
        await this.posting.createEntry(manager, {
          companyId, createdBy: userId, date: new Date().toISOString().slice(0, 10),
          memo: `Void vendor credit ${vc.vendorCreditNumber}`, status: 'posted', lines: jeLines,
          reversalOfId: vc.journalEntryId, sourceType: 'vendor_credit_void', sourceId: vc.id,
        });
      }
      // The goods never went back to the supplier after all — put them on the
      // shelf, in the same transaction as the reversing entry above.
      await this.relieveReturnedStock(manager, companyId, vc, true);

      const vendor = await manager.findOne(Vendor, { where: { id: vc.vendorId, companyId } });
      if (vendor) { vendor.balance = addMoney(vendor.balance, vc.total).toFixed(4); await manager.save(vendor); }
      vc.status = 'void';
      vc.balance = '0';
      await manager.save(vc);
      return vc;
    });
  }

  /**
   * Net, tax and gross for the credit. Tax is computed per line so a credit
   * spanning taxed and zero-rated goods reverses only the input tax actually
   * claimed — the same proportional treatment credit memos use on the AR side.
   */
  private computeTotals(lines: VendorCreditLineDto[]) {
    let subtotal = new Decimal(0);
    let tax = new Decimal(0);
    for (const l of lines) {
      const net = toDecimal(l.amount);
      subtotal = subtotal.plus(net);
      tax = tax.plus(net.times(toDecimal(l.taxRate ?? '0')).dividedBy(100));
    }
    return {
      subtotal: subtotal.toFixed(4),
      taxAmount: tax.toFixed(4),
      total: subtotal.plus(tax).toFixed(4),
    };
  }

  async delete(companyId: string, id: string, userId: string) {
    const vc = await this.getById(companyId, id);
    if (vc.status !== 'open') {
      throw new BadRequestException({ code: 'CANNOT_DELETE', message: 'Only open, unapplied vendor credits can be deleted' });
    }
    // Reverse the ledger (via void) attributed to the acting user — never an
    // empty createdBy, which would fail the reversal JE's uuid column.
    if (vc.journalEntryId) { await this.void(companyId, id, userId); }
    await this.repo.remove(vc);
    return { id, deleted: true };
  }

  /**
   * Move the returned goods off the shelf (or back onto it, on void).
   *
   * The journal entry credits Inventory 1200 by the line's `amount`, so the
   * subledger has to fall by exactly that same figure — otherwise
   * SUM(qty x unit_cost) and the control account drift apart permanently
   * (invariant I13). Relieving `quantity` units at the line's implied unit
   * value (amount / quantity) and re-averaging the remainder is what keeps the
   * two equal, and it mirrors how a credit-memo restock folds units back in.
   */
  private async relieveReturnedStock(
    manager: EntityManager,
    companyId: string,
    vc: VendorCredit,
    reverse: boolean,
  ): Promise<void> {
    const itemRepo = manager.getRepository(InventoryItem);
    const moveRepo = manager.getRepository(InventoryMovement);

    for (const line of vc.lines) {
      if (!line.itemId) continue;
      const qty = toDecimal(line.quantity ?? '0');
      if (!qty.greaterThan(0)) continue;

      const item = await itemRepo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i.companyId = :cid', { id: line.itemId, cid: companyId })
        .getOne();
      if (!item) {
        throw new NotFoundException({
          code: 'ITEM_NOT_FOUND',
          message: `Inventory item ${line.itemId} no longer exists, so this credit cannot move stock.`,
        });
      }

      const onHand = toDecimal(item.quantityOnHand);
      if (!reverse) {
        // You cannot send back more than you hold. Refuse cleanly rather than
        // tripping chk_no_negative_stock as a raw 500 (I11).
        assertSufficientStock(item.name, onHand, qty);
      }
      const newQty = reverse ? onHand.plus(qty) : onHand.minus(qty);
      const movedValue = toDecimal(line.amount);

      if (newQty.greaterThan(0)) {
        const currentValue = onHand.times(toDecimal(item.unitCost));
        const nextValue = reverse
          ? currentValue.plus(movedValue)
          : currentValue.minus(movedValue);
        item.unitCost = nextValue
          .dividedBy(newQty)
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
          .toFixed(4);
      } else {
        // Last unit gone: zero stock at zero cost is the only self-consistent
        // resting state, and the next receipt sets the cost outright.
        item.unitCost = '0';
      }

      item.quantityOnHand = newQty.toFixed(4);
      await itemRepo.save(item);

      await moveRepo.save(
        moveRepo.create({
          companyId,
          itemId: item.id,
          date: vc.date,
          type: reverse ? 'return' : 'sale',
          quantityChange: (reverse ? qty : qty.negated()).toFixed(4),
          balanceAfter: newQty.toFixed(4),
          reference: vc.vendorCreditNumber,
          sourceType: reverse ? 'vendor_credit_void' : 'vendor_credit',
          sourceId: vc.id,
        }),
      );
    }
  }

}
