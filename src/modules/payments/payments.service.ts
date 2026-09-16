import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Payment } from './entities/payment.entity';
import { PaymentApplication } from './entities/payment-application.entity';
import { Customer } from '../customers/entities/customer.entity';
import {
  ApplyPaymentDto,
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
import {
  ACCT_AR,
  ACCT_BANK,
  ACCT_CASH,
  ACCT_CUSTOMER_ADVANCES,
} from '../accounts/accounts.constants';
import { Account } from '../accounts/entities/account.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { JournalEntryLine } from '../journal-entries/entities/journal-entry-line.entity';
import { assertNotReconciled } from '../reconciliations/reconciliations.util';
import { nextDocumentNumber, yearOf } from '../../common/utils/sequence.util';
import { businessToday } from '../../common/utils/business-date.util';
import { assertNotFutureDate } from '../../common/utils/date.util';

/** A receipt still holding money that has not been applied to an invoice. */
export interface CustomerAdvance {
  paymentId: string;
  paymentNumber: string | null;
  paymentDate: string;
  amount: string;
  unapplied: string;
  /** false for receipts recorded before advances were posted to 2400. */
  advancePosted: boolean;
}

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

  /**
   * Money this customer has paid that is not yet applied to any invoice.
   *
   * This is what stops the mistake behind QA's JE-217: a receipt whose
   * remainder was held as credit, followed by a SECOND cash receipt to settle
   * an invoice the first one could have covered. The clients show these before
   * a new receipt is recorded and offer to apply them instead.
   */
  async availableAdvances(
    companyId: string,
    customerId: string,
    manager?: EntityManager,
  ): Promise<{ total: string; advances: CustomerAdvance[] }> {
    const runner = manager ?? this.dataSource.manager;
    const rows: Array<{
      id: string;
      payment_number: string | null;
      payment_date: string;
      amount: string;
      advance_posted: boolean;
      unapplied: string;
    }> = await runner.query(
      `SELECT p.id, p.payment_number, p.payment_date::text AS payment_date, p.amount,
              p.advance_posted,
              (p.amount - COALESCE(SUM(pa.amount_applied), 0)) AS unapplied
         FROM payments p
         LEFT JOIN payment_applications pa ON pa.payment_id = p.id
        WHERE p.company_id = $1 AND p.customer_id = $2
        GROUP BY p.id
       HAVING p.amount - COALESCE(SUM(pa.amount_applied), 0) > $3
        ORDER BY p.payment_date, p.created_at`,
      [companyId, customerId, MONEY_TOLERANCE.toFixed(4)],
    );
    const advances = rows.map((r) => ({
      paymentId: r.id,
      paymentNumber: r.payment_number,
      paymentDate: r.payment_date,
      amount: toDecimal(r.amount).toFixed(4),
      unapplied: toDecimal(r.unapplied).toFixed(4),
      advancePosted: !!r.advance_posted,
    }));
    const total = advances.reduce((sum, a) => sum.plus(a.unapplied), new Decimal(0));
    return { total: total.toFixed(4), advances };
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
      data: await this.withNames(companyId, data),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string) {
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
    const [named] = await this.withNames(companyId, [p]);
    return named;
  }

  /**
   * Attach the customer's name and each application's invoice number, so a
   * receipt reads as "RCT-2026-0012 from Allama Iqbal — INV-2026-0041" without
   * the client fetching every invoice.
   */
  private async withNames(companyId: string, payments: Payment[]) {
    if (payments.length === 0) return [];
    const customerIds = [...new Set(payments.map((p) => p.customerId))];
    const invoiceIds = [
      ...new Set(payments.flatMap((p) => (p.applications ?? []).map((a) => a.invoiceId))),
    ];
    const [customers, invoices] = await Promise.all([
      this.customerRepo.find({ where: { companyId, id: In(customerIds) }, select: ['id', 'name'] }),
      invoiceIds.length
        ? this.dataSource.getRepository(Invoice).find({
            where: { companyId, id: In(invoiceIds) },
            select: ['id', 'invoiceNumber'],
          })
        : Promise.resolve([] as Invoice[]),
    ]);
    const customerName = new Map(customers.map((c) => [c.id, c.name]));
    const invoiceNumber = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
    return payments.map((p) => {
      const applied = (p.applications ?? []).reduce(
        (sum, a) => sum.plus(toDecimal(a.amountApplied)),
        new Decimal(0),
      );
      return Object.assign(p, {
        customerName: customerName.get(p.customerId) ?? '',
        applications: (p.applications ?? []).map((a) =>
          Object.assign(a, { invoiceNumber: invoiceNumber.get(a.invoiceId) ?? '' }),
        ),
        amountApplied: applied.toFixed(4),
        unapplied: Decimal.max(toDecimal(p.amount).minus(applied), 0).toFixed(4),
      });
    });
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
   *
   * The posting:
   *   Dr Bank / Cash                   amount
   *     Cr 1100 Accounts Receivable      applied to invoices
   *     Cr 2400 Customer Advances        not applied (held for the customer)
   *
   * The unapplied part used to be credited to Accounts Receivable too, which
   * left a negative A/R balance tied to no invoice — and, with no way to apply
   * it later, led users to record the same money a second time to clear the
   * invoice. Money received before it is owed is a liability to the customer
   * (IFRS 15 contract liability) until it is applied.
   */
  async receiveInTransaction(
    manager: EntityManager,
    companyId: string,
    userId: string,
    dto: ReceivePaymentDto,
  ): Promise<Payment> {
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

    // Determine applications. The sum applied to invoices may be LESS than the
    // payment amount — the remainder is held in Customer Advances. It may never
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
    } else if (dto.holdAsAdvance) {
      applications = [];
    } else {
      applications = await this.autoApply(manager, companyId, customer.id, amount.toFixed(4));
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

    const paymentNumber = await nextDocumentNumber(
      manager,
      companyId,
      'RCT',
      yearOf(dto.paymentDate),
    );
    const payment = manager.create(Payment, {
      companyId,
      customerId: customer.id,
      paymentNumber,
      paymentDate: dto.paymentDate,
      paymentMethod: dto.paymentMethod,
      reference: dto.reference ?? null,
      amount: amount.toFixed(4),
      bankAccountId: bank.id,
      memo: dto.memo ?? null,
      journalEntryId: null,
      advancePosted: true,
    });
    await manager.save(payment);

    // Apply to invoices
    const appEntities: PaymentApplication[] = [];
    const appliedNumbers: string[] = [];
    let applied = new Decimal(0);
    for (const app of applications) {
      await this.assertInvoiceBelongsToCustomer(manager, companyId, app.invoiceId, customer.id);
      const invoice = await this.invoices.applyPayment(
        manager,
        companyId,
        app.invoiceId,
        app.amount,
      );
      // A credit sale that came from a delivery: tell the delivery it has
      // been settled, or its row reads NOT PAID forever.
      await this.syncDeliveryPaidStatus(manager, companyId, invoice);
      applied = applied.plus(toDecimal(app.amount));
      appliedNumbers.push(invoice.invoiceNumber);
      appEntities.push(
        manager.create(PaymentApplication, {
          paymentId: payment.id,
          invoiceId: app.invoiceId,
          amountApplied: toDecimal(app.amount).toFixed(4),
          appliedOn: null,
          journalEntryId: null,
        }),
      );
    }
    await manager.save(appEntities);
    payment.applications = appEntities;

    const unapplied = Decimal.max(amount.minus(applied), 0);

    // The customer's balance is what they owe on invoices; only the applied
    // part reduces it. The advance is theirs, not a reduction of a debt.
    customer.balance = subtractMoney(customer.balance, applied).toFixed(4);
    await manager.save(customer);

    const lines = [
      {
        accountId: bank.id,
        description: `Receipt ${paymentNumber}${dto.reference ? ` · ${dto.reference}` : ''}`,
        debit: amount.toFixed(4),
        credit: '0',
        lineOrder: 0,
      },
    ];
    if (applied.greaterThan(MONEY_TOLERANCE)) {
      const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
      lines.push({
        accountId: ar.id,
        description: `Applied to ${appliedNumbers.join(', ')}`,
        debit: '0',
        credit: applied.toFixed(4),
        lineOrder: lines.length,
      });
    }
    if (unapplied.greaterThan(MONEY_TOLERANCE)) {
      const advances = await this.accounts.getOrCreateSystemAccount(
        manager,
        companyId,
        ACCT_CUSTOMER_ADVANCES,
      );
      lines.push({
        accountId: advances.id,
        description: 'Held as customer advance',
        debit: '0',
        credit: unapplied.toFixed(4),
        lineOrder: lines.length,
      });
    }

    const entry = await this.posting.createEntry(manager, {
      companyId,
      createdBy: userId,
      date: dto.paymentDate,
      memo: `Receipt ${paymentNumber} from ${customer.name}`,
      status: 'posted',
      sourceType: 'payment',
      sourceId: payment.id,
      lines,
    });
    payment.journalEntryId = entry.id;
    await manager.save(payment);

    return payment;
  }

  /**
   * Apply money a receipt is still holding to the customer's invoices — the
   * action that did not exist, and whose absence produced QA's duplicate
   * receipt. No cash moves:
   *
   *   Dr 2400 Customer Advances / Cr 1100 Accounts Receivable
   *
   * A receipt recorded before advances existed (advancePosted = false) already
   * credited its whole amount to 1100, so its remainder is a credit INSIDE A/R.
   * Applying that posts nothing: the ledger is already right, only the invoice
   * and its application change.
   */
  async apply(
    companyId: string,
    userId: string,
    paymentId: string,
    dto: ApplyPaymentDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const payment = await manager
        .createQueryBuilder(Payment, 'p')
        .setLock('pessimistic_write')
        .where('p.id = :id AND p.companyId = :companyId', { id: paymentId, companyId })
        .getOne();
      if (!payment) {
        throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' });
      }
      const existing = await manager.find(PaymentApplication, { where: { paymentId } });
      const alreadyApplied = existing.reduce(
        (sum, a) => sum.plus(toDecimal(a.amountApplied)),
        new Decimal(0),
      );
      const available = toDecimal(payment.amount).minus(alreadyApplied);

      const requested = dto.applications.reduce(
        (sum, a) => sum.plus(toDecimal(a.amount)),
        new Decimal(0),
      );
      for (const a of dto.applications) {
        if (!isPositive(toDecimal(a.amount))) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'Each amount applied must be positive',
          });
        }
      }
      if (requested.greaterThan(available.plus(MONEY_TOLERANCE))) {
        throw new BadRequestException({
          code: 'EXCEEDS_UNAPPLIED',
          message: `Only ${available.toFixed(2)} of ${payment.paymentNumber ?? 'this receipt'} is unapplied; ${requested.toFixed(2)} was requested.`,
          details: { unapplied: available.toFixed(4) },
        });
      }

      const date = dto.date ?? businessToday();
      assertNotFutureDate(date, 'Application date');
      if (date < payment.paymentDate) {
        throw new BadRequestException({
          code: 'APPLIED_BEFORE_RECEIPT',
          message: `Money cannot be applied before it was received (${payment.paymentDate}).`,
        });
      }

      const applications: PaymentApplication[] = [];
      const numbers: string[] = [];
      for (const a of dto.applications) {
        await this.assertInvoiceBelongsToCustomer(manager, companyId, a.invoiceId, payment.customerId);
        const invoice = await this.invoices.applyPayment(manager, companyId, a.invoiceId, a.amount);
        await this.syncDeliveryPaidStatus(manager, companyId, invoice);
        numbers.push(invoice.invoiceNumber);
        applications.push(
          manager.create(PaymentApplication, {
            paymentId: payment.id,
            invoiceId: a.invoiceId,
            amountApplied: toDecimal(a.amount).toFixed(4),
            appliedOn: date,
            journalEntryId: null,
          }),
        );
      }

      if (payment.advancePosted) {
        const customer = await manager.findOne(Customer, {
          where: { id: payment.customerId, companyId },
        });
        const advances = await this.accounts.getOrCreateSystemAccount(
          manager,
          companyId,
          ACCT_CUSTOMER_ADVANCES,
        );
        const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
        const total = requested.toFixed(4);
        const entry = await this.posting.createEntry(manager, {
          companyId,
          createdBy: userId,
          date,
          memo: `Advance from ${payment.paymentNumber ?? 'receipt'} applied to ${numbers.join(', ')}${customer ? ` — ${customer.name}` : ''}`,
          status: 'posted',
          sourceType: 'payment_application',
          sourceId: payment.id,
          lines: [
            { accountId: advances.id, description: 'Customer advance applied', debit: total, credit: '0', lineOrder: 0 },
            { accountId: ar.id, description: `Applied to ${numbers.join(', ')}`, debit: '0', credit: total, lineOrder: 1 },
          ],
        });
        for (const app of applications) app.journalEntryId = entry.id;
        if (customer) {
          customer.balance = subtractMoney(customer.balance, requested).toFixed(4);
          await manager.save(customer);
        }
      }
      await manager.save(applications);
    });
    return this.getById(companyId, paymentId);
  }

  /**
   * Refuse applying one customer's money to another customer's invoice. The
   * invoice lookup is company-scoped, but nothing checked the customer, so a
   * receipt could settle somebody else's debt.
   */
  private async assertInvoiceBelongsToCustomer(
    manager: EntityManager,
    companyId: string,
    invoiceId: string,
    customerId: string,
  ): Promise<void> {
    const invoice = await manager.findOne(Invoice, {
      where: { id: invoiceId, companyId },
      select: ['id', 'customerId', 'invoiceNumber'],
    });
    if (!invoice) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    }
    if (invoice.customerId !== customerId) {
      throw new BadRequestException({
        code: 'INVOICE_CUSTOMER_MISMATCH',
        message: `${invoice.invoiceNumber} belongs to a different customer.`,
      });
    }
  }

  /**
   * Keep a delivery's PAID / NOT PAID flag honest once its invoice is settled.
   *
   * A "NOT PAID" delivery approval raises an ordinary A/R invoice (Stage 3) and
   * leaves the delivery at paidStatus='unpaid'. Nothing used to tell the
   * delivery when the customer finally paid, so the approvals list showed a
   * settled sale as NOT PAID indefinitely — it reads delivery.paidStatus live.
   *
   * This posts NOTHING. Revenue and A/R were recognised at delivery approval,
   * and the payment itself posts Dr Bank / Cr A/R above. This is display state.
   *
   * Two constraints worth stating, because both are easy to break later:
   *
   *  - Only for a COMMITTED delivery. paidStatus is overloaded: it is also an
   *    INPUT to posting. DeliveryLedgerService.commitApproval reads it to
   *    decide whether approval books a cash receipt or leaves the invoice on
   *    A/R. Writing it before the ledger has committed could turn a credit sale
   *    into a phantom cash sale. Once committed the decision is frozen, so this
   *    can only ever be cosmetic. (commitApproval also calls us on the
   *    rider-collected-cash path — but that runs BEFORE it sets
   *    delivery.invoiceId, so the lookup finds nothing and we no-op. Keep that
   *    ordering if you touch either file.)
   *
   *  - There is no partial state. delivery.paid_status is varchar(8) holding
   *    'paid' | 'unpaid' | null. A partial payment writes nothing.
   */
  private async syncDeliveryPaidStatus(
    manager: EntityManager,
    companyId: string,
    invoice: Invoice,
  ): Promise<void> {
    const settled =
      invoice.status === 'paid' ||
      !isPositive(toDecimal(invoice.balance));
    if (!settled) return;

    const delivery = await manager.findOne(Delivery, {
      where: { invoiceId: invoice.id, companyId },
    });
    if (!delivery) return;
    if (delivery.ledgerStatus !== 'committed') return;
    if (delivery.paidStatus === 'paid') return;

    delivery.paidStatus = 'paid';
    await manager.save(delivery);
  }

  /**
   * The mirror, for a deleted payment: the invoice is open again, so the
   * delivery goes back to NOT PAID.
   *
   * Prepaid deliveries are excluded. Their 'paid' came from cash taken before
   * dispatch and released from Customer Advances at approval, not from this
   * payment — reverting it would contradict the advance still sitting in the
   * ledger, and leave the row reading prepaid=true / paidStatus='unpaid'.
   */
  private async revertDeliveryPaidStatus(
    manager: EntityManager,
    companyId: string,
    invoice: Invoice,
  ): Promise<void> {
    if (invoice.status === 'paid') return;

    const delivery = await manager.findOne(Delivery, {
      where: { invoiceId: invoice.id, companyId },
    });
    if (!delivery) return;
    if (delivery.ledgerStatus !== 'committed') return;
    if (delivery.prepaid) return;
    if (delivery.paidStatus === 'unpaid') return;

    delivery.paidStatus = 'unpaid';
    await manager.save(delivery);
  }

  /**
   * Delete a payment (QuickBooks "delete payment"): reverses everything
   * receive() and apply() did — un-applies the invoices, restores the
   * customer's balance, posts REVERSING journal entries — and then removes the
   * payment record. Blocked with TRANSACTION_RECONCILED when the payment's bank
   * GL row is part of a completed reconciliation.
   *
   * Each reversal mirrors the lines the original entry ACTUALLY posted. It used
   * to write a fixed Dr A/R / Cr Bank for the whole amount, which is only right
   * when every rupee was applied: a receipt that held an advance would have
   * pushed the advance into A/R instead of taking it back out of 2400.
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
      const today = businessToday();
      let applied = new Decimal(0);
      for (const app of payment.applications ?? []) {
        applied = applied.plus(toDecimal(app.amountApplied));
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
        // Mirror of syncDeliveryPaidStatus: the invoice is open again, so a
        // delivery that was settled by this payment goes back to NOT PAID.
        await this.revertDeliveryPaidStatus(manager, companyId, invoice);
      }

      // Restore the customer's balance. A receipt that posted its remainder to
      // advances reduced the balance only by what it applied; an older one
      // reduced it by its whole amount.
      const customer = await manager.findOne(Customer, {
        where: { id: payment.customerId, companyId },
      });
      if (customer) {
        const restore = payment.advancePosted ? applied : toDecimal(payment.amount);
        customer.balance = addMoney(customer.balance, restore).toFixed(4);
        await manager.save(customer);
      }

      const label = payment.paymentNumber ?? payment.reference ?? payment.id.slice(0, 8);
      if (payment.journalEntryId) {
        await this.postMirror(manager, companyId, userId, today, payment.journalEntryId, {
          memo: `Delete receipt ${label}`,
          sourceType: 'payment_void',
          sourceId: payment.id,
        });
      }
      const applicationEntries = [
        ...new Set(
          (payment.applications ?? [])
            .map((a) => a.journalEntryId)
            .filter((entryId): entryId is string => !!entryId),
        ),
      ];
      for (const entryId of applicationEntries) {
        await this.postMirror(manager, companyId, userId, today, entryId, {
          memo: `Delete receipt ${label} — reverse advance application`,
          sourceType: 'payment_application_void',
          sourceId: payment.id,
        });
      }

      if (payment.applications?.length) {
        await manager.remove(payment.applications);
      }
      await manager.remove(payment);
      return { id, deleted: true };
    });
  }

  /** Post an entry that swaps every debit and credit of `entryId`. */
  private async postMirror(
    manager: EntityManager,
    companyId: string,
    userId: string,
    date: string,
    entryId: string,
    meta: { memo: string; sourceType: string; sourceId: string },
  ): Promise<void> {
    const original = await manager.find(JournalEntryLine, {
      where: { entryId },
      order: { lineOrder: 'ASC' },
    });
    if (original.length === 0) return;
    await this.posting.createEntry(manager, {
      companyId,
      createdBy: userId,
      date,
      memo: meta.memo,
      status: 'posted',
      sourceType: meta.sourceType,
      sourceId: meta.sourceId,
      reversalOfId: entryId,
      lines: original.map((l, i) => ({
        accountId: l.accountId,
        description: l.description ?? undefined,
        debit: l.credit,
        credit: l.debit,
        lineOrder: i,
      })),
    });
  }

  private async autoApply(
    manager: EntityManager,
    companyId: string,
    customerId: string,
    amount: string,
  ): Promise<PaymentApplicationDto[]> {
    const outstanding = await this.invoices.outstandingForCustomer(companyId, customerId, manager);
    const apps: PaymentApplicationDto[] = [];
    let remaining = toDecimal(amount);
    for (const inv of outstanding) {
      if (!isPositive(remaining)) break;
      const bal = toDecimal(inv.balance);
      const apply = remaining.lessThan(bal) ? remaining : bal;
      apps.push({ invoiceId: inv.id, amount: apply.toFixed(4) });
      remaining = remaining.minus(apply);
    }
    // Whatever is left after the oldest-first sweep is held as a customer
    // advance (2400) by receiveInTransaction.
    return apps;
  }
}
