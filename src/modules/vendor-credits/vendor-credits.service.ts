import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { VendorCredit, VendorCreditStatus } from './entities/vendor-credit.entity';
import { VendorCreditLine } from './entities/vendor-credit-line.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import {
  ApplyVendorCreditDto, CreateVendorCreditDto, ListVendorCreditsQueryDto,
} from './dto/vendor-credit.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { addMoney, toDecimal } from '../../common/utils/money.util';
import { formatYearlyRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { BillsService } from '../bills/bills.service';
import { ACCT_AP, ACCT_COGS } from '../accounts/accounts.constants';

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
      const total = dto.lines.reduce((sum, l) => sum.plus(toDecimal(l.amount)), new Decimal(0));
      const year = parseInt(dto.date.slice(0, 4), 10);
      const seq = await nextYearlySequence(manager, 'vendor_credits', companyId, year, 'date', 'VC', 'vendor_credit_number');
      const number = formatYearlyRef('VC', year, seq);

      const vc = manager.create(VendorCredit, {
        companyId, vendorId: dto.vendorId, vendorCreditNumber: number, date: dto.date,
        originalBillId: dto.originalBillId ?? null, reason: dto.reason ?? null,
        total: total.toFixed(4), amountApplied: '0', balance: total.toFixed(4),
        status: 'open' as VendorCreditStatus, journalEntryId: null, createdBy: userId,
      });
      await manager.save(vc);
      vc.lines = dto.lines.map((l, i) => manager.create(VendorCreditLine, {
        vendorCreditId: vc.id, accountId: l.accountId ?? cogs.id, description: l.description,
        amount: toDecimal(l.amount).toFixed(4), lineOrder: i,
      }));
      await manager.save(vc.lines);

      // JE: DR Accounts Payable (reduce owed), CR expense account(s) per line.
      const ap = await this.accounts.getByNumberOrFail(companyId, ACCT_AP, manager);
      const jeLines = [
        { accountId: ap.id, description: `Vendor credit ${number}`, debit: total.toFixed(4), credit: '0', lineOrder: 0 },
        ...vc.lines.map((l, i) => ({ accountId: l.accountId!, description: l.description, debit: '0', credit: l.amount, lineOrder: i + 1 })),
      ];
      const entry = await this.posting.createEntry(manager, {
        companyId, createdBy: userId, date: dto.date, memo: `Vendor credit ${number}`,
        status: 'posted', lines: jeLines, sourceType: 'vendor_credit', sourceId: vc.id,
      });
      vc.journalEntryId = entry.id;
      await manager.save(vc);

      vendor.balance = addMoney(vendor.balance, total.negated().toFixed(4)).toFixed(4);
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
        const ap = await this.accounts.getByNumberOrFail(companyId, ACCT_AP, manager);
        const jeLines = [
          { accountId: ap.id, debit: '0', credit: vc.total, lineOrder: 0 },
          ...vc.lines.map((l, i) => ({ accountId: l.accountId!, debit: l.amount, credit: '0', lineOrder: i + 1 })),
        ];
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

  async delete(companyId: string, id: string) {
    const vc = await this.getById(companyId, id);
    if (vc.status !== 'open') {
      throw new BadRequestException({ code: 'CANNOT_DELETE', message: 'Only open, unapplied vendor credits can be deleted' });
    }
    if (vc.journalEntryId) { await this.void(companyId, id, vc.createdBy ?? ''); }
    await this.repo.remove(vc);
    return { id, deleted: true };
  }
}
