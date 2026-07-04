import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, Repository } from 'typeorm';
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
import { addMoney, subtractMoney, toDecimal } from '../../common/utils/money.util';
import { GeocodingService } from '../deliveries/geocoding.service';

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
    if (query.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('c.name ILIKE :s', { s: `%${query.search}%` })
            .orWhere('c.email ILIKE :s', { s: `%${query.search}%` })
            .orWhere('c.company ILIKE :s', { s: `%${query.search}%` });
        }),
      );
    }
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
      credit: {
        limit: customer.creditLimit,
        used: customer.balance,
        available: subtractMoney(customer.creditLimit, customer.balance).toFixed(4),
      },
    };
  }

  async create(companyId: string, dto: CreateCustomerDto): Promise<Customer> {
    const shipping =
      dto.shippingAddress?.sameAsBilling && dto.billingAddress
        ? dto.billingAddress
        : (dto.shippingAddress ?? null);

    const entity = this.repo.create({
      companyId,
      name: dto.name,
      company: dto.company ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      billingAddress: dto.billingAddress ?? null,
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
    if (dto.billingAddress !== undefined) c.billingAddress = dto.billingAddress;
    if (dto.shippingAddress !== undefined) {
      c.shippingAddress = dto.shippingAddress?.sameAsBilling
        ? (dto.billingAddress ?? c.billingAddress)
        : dto.shippingAddress;
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

  async statement(companyId: string, id: string, query: StatementQueryDto) {
    const customer = await this.getById(companyId, id);

    const openingInvoices = await this.invoiceRepo
      .createQueryBuilder('i')
      .select('COALESCE(SUM(i.total), 0)', 'total')
      .where('i.companyId = :companyId', { companyId })
      .andWhere('i.customerId = :id', { id })
      .andWhere('i.invoiceDate < :start', { start: query.startDate })
      .getRawOne<{ total: string }>();
    const openingPayments = await this.paymentRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'total')
      .where('p.companyId = :companyId', { companyId })
      .andWhere('p.customerId = :id', { id })
      .andWhere('p.paymentDate < :start', { start: query.startDate })
      .getRawOne<{ total: string }>();

    const openingBalance = subtractMoney(
      openingInvoices?.total ?? 0,
      openingPayments?.total ?? 0,
    ).toFixed(4);

    const invoices = await this.invoiceRepo.find({
      where: { companyId, customerId: id },
      order: { invoiceDate: 'ASC' },
    });
    const inRangeInvoices = invoices.filter(
      (i) => i.invoiceDate >= query.startDate && i.invoiceDate <= query.endDate,
    );
    const payments = await this.paymentRepo.find({
      where: { companyId, customerId: id },
      order: { paymentDate: 'ASC' },
    });
    const inRangePayments = payments.filter(
      (p) => p.paymentDate >= query.startDate && p.paymentDate <= query.endDate,
    );

    const invTotal = inRangeInvoices.reduce(
      (acc, i) => addMoney(acc, i.total),
      toDecimal(0),
    );
    const payTotal = inRangePayments.reduce(
      (acc, p) => addMoney(acc, p.amount),
      toDecimal(0),
    );
    const closingBalance = addMoney(openingBalance, invTotal)
      .minus(payTotal)
      .toFixed(4);

    return {
      customer: { id: customer.id, name: customer.name, email: customer.email },
      period: { startDate: query.startDate, endDate: query.endDate },
      openingBalance,
      invoices: inRangeInvoices,
      payments: inRangePayments,
      totals: {
        invoiced: invTotal.toFixed(4),
        received: payTotal.toFixed(4),
      },
      closingBalance,
    };
  }
}
