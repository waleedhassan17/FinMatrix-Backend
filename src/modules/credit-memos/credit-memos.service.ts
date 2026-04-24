import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { CreditMemo } from './entities/credit-memo.entity';
import { CreditMemoLine } from './entities/credit-memo-line.entity';
import { CreditMemoApplication } from './entities/credit-memo-application.entity';
import { Customer } from '../customers/entities/customer.entity';
import {
  ApplyCreditMemoDto,
  CreateCreditMemoDto,
} from './dto/credit-memo.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import {
  addMoney,
  isPositive,
  subtractMoney,
  toDecimal,
} from '../../common/utils/money.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { InvoicesService } from '../invoices/invoices.service';
import {
  ACCT_AR,
  ACCT_SALES_REVENUE,
  ACCT_TAX_PAYABLE,
} from '../accounts/accounts.constants';

@Injectable()
export class CreditMemosService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly invoices: InvoicesService,
    @InjectRepository(CreditMemo) private readonly repo: Repository<CreditMemo>,
    @InjectRepository(CreditMemoApplication)
    private readonly appRepo: Repository<CreditMemoApplication>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
  ) {}

  async list(companyId: string, pagination: PaginationParams) {
    const [data, total] = await this.repo.findAndCount({
      where: { companyId },
      relations: { lines: true },
      order: { date: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
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

  async create(
    companyId: string,
    userId: string,
    dto: CreateCreditMemoDto,
  ): Promise<CreditMemo> {
    return this.dataSource.transaction(async (manager) => {
      const customer = await manager.findOne(Customer, {
        where: { id: dto.customerId, companyId },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'CUSTOMER_NOT_FOUND',
          message: 'Customer not found',
        });
      }

      let subtotal = new Decimal(0);
      let tax = new Decimal(0);
      const calc = dto.lines.map((l, i) => {
        const qty = toDecimal(l.quantity);
        const price = toDecimal(l.unitPrice);
        const rate = toDecimal(l.taxRate ?? '0');
        const base = qty.times(price);
        const t = base.times(rate).dividedBy(100);
        subtotal = subtotal.plus(base);
        tax = tax.plus(t);
        return {
          description: l.description,
          quantity: qty.toFixed(4),
          unitPrice: price.toFixed(4),
          taxRate: rate.toFixed(4),
          lineTotal: base.plus(t).toFixed(4),
          lineOrder: i,
        };
      });
      const total = subtotal.plus(tax);

      const memo = manager.create(CreditMemo, {
        companyId,
        customerId: dto.customerId,
        date: dto.date,
        originalInvoiceId: dto.originalInvoiceId ?? null,
        reason: dto.reason ?? null,
        subtotal: subtotal.toFixed(4),
        taxAmount: tax.toFixed(4),
        total: total.toFixed(4),
        amountApplied: '0',
        balance: total.toFixed(4),
        journalEntryId: null,
      });
      await manager.save(memo);
      const lines = calc.map((l) =>
        manager.create(CreditMemoLine, { creditMemoId: memo.id, ...l }),
      );
      await manager.save(lines);
      memo.lines = lines;

      // Journal entry: DR Sales Revenue (subtotal), DR Tax Payable (tax), CR AR (total)
      const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
      const rev = await this.accounts.getByNumberOrFail(
        companyId,
        ACCT_SALES_REVENUE,
        manager,
      );
      const taxAcct = await this.accounts.getByNumberOrFail(
        companyId,
        ACCT_TAX_PAYABLE,
        manager,
      );
      const jLines: Array<{
        accountId: string;
        debit: string;
        credit: string;
        lineOrder: number;
      }> = [
        { accountId: rev.id, debit: subtotal.toFixed(4), credit: '0', lineOrder: 0 },
      ];
      if (tax.greaterThan(0)) {
        jLines.push({ accountId: taxAcct.id, debit: tax.toFixed(4), credit: '0', lineOrder: 1 });
      }
      jLines.push({ accountId: ar.id, debit: '0', credit: total.toFixed(4), lineOrder: jLines.length });

      const entry = await this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: dto.date,
        memo: `Credit memo for ${customer.name}`,
        status: 'posted',
        sourceType: 'credit_memo',
        sourceId: memo.id,
        lines: jLines,
      });
      memo.journalEntryId = entry.id;
      await manager.save(memo);

      // Customer AR balance goes down
      customer.balance = subtractMoney(customer.balance, total).toFixed(4);
      await manager.save(customer);

      return memo;
    });
  }

  async apply(
    companyId: string,
    creditMemoId: string,
    dto: ApplyCreditMemoDto,
  ): Promise<CreditMemo> {
    return this.dataSource.transaction(async (manager) => {
      const memo = await manager.findOne(CreditMemo, {
        where: { id: creditMemoId, companyId },
      });
      if (!memo) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Credit memo not found',
        });
      }
      const amount = toDecimal(dto.amount);
      if (!isPositive(amount)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Amount must be positive',
        });
      }
      if (amount.greaterThan(toDecimal(memo.balance))) {
        throw new BadRequestException({
          code: 'PAYMENT_EXCEEDS_BALANCE',
          message: `Amount (${amount.toFixed(4)}) exceeds memo balance (${memo.balance})`,
        });
      }

      await this.invoices.applyPayment(manager, companyId, dto.invoiceId, amount.toFixed(4));
      await manager.save(
        manager.create(CreditMemoApplication, {
          creditMemoId: memo.id,
          invoiceId: dto.invoiceId,
          amount: amount.toFixed(4),
        }),
      );

      memo.amountApplied = addMoney(memo.amountApplied, amount).toFixed(4);
      memo.balance = subtractMoney(memo.total, memo.amountApplied).toFixed(4);
      await manager.save(memo);
      return memo;
    });
  }
}
