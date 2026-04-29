import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Bill } from './entities/bill.entity';
import { BillLineItem } from './entities/bill-line-item.entity';
import { BillPayment } from './entities/bill-payment.entity';
import { BillPaymentApplication } from './entities/bill-payment-application.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Account } from '../accounts/entities/account.entity';
import {
  BillLineDto,
  CreateBillDto,
  ListBillsQueryDto,
  PayBillsDto,
  UpdateBillDto,
} from './dto/bill.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import {
  addMoney,
  isPositive,
  moneyEquals,
  subtractMoney,
  toDecimal,
} from '../../common/utils/money.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { ACCT_AP } from '../accounts/accounts.constants';
import { BillStatus } from '../../types';

interface BillTotals {
  subtotal: string;
  taxAmount: string;
  total: string;
  lines: {
    accountId: string;
    description: string;
    amount: string;
    taxRate: string;
    taxAmount: string;
    lineOrder: number;
  }[];
}

@Injectable()
export class BillsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(BillLineItem)
    private readonly lineRepo: Repository<BillLineItem>,
    @InjectRepository(BillPayment)
    private readonly paymentRepo: Repository<BillPayment>,
    @InjectRepository(BillPaymentApplication)
    private readonly appRepo: Repository<BillPaymentApplication>,
    @InjectRepository(Vendor) private readonly vendorRepo: Repository<Vendor>,
  ) {}

  async list(
    companyId: string,
    query: ListBillsQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.billRepo
      .createQueryBuilder('b')
      .where('b.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('b.status = :s', { s: query.status });
    if (query.vendorId) qb.andWhere('b.vendorId = :v', { v: query.vendorId });
    qb.orderBy('b.billDate', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);
    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string): Promise<Bill> {
    const b = await this.billRepo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!b) {
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: 'Bill not found',
      });
    }
    b.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return b;
  }

  async create(
    companyId: string,
    userId: string,
    dto: CreateBillDto,
  ): Promise<Bill> {
    return this.dataSource.transaction(async (manager) => {
      const vendor = await manager.findOne(Vendor, {
        where: { id: dto.vendorId, companyId },
      });
      if (!vendor) {
        throw new NotFoundException({
          code: 'VENDOR_NOT_FOUND',
          message: 'Vendor not found',
        });
      }

      const totals = this.computeTotals(dto.lines);
      const status: BillStatus = dto.status ?? 'open';

      const bill = manager.create(Bill, {
        companyId,
        vendorId: vendor.id,
        billNumber: dto.billNumber,
        billDate: dto.billDate,
        dueDate: dto.dueDate,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        total: totals.total,
        amountPaid: '0',
        balance: totals.total,
        status,
        memo: dto.memo ?? null,
        journalEntryId: null,
      });
      await manager.save(bill);

      const lines = totals.lines.map((l) =>
        manager.create(BillLineItem, { billId: bill.id, ...l }),
      );
      await manager.save(lines);
      bill.lines = lines;

      if (status !== 'draft') {
        await this.createJournalEntryForBill(manager, bill, userId);
        vendor.balance = addMoney(vendor.balance, bill.total).toFixed(4);
        await manager.save(vendor);
      }
      return bill;
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateBillDto,
  ): Promise<Bill> {
    return this.dataSource.transaction(async (manager) => {
      const bill = await manager.findOne(Bill, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!bill) {
        throw new NotFoundException({
          code: 'BILL_NOT_FOUND',
          message: 'Bill not found',
        });
      }
      if (bill.status !== 'draft') {
        throw new BadRequestException({
          code: 'CANNOT_EDIT_POSTED',
          message: 'Only draft bills can be edited',
        });
      }
      if (dto.billNumber !== undefined) bill.billNumber = dto.billNumber;
      if (dto.billDate !== undefined) bill.billDate = dto.billDate;
      if (dto.dueDate !== undefined) bill.dueDate = dto.dueDate;
      if (dto.memo !== undefined) bill.memo = dto.memo;

      if (dto.lines) {
        const totals = this.computeTotals(dto.lines);
        bill.subtotal = totals.subtotal;
        bill.taxAmount = totals.taxAmount;
        bill.total = totals.total;
        bill.balance = totals.total;
        await manager.delete(BillLineItem, { billId: bill.id });
        const lines = totals.lines.map((l) =>
          manager.create(BillLineItem, { billId: bill.id, ...l }),
        );
        await manager.save(lines);
      }
      await manager.save(bill);
      return this.getById(companyId, id);
    });
  }

  async pay(
    companyId: string,
    userId: string,
    dto: PayBillsDto,
  ): Promise<BillPayment> {
    return this.dataSource.transaction(async (manager) => {
      const vendor = await manager.findOne(Vendor, {
        where: { id: dto.vendorId, companyId },
      });
      if (!vendor) {
        throw new NotFoundException({
          code: 'VENDOR_NOT_FOUND',
          message: 'Vendor not found',
        });
      }
      const bank = await manager.findOne(Account, {
        where: { id: dto.bankAccountId, companyId },
      });
      if (!bank) {
        throw new NotFoundException({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Bank account not found',
        });
      }

      let total = toDecimal(0);
      for (const app of dto.applications) {
        total = total.plus(toDecimal(app.amount));
      }

      const payment = manager.create(BillPayment, {
        companyId,
        vendorId: vendor.id,
        bankAccountId: dto.bankAccountId,
        paymentDate: dto.paymentDate,
        paymentMethod: dto.paymentMethod,
        reference: dto.reference ?? null,
        totalAmount: total.toFixed(4),
        journalEntryId: null,
      });
      await manager.save(payment);

      const apps: BillPaymentApplication[] = [];
      for (const app of dto.applications) {
        const bill = await manager.findOne(Bill, {
          where: { id: app.billId, companyId },
        });
        if (!bill) {
          throw new NotFoundException({
            code: 'BILL_NOT_FOUND',
            message: `Bill ${app.billId} not found`,
          });
        }
        if (bill.vendorId !== vendor.id) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'Bill belongs to a different vendor',
          });
        }
        const amt = toDecimal(app.amount);
        if (!isPositive(amt)) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'Application amount must be positive',
          });
        }
        if (amt.greaterThan(toDecimal(bill.balance))) {
          throw new BadRequestException({
            code: 'PAYMENT_EXCEEDS_BALANCE',
            message: `Application (${amt.toFixed(4)}) exceeds bill balance (${bill.balance})`,
          });
        }
        bill.amountPaid = addMoney(bill.amountPaid, amt).toFixed(4);
        bill.balance = subtractMoney(bill.total, bill.amountPaid).toFixed(4);
        bill.status = moneyEquals(bill.amountPaid, bill.total)
          ? 'paid'
          : isPositive(bill.amountPaid)
            ? 'partial'
            : bill.status;
        await manager.save(bill);

        apps.push(
          manager.create(BillPaymentApplication, {
            billPaymentId: payment.id,
            billId: bill.id,
            amount: amt.toFixed(4),
          }),
        );
      }
      await manager.save(apps);
      payment.applications = apps;

      vendor.balance = subtractMoney(vendor.balance, total).toFixed(4);
      await manager.save(vendor);

      // Journal entry: DR AP, CR Bank
      const ap = await this.accounts.getByNumberOrFail(companyId, ACCT_AP, manager);
      const entry = await this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: dto.paymentDate,
        memo: `Bill payment to ${vendor.companyName}`,
        status: 'posted',
        sourceType: 'bill_payment',
        sourceId: payment.id,
        lines: [
          {
            accountId: ap.id,
            debit: total.toFixed(4),
            credit: '0',
            lineOrder: 0,
          },
          {
            accountId: bank.id,
            debit: '0',
            credit: total.toFixed(4),
            lineOrder: 1,
          },
        ],
      });
      payment.journalEntryId = entry.id;
      await manager.save(payment);

      return payment;
    });
  }

  // Hook for vendor-credits
  async applyCredit(
    manager: EntityManager,
    companyId: string,
    billId: string,
    amount: string,
  ): Promise<Bill> {
    const bill = await manager.findOne(Bill, { where: { id: billId, companyId } });
    if (!bill) {
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: 'Bill not found',
      });
    }
    const amt = toDecimal(amount);
    if (amt.greaterThan(toDecimal(bill.balance))) {
      throw new BadRequestException({
        code: 'PAYMENT_EXCEEDS_BALANCE',
        message: `Amount (${amt.toFixed(4)}) exceeds bill balance (${bill.balance})`,
      });
    }
    bill.amountPaid = addMoney(bill.amountPaid, amt).toFixed(4);
    bill.balance = subtractMoney(bill.total, bill.amountPaid).toFixed(4);
    bill.status = moneyEquals(bill.amountPaid, bill.total) ? 'paid' : 'partial';
    await manager.save(bill);
    return bill;
  }

  async delete(companyId: string, id: string) {
    const b = await this.getById(companyId, id);
    await this.billRepo.softRemove(b);
    return { id, deleted: true };
  }

  async listPayments(companyId: string, billId: string | undefined, page: number, limit: number) {
    const qb = this.paymentRepo.createQueryBuilder('p').where('p.companyId = :cid', { cid: companyId });
    if (billId) qb.andWhere('p.id IN (SELECT bill_payment_id FROM bill_payment_applications WHERE bill_id = :bid)', { bid: billId });
    qb.orderBy('p.paymentDate', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  private computeTotals(lines: BillLineDto[]): BillTotals {
    let subtotal = new Decimal(0);
    let tax = new Decimal(0);
    const calc = lines.map((l, i) => {
      const amount = toDecimal(l.amount);
      const rate = toDecimal(l.taxRate ?? '0');
      const lineTax = amount.times(rate).dividedBy(100);
      subtotal = subtotal.plus(amount);
      tax = tax.plus(lineTax);
      return {
        accountId: l.accountId,
        description: l.description,
        amount: amount.toFixed(4),
        taxRate: rate.toFixed(4),
        taxAmount: lineTax.toFixed(4),
        lineOrder: i,
      };
    });
    return {
      subtotal: subtotal.toFixed(4),
      taxAmount: tax.toFixed(4),
      total: subtotal.plus(tax).toFixed(4),
      lines: calc,
    };
  }

  private async createJournalEntryForBill(
    manager: EntityManager,
    bill: Bill,
    userId: string,
  ): Promise<void> {
    const ap = await this.accounts.getByNumberOrFail(bill.companyId, ACCT_AP, manager);
    const jLines: Array<{
      accountId: string;
      description?: string;
      debit: string;
      credit: string;
      lineOrder: number;
    }> = bill.lines.map((l, i) => ({
      accountId: l.accountId,
      description: l.description,
      debit: toDecimal(l.amount).plus(toDecimal(l.taxAmount)).toFixed(4),
      credit: '0',
      lineOrder: i,
    }));
    jLines.push({
      accountId: ap.id,
      description: `Bill ${bill.billNumber}`,
      debit: '0',
      credit: bill.total,
      lineOrder: jLines.length,
    });
    const entry = await this.posting.createEntry(manager, {
      companyId: bill.companyId,
      createdBy: userId,
      date: bill.billDate,
      memo: `Bill ${bill.billNumber}`,
      status: 'posted',
      sourceType: 'bill',
      sourceId: bill.id,
      lines: jLines,
    });
    bill.journalEntryId = entry.id;
    await manager.save(bill);
  }
}
