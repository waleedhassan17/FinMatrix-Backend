import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Payment } from '../payments/entities/payment.entity';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  StatementQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { subtractMoney, toDecimal } from '../../common/utils/money.util';
import { inPeriod, statementBalances } from '../../common/utils/statement.util';
import { applyTextSearch } from '../../common/utils/search-query.util';
import { GeocodingService } from '../deliveries/geocoding.service';
import { Address } from './entities/customer.entity';
import { assessCredit } from '../../common/utils/credit-control.util';

/**
 * App builds send `zipCode`; the canonical stored field is `postalCode`.
 * Normalized here (not via class-transformer) so the alias can never be
 * lost to decorator ordering.
 */
function normalizeAddress(
  addr?: { street?: string; city?: string; state?: string; postalCode?: string; zipCode?: string; country?: string } | null,
): Address | null {
  if (!addr) return null;
  const { zipCode, ...rest } = addr;
  return { ...rest, postalCode: rest.postalCode ?? zipCode };
}

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly geocoding: GeocodingService,
  ) {}

  async list(
    companyId: string,
    query: ListCustomersQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('c')
      .where('c.companyId = :companyId', { companyId });

    if (query.isActive !== undefined) {
      qb.andWhere('c.isActive = :a', { a: query.isActive });
    }
    applyTextSearch(qb, query.search, companyId, {
      columns: ['c.name', 'c.email', 'c.company', 'c.phone'],
    });
    qb.orderBy('c.createdAt', 'DESC')
      .take(pagination.limit)
      .skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();

    const totalsRaw = await this.repo
      .createQueryBuilder('c')
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(c.balance), 0)', 'outstanding')
      .where('c.companyId = :companyId', { companyId })
      .getRawOne<{ count: string; outstanding: string }>();

    // Nested under `data` so ResponseEnvelopeInterceptor (which lifts the
    // `data` key and drops siblings) preserves summary + pagination.
    return {
      data: {
        data,
        summary: {
          total: parseInt(totalsRaw?.count ?? '0', 10),
          outstandingBalance: toDecimal(totalsRaw?.outstanding ?? 0).toFixed(4),
        },
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
        },
      },
    };
  }

  async getById(companyId: string, id: string): Promise<Customer> {
    const c = await this.repo.findOne({ where: { id, companyId } });
    if (!c) {
      throw new NotFoundException({
        code: 'CUSTOMER_NOT_FOUND',
        message: 'Customer not found',
      });
    }
    return c;
  }

  async getByIdOrFail(
    companyId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<Customer> {
    const repo = manager ? manager.getRepository(Customer) : this.repo;
    const c = await repo.findOne({ where: { id, companyId } });
    if (!c) {
      throw new NotFoundException({
        code: 'CUSTOMER_NOT_FOUND',
        message: 'Customer not found',
      });
    }
    return c;
  }

  async detail(companyId: string, id: string) {
    const customer = await this.getById(companyId, id);
    const credit = await assessCredit(this.repo.manager, companyId, id, 0);
    const [invoices, payments, purchasesRaw] = await Promise.all([
      this.invoiceRepo.find({
        where: { companyId, customerId: id },
        order: { invoiceDate: 'DESC' },
        take: 5,
      }),
      this.paymentRepo.find({
        where: { companyId, customerId: id },
        order: { paymentDate: 'DESC' },
        take: 5,
      }),
      this.invoiceRepo
        .createQueryBuilder('i')
        .select('COALESCE(SUM(i.total), 0)', 'total')
        .where('i.companyId = :companyId AND i.customerId = :id', { companyId, id })
        .andWhere("i.status NOT IN ('draft', 'void')")
        .getRawOne<{ total: string }>(),
    ]);
    return {
      customer,
      totalPurchases: toDecimal(purchasesRaw?.total ?? 0).toFixed(4),
      recentInvoices: invoices,
      recentPayments: payments,
      // Exposure, not the stored balance: unpaid invoices plus goods shipped on
      // credit and not yet invoiced, less advances and credits — the same
      // figure a shipment or invoice is checked against.
      credit: {
        limit: customer.creditLimit,
        used: credit.exposure,
        exposure: credit.exposure,
        openInvoices: credit.openInvoices,
        inTransit: credit.inTransit,
        shippedNotInvoiced: credit.shippedNotInvoiced,
        advances: credit.advances,
        credits: credit.credits,
        limited: credit.limited,
        available: credit.limited
          ? subtractMoney(customer.creditLimit, credit.exposure).toFixed(4)
          : null,
      },
    };
  }

  async create(companyId: string, dto: CreateCustomerDto): Promise<Customer> {
    const billing = normalizeAddress(dto.billingAddress);
    const shipping =
      dto.shippingAddress?.sameAsBilling && billing
        ? billing
        : normalizeAddress(dto.shippingAddress);

    const entity = this.repo.create({
      companyId,
      name: dto.name,
      company: dto.company ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      billingAddress: billing,
      shippingAddress: shipping,
      creditLimit: dto.creditLimit ?? '0',
      paymentTerms: dto.paymentTerms ?? 'net30',
      balance: '0',
      isActive: true,
      notes: dto.notes ?? null,
      contactPerson: dto.contactPerson ?? null,
      taxId: dto.taxId ?? null,
    });
    await this.applyShippingGeocode(entity);
    return this.repo.save(entity);
  }

  /**
   * Geocode the shipping address (graceful — never blocks the save).
   * Deliveries fall back to these coordinates when their own geocode fails.
   */
  private async applyShippingGeocode(c: Customer): Promise<void> {
    const query = GeocodingService.formatAddress(c.shippingAddress ?? c.billingAddress);
    if (!query) {
      c.shippingLat = null;
      c.shippingLng = null;
      c.shippingGeocodedAt = null;
      return;
    }
    const point = await this.geocoding.geocode(query);
    if (point) {
      c.shippingLat = point.lat;
      c.shippingLng = point.lng;
      c.shippingGeocodedAt = new Date();
    }
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const c = await this.getById(companyId, id);
    const addressChanged =
      dto.shippingAddress !== undefined || dto.billingAddress !== undefined;
    if (dto.name !== undefined) c.name = dto.name;
    if (dto.company !== undefined) c.company = dto.company;
    if (dto.email !== undefined) c.email = dto.email;
    if (dto.phone !== undefined) c.phone = dto.phone;
    if (dto.billingAddress !== undefined) c.billingAddress = normalizeAddress(dto.billingAddress);
    if (dto.shippingAddress !== undefined) {
      c.shippingAddress = dto.shippingAddress?.sameAsBilling
        ? (normalizeAddress(dto.billingAddress) ?? c.billingAddress)
        : normalizeAddress(dto.shippingAddress);
    }
    if (dto.creditLimit !== undefined) c.creditLimit = dto.creditLimit;
    if (dto.paymentTerms !== undefined) c.paymentTerms = dto.paymentTerms;
    if (dto.notes !== undefined) c.notes = dto.notes;
    if (dto.isActive !== undefined) c.isActive = dto.isActive;
    if (dto.contactPerson !== undefined) c.contactPerson = dto.contactPerson;
    if (dto.taxId !== undefined) c.taxId = dto.taxId;
    if (addressChanged) await this.applyShippingGeocode(c);
    return this.repo.save(c);
  }

  async invoices(companyId: string, id: string, pagination: PaginationParams) {
    await this.getById(companyId, id);
    const [data, total] = await this.invoiceRepo.findAndCount({
      where: { companyId, customerId: id },
      order: { invoiceDate: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
    return {
      data: {
        data,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
        },
      },
    };
  }

  async payments(companyId: string, id: string, pagination: PaginationParams) {
    await this.getById(companyId, id);
    const [data, total] = await this.paymentRepo.findAndCount({
      where: { companyId, customerId: id },
      order: { paymentDate: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
    return {
      data: {
        data,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
        },
      },
    };
  }

  async delete(companyId: string, id: string) {
    const c = await this.getById(companyId, id);
    // softRemove was a silent no-op (no @DeleteDateColumn on the entity).
    // Deleting a customer with financial history would orphan invoices and
    // break AR — block it and point the admin at deactivation instead.
    const [invoiceCount, paymentCount] = await Promise.all([
      this.invoiceRepo.count({ where: { companyId, customerId: id } }),
      this.paymentRepo.count({ where: { companyId, customerId: id } }),
    ]);
    if (invoiceCount > 0 || paymentCount > 0 || !toDecimal(c.balance).isZero()) {
      throw new BadRequestException({
        code: 'CUSTOMER_HAS_ACTIVITY',
        message:
          'This customer has invoices, payments, or an outstanding balance and cannot be deleted. Deactivate the customer instead.',
      });
    }
    await this.repo.remove(c);
    return { id, deleted: true };
  }

  async toggleActive(companyId: string, id: string) {
    const c = await this.getById(companyId, id);
    c.isActive = !c.isActive;
    return this.repo.save(c);
  }

  /**
   * The customer's account over a period: every event that moved it, with the
   * balance before and after.
   *
   * What moves it: invoices — not drafts, which nobody owes yet, and not voided
   * ones, which never happened — payments, credit memos, and the cash refunds
   * of credit memos. Drafts and voids used to be counted and credit memos left
   * out, so a customer who had returned goods, or had an invoice cancelled, was
   * sent a statement saying they owed more than they did. The closing balance
   * is now what the customer really owes: open invoices, less payments not yet
   * applied and open credit memos.
   *
   * `invoices` and `payments` keep their shape for clients that read only
   * those; `creditMemos` and `refunds` are new beside them.
   */
  async statement(companyId: string, id: string, query: StatementQueryDto) {
    const customer = await this.getById(companyId, id);
    const { startDate, endDate } = query;
    const q = this.invoiceRepo.manager;

    const invoices = await this.invoiceRepo
      .createQueryBuilder('i')
      .where('i.companyId = :companyId AND i.customerId = :id', { companyId, id })
      .andWhere("i.status NOT IN ('draft', 'void')")
      .orderBy('i.invoiceDate', 'ASC')
      .addOrderBy('i.invoiceNumber', 'ASC')
      .getMany();
    const payments = await this.paymentRepo.find({
      where: { companyId, customerId: id },
      order: { paymentDate: 'ASC' },
    });
    const creditMemos: Array<{ id: string; creditMemoNumber: string | null; date: string; total: string; status: string }> =
      await q.query(
        `SELECT m.id, m.credit_memo_number AS "creditMemoNumber", m.date::text AS date,
                m.total::numeric AS total, m.status
           FROM credit_memos m
          WHERE m.company_id = $1 AND m.customer_id = $2 AND m.status NOT IN ('draft', 'void')
          ORDER BY m.date ASC, m.credit_memo_number ASC`,
        [companyId, id],
      );
    // A refund pays a credit back out in cash, so it puts the customer's
    // balance back up. The ledger holds it: A/R debited, dated the day it was
    // paid, against the memo it came from.
    const refunds: Array<{ id: string; creditMemoId: string; creditMemoNumber: string | null; date: string; amount: string }> =
      await q.query(
        `SELECT g.id, m.id AS "creditMemoId", m.credit_memo_number AS "creditMemoNumber",
                g.date::text AS date, g.debit::numeric AS amount
           FROM general_ledger g
           JOIN accounts a ON a.id = g.account_id
           JOIN credit_memos m ON m.id = g.source_id
          WHERE g.company_id = $1 AND m.customer_id = $2
            AND g.source_type = 'credit_memo_refund' AND a.account_number = '1100'
            AND g.debit > 0 AND m.status NOT IN ('draft', 'void')
          ORDER BY g.date ASC`,
        [companyId, id],
      );

    const { opening, closing } = statementBalances(
      [
        ...invoices.map((i) => ({ date: i.invoiceDate, amount: toDecimal(i.total) })),
        ...payments.map((p) => ({ date: p.paymentDate, amount: toDecimal(p.amount).negated() })),
        ...creditMemos.map((m) => ({ date: m.date, amount: toDecimal(m.total).negated() })),
        ...refunds.map((r) => ({ date: r.date, amount: toDecimal(r.amount) })),
      ],
      startDate,
      endDate,
    );

    const within = <T>(rows: T[], dateOf: (row: T) => string) =>
      rows.filter((row) => inPeriod(dateOf(row), startDate, endDate));
    const inRangeInvoices = within(invoices, (i) => i.invoiceDate);
    const inRangePayments = within(payments, (p) => p.paymentDate);
    const inRangeMemos = within(creditMemos, (m) => m.date);
    const inRangeRefunds = within(refunds, (r) => r.date);
    const sum = (values: Array<string | number>) =>
      values.reduce((acc: ReturnType<typeof toDecimal>, v) => acc.plus(toDecimal(v)), toDecimal(0));

    return {
      customer: { id: customer.id, name: customer.name, email: customer.email },
      period: { startDate, endDate },
      openingBalance: opening.toFixed(4),
      invoices: inRangeInvoices,
      payments: inRangePayments,
      creditMemos: inRangeMemos.map((m) => ({ ...m, total: toDecimal(m.total).toFixed(4) })),
      refunds: inRangeRefunds.map((r) => ({ ...r, amount: toDecimal(r.amount).toFixed(4) })),
      totals: {
        invoiced: sum(inRangeInvoices.map((i) => i.total)).toFixed(4),
        received: sum(inRangePayments.map((p) => p.amount)).toFixed(4),
        credited: sum(inRangeMemos.map((m) => m.total)).toFixed(4),
        refunded: sum(inRangeRefunds.map((r) => r.amount)).toFixed(4),
      },
      closingBalance: closing.toFixed(4),
    };
  }
}
