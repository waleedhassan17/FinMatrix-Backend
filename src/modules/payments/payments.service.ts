import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentApplication } from './entities/payment-application.entity';
import { Customer } from '../customers/entities/customer.entity';
import {
  ListPaymentsQueryDto,
  PaymentApplicationDto,
  ReceivePaymentDto,
} from './dto/payment.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import {
  addMoney,
  isPositive,
  MONEY_TOLERANCE,
  subtractMoney,
  toDecimal,
} from '../../common/utils/money.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ACCT_AR, ACCT_BANK, ACCT_CASH } from '../accounts/accounts.constants';
import { Account } from '../accounts/entities/account.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { assertNotReconciled } from '../reconciliations/reconciliations.util';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly invoices: InvoicesService,
    @InjectRepository(Payment) private readonly repo: Repository<Payment>,
    @InjectRepository(PaymentApplication)
    private readonly appRepo: Repository<PaymentApplication>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
  ) {}

  async outstanding(companyId: string, customerId: string) {
    return this.invoices.outstandingForCustomer(companyId, customerId);
  }

  async list(
    companyId: string,
    query: ListPaymentsQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.applications', 'app')
      .where('p.companyId = :companyId', { companyId });
    if (query.customerId) qb.andWhere('p.customerId = :c', { c: query.customerId });
    if (query.invoiceId)
      qb.andWhere(
        `p.id IN (SELECT pa."payment_id" FROM payment_applications pa WHERE pa."invoice_id" = :invId)`,
        { invId: query.invoiceId },
      );
    if (query.startDate && query.endDate)
      qb.andWhere('p.paymentDate BETWEEN :s AND :e', {
        s: query.startDate,
        e: query.endDate,
      });
    if (query.paymentMethod)
      qb.andWhere('p.paymentMethod = :pm', { pm: query.paymentMethod });
    qb.orderBy('p.paymentDate', 'DESC');
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

  async getById(companyId: string, id: string): Promise<Payment> {
    const p = await this.repo.findOne({
      where: { id, companyId },
      relations: { applications: true },
    });
    if (!p) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Payment not found',
      });
    }
    return p;
  }

  async receive(
    companyId: string,
    userId: string,
    dto: ReceivePaymentDto,
  ): Promise<Payment> {
    return this.dataSource.transaction(async (manager) =>
      this.receiveInTransaction(manager, companyId, userId, dto),
    );
  }

  /**
   * Transaction-aware variant of receive(): lets the delivery approval flow
   * record the rider-collected cash atomically with the invoice + COGS
   * postings. Same logic, same postings.
   */
  async receiveInTransaction(
    manager: EntityManager,
    companyId: string,
    userId: string,
    dto: ReceivePaymentDto,
  ): Promise<Payment> {
    {
      const customer = await manager.findOne(Customer, {
        where: { id: dto.customerId, companyId },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'CUSTOMER_NOT_FOUND',
          message: 'Customer not found',
        });
      }

      const amount = toDecimal(dto.amount);
      if (!isPositive(amount)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Payment amount must be positive',
        });
      }

      // Determine applications. The sum applied to invoices may be LESS than
      // the payment amount — the unapplied remainder is retained as a customer
      // credit (the customer's AR balance simply goes negative). It may never
      // EXCEED the payment amount.
      let applications: PaymentApplicationDto[];
      if (dto.applications && dto.applications.length > 0) {
        const sum = dto.applications.reduce(
          (acc, a) => addMoney(acc, a.amount),
          toDecimal(0),
        );
        if (sum.greaterThan(amount.plus(MONEY_TOLERANCE))) {
          throw new BadRequestException({
            code: 'INVALID_PAYMENT_APPLICATION',
            message: `Applications total (${sum.toFixed(4)}) cannot exceed payment amount (${amount.toFixed(4)})`,
          });
        }
        applications = dto.applications;
      } else {
        applications = await this.autoApply(companyId, customer.id, amount.toFixed(4));
      }

      // Resolve the GL account to debit. If the caller supplied an explicit
      // account, validate it; otherwise fall back to the company's Cash account
      // (cash payments) or Business Checking account (everything else) so the
      // mobile client doesn't have to know GL account ids.
      let bank: Account;
      if (dto.bankAccountId) {
        const found = await manager.findOne(Account, {
          where: { id: dto.bankAccountId, companyId },
        });
        if (!found) {
          throw new NotFoundException({
            code: 'ACCOUNT_NOT_FOUND',
            message: 'Bank/Cash account not found',
          });
        }
        bank = found;
      } else {
        const defaultNumber =
          dto.paymentMethod === 'cash' ? ACCT_CASH : ACCT_BANK;
        bank = await this.accounts.getByNumberOrFail(
          companyId,
          defaultNumber,
          manager,
        );
      }

      const payment = manager.create(Payment, {
        companyId,
        customerId: customer.id,
        paymentDate: dto.paymentDate,
        paymentMethod: dto.paymentMethod,
        reference: dto.reference ?? null,
        amount: amount.toFixed(4),
        bankAccountId: bank.id,
        memo: dto.memo ?? null,
        journalEntryId: null,
      });
      await manager.save(payment);

      // Apply to invoices
      const appEntities: PaymentApplication[] = [];
      for (const app of applications) {
        await this.invoices.applyPayment(manager, companyId, app.invoiceId, app.amount);
        appEntities.push(
          manager.create(PaymentApplication, {
            paymentId: payment.id,
            invoiceId: app.invoiceId,
            amountApplied: toDecimal(app.amount).toFixed(4),
          }),
        );
      }
      await manager.save(appEntities);
      payment.applications = appEntities;

      // Decrement customer AR balance
      customer.balance = subtractMoney(customer.balance, amount).toFixed(4);
      await manager.save(customer);

      // Auto journal entry: DR bank, CR AR
      const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
      const entry = await this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: dto.paymentDate,
        memo: `Payment from customer ${customer.name}`,
        status: 'posted',
        sourceType: 'payment',
        sourceId: payment.id,
        lines: [
          {
            accountId: bank.id,
            description: `Payment ${dto.reference ?? ''}`.trim(),
            debit: amount.toFixed(4),
            credit: '0',
            lineOrder: 0,
          },
          {
            accountId: ar.id,
            description: 'Apply to AR',
            debit: '0',
            credit: amount.toFixed(4),
            lineOrder: 1,
          },
        ],
      });
      payment.journalEntryId = entry.id;
      await manager.save(payment);

      return payment;
    }
  }

  /**
   * Delete a payment (QuickBooks "delete payment"): reverses everything
   * receive() did — un-applies the invoices, restores the customer's AR
   * balance, posts a REVERSING journal entry (Dr AR / Cr Bank) — and then
   * removes the payment record. Blocked with TRANSACTION_RECONCILED when the
   * payment's bank GL row is part of a completed reconciliation.
   *
   * (The previous implementation was a silent no-op: softRemove on an entity
   * with no @DeleteDateColumn, and it never touched the ledger, the invoices
   * or the customer balance even if it had worked.)
   */
  async delete(companyId: string, id: string, userId: string) {
    return this.dataSource.transaction(async (manager) => {
      const payment = await manager.findOne(Payment, {
        where: { id, companyId },
        relations: { applications: true },
      });
      if (!payment) {
        throw new NotFoundException({
          code: 'PAYMENT_NOT_FOUND',
          message: 'Payment not found',
        });
      }

      // Bank-reconciliation lock (bankreconcillation.md behavior 9).
      await assertNotReconciled(manager, companyId, [payment.id], 'payment');

      // Un-apply from invoices — exact reverse of invoices.applyPayment,
      // with the same row lock against concurrent applications.
      const today = new Date().toISOString().slice(0, 10);
      for (const app of payment.applications ?? []) {
        const invoice = await manager.findOne(Invoice, {
          where: { id: app.invoiceId, companyId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!invoice) continue;
        const reducedPaid = subtractMoney(invoice.amountPaid, app.amountApplied);
        invoice.amountPaid = (reducedPaid.lessThan(0) ? toDecimal('0') : reducedPaid).toFixed(4);
        invoice.balance = subtractMoney(invoice.total, invoice.amountPaid).toFixed(4);
        if (toDecimal(invoice.amountPaid).greaterThanOrEqualTo(toDecimal(invoice.total))) {
          invoice.status = 'paid';
        } else if (invoice.dueDate < today) {
          invoice.status = 'overdue';
        } else if (isPositive(invoice.amountPaid)) {
          invoice.status = 'partial';
        } else {
          invoice.status = 'sent';
        }
        await manager.save(invoice);
      }

      // Restore the customer's AR balance (receive() decremented it).
      const customer = await manager.findOne(Customer, {
        where: { id: payment.customerId, companyId },
      });
      if (customer) {
        customer.balance = addMoney(customer.balance, payment.amount).toFixed(4);
        await manager.save(customer);
      }

      // Reversing entry: Dr AR / Cr Bank — keeps the ledger auditable instead
      // of deleting posted GL history.
      if (payment.journalEntryId) {
        const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
        await this.posting.createEntry(manager, {
          companyId,
          createdBy: userId,
          date: today,
          memo: `Delete payment ${payment.reference ?? payment.id.slice(0, 8)}`,
          status: 'posted',
          sourceType: 'payment_void',
          sourceId: payment.id,
          reversalOfId: payment.journalEntryId,
          lines: [
            {
              accountId: ar.id,
              description: 'Reverse payment application',
              debit: payment.amount,
              credit: '0',
              lineOrder: 0,
            },
            {
              accountId: payment.bankAccountId,
              description: 'Reverse bank deposit',
              debit: '0',
              credit: payment.amount,
              lineOrder: 1,
            },
          ],
        });
      }

      if (payment.applications?.length) {
        await manager.remove(payment.applications);
      }
      await manager.remove(payment);
      return { id, deleted: true };
    });
  }

  private async autoApply(
    companyId: string,
    customerId: string,
    amount: string,
  ): Promise<PaymentApplicationDto[]> {
    const outstanding = await this.invoices.outstandingForCustomer(companyId, customerId);
    const apps: PaymentApplicationDto[] = [];
    let remaining = toDecimal(amount);
    for (const inv of outstanding) {
      if (!isPositive(remaining)) break;
      const bal = toDecimal(inv.balance);
      const apply = remaining.lessThan(bal) ? remaining : bal;
      apps.push({ invoiceId: inv.id, amount: apply.toFixed(4) });
      remaining = remaining.minus(apply);
    }
    // Any amount left after the oldest-first sweep is intentionally retained as
    // a customer credit (negative AR balance) rather than rejected.
    return apps;
  }
}
