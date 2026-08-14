import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
import { ACCT_AP, ACCT_COGS, ACCT_INPUT_TAX } from '../accounts/accounts.constants';

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
        vendorCreditId: vc.id, accountId: l.accountId ?? cogs.id, description: l.description,
        amount: toDecimal(l.amount).toFixed(4),
        taxRate: toDecimal(l.taxRate ?? '0').toFixed(4), lineOrder: i,
      }));
      await manager.save(vc.lines);

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
      const vc = await manager.findOne(VendorCredit, { where: { id, companyId } });
      if (!vc) throw new NotFoundException({ code: 'VENDOR_CREDIT_NOT_FOUND', message: 'Vendor credit not found' });
      if (vc.status === 'void' || vc.status === 'closed') {
        throw new BadRequestException({ code: 'CREDIT_UNAVAILABLE', message: `Vendor credit is ${vc.status}` });
      }
      const amt = toDecimal(dto.amount);
      if (amt.greaterThan(toDecimal(vc.balance))) {
        throw new BadRequestException({ code: 'EXCEEDS_CREDIT', message: 'Amount exceeds available credit balance' });
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
}
