import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { SalesOrder, DiscountType, SalesOrderStatus } from './entities/sales-order.entity';
import { SalesOrderLineItem } from './entities/sales-order-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import {
  ConvertSalesOrderDto, CreateSalesOrderDto, FulfillSalesOrderDto, ListSalesOrdersQueryDto,
  SalesOrderLineDto, UpdateSalesOrderDto,
} from './dto/sales-order.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { formatSalesOrderRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { InvoicesService } from '../invoices/invoices.service';

interface LineCalc {
  description: string; quantity: string; unitPrice: string; taxRate: string;
  taxAmount: string; lineTotal: string; accountId: string | null; lineOrder: number;
}

@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly invoices: InvoicesService,
    @InjectRepository(SalesOrder) private readonly repo: Repository<SalesOrder>,
    @InjectRepository(SalesOrderLineItem) private readonly lineRepo: Repository<SalesOrderLineItem>,
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
  ) {}

  async list(companyId: string, query: ListSalesOrdersQueryDto, pagination: PaginationParams) {
    const qb = this.repo.createQueryBuilder('o').where('o.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('o.status = :s', { s: query.status });
    if (query.customerId) qb.andWhere('o.customerId = :c', { c: query.customerId });
    if (query.startDate && query.endDate) {
      qb.andWhere('o.orderDate BETWEEN :s AND :e', { s: query.startDate, e: query.endDate });
    }
    if (query.search) {
      qb.andWhere(new Brackets((w) => {
        w.where('o.orderNumber ILIKE :s', { s: `%${query.search}%` })
          .orWhere('o.notes ILIKE :s', { s: `%${query.search}%` });
      }));
    }
    qb.orderBy('o.orderDate', 'DESC').addOrderBy('o.createdAt', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();
    const customerIds = [...new Set(data.map((o) => o.customerId).filter(Boolean))];
    const customers = customerIds.length ? await this.customerRepo.findByIds(customerIds) : [];
    const nameMap = Object.fromEntries(customers.map((c) => [c.id, c.name]));

    const statusCounts = await this.repo.createQueryBuilder('o')
      .select('o.status', 'status').addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(o.total), 0)', 'total')
      .where('o.companyId = :companyId', { companyId }).groupBy('o.status').getRawMany();

    return {
      data: data.map((o) => ({ ...o, customerName: nameMap[o.customerId] ?? '' })),
      summary: Object.fromEntries(statusCounts.map((r) => [r.status, {
        count: parseInt(r.count, 10), total: toDecimal(r.total).toFixed(4),
      }])),
      pagination: {
        page: pagination.page, limit: pagination.limit, total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string): Promise<SalesOrder> {
    const so = await this.repo.findOne({ where: { id, companyId }, relations: { lines: true } });
    if (!so) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Sales order not found' });
    so.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return so;
  }

  async create(
    companyId: string,
    userId: string,
    dto: CreateSalesOrderDto,
    sourceEstimateId: string | null = null,
  ): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      const customer = await manager.findOne(Customer, { where: { id: dto.customerId, companyId } });
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });

      const totals = this.computeTotals(dto.lines, dto.discountType, dto.discountValue);
      const year = parseInt(dto.orderDate.slice(0, 4), 10);
      const seq = await nextYearlySequence(manager, 'sales_orders', companyId, year, 'order_date', 'SO', 'order_number');
      const orderNumber = formatSalesOrderRef(year, seq);

      const order = manager.create(SalesOrder, {
        companyId,
        customerId: dto.customerId,
        orderNumber,
        orderDate: dto.orderDate,
        expectedDate: dto.expectedDate ?? null,
        subtotal: totals.subtotal,
        discountType: (dto.discountType ?? 'none') as DiscountType,
        discountValue: dto.discountValue ?? '0',
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        status: 'open' as SalesOrderStatus,
        notes: dto.notes ?? null,
        sourceEstimateId,
        invoiceId: null,
        createdBy: userId,
      });
      await manager.save(order);

      const lines = totals.lines.map((l) => manager.create(SalesOrderLineItem, {
        salesOrderId: order.id, quantityFulfilled: '0', ...l,
      }));
      await manager.save(lines);
      order.lines = lines;
      return order;
    });
  }

  async update(companyId: string, id: string, dto: UpdateSalesOrderDto): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(SalesOrder, { where: { id, companyId }, relations: { lines: true } });
      if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Sales order not found' });
      if (order.status === 'invoiced' || order.status === 'cancelled') {
        throw new BadRequestException({ code: 'CANNOT_EDIT', message: `Cannot edit a ${order.status} sales order` });
      }

      if (dto.orderDate !== undefined) order.orderDate = dto.orderDate;
      if (dto.expectedDate !== undefined) order.expectedDate = dto.expectedDate;
      if (dto.notes !== undefined) order.notes = dto.notes;

      if (dto.lines || dto.discountType !== undefined || dto.discountValue !== undefined) {
        const nextLines = dto.lines ?? order.lines.map<SalesOrderLineDto>((l) => ({
          description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
          taxRate: l.taxRate, accountId: l.accountId ?? undefined,
        }));
        const dType = dto.discountType ?? order.discountType;
        const dValue = dto.discountValue ?? order.discountValue;
        const totals = this.computeTotals(nextLines, dType, dValue);
        order.discountType = dType;
        order.discountValue = dValue;
        order.discountAmount = totals.discountAmount;
        order.taxAmount = totals.taxAmount;
        order.subtotal = totals.subtotal;
        order.total = totals.total;
        if (dto.lines) {
          await manager.delete(SalesOrderLineItem, { salesOrderId: order.id });
          await manager.save(totals.lines.map((l) => manager.create(SalesOrderLineItem, {
            salesOrderId: order.id, quantityFulfilled: '0', ...l,
          })));
        }
      }
      await manager.save(order);
      return (await manager.findOne(SalesOrder, { where: { id, companyId }, relations: { lines: true } }))!;
    });
  }

  async fulfill(companyId: string, id: string, dto: FulfillSalesOrderDto): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(SalesOrder, { where: { id, companyId }, relations: { lines: true } });
      if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Sales order not found' });
      if (order.status === 'invoiced' || order.status === 'cancelled') {
        throw new BadRequestException({ code: 'CANNOT_FULFILL', message: `Cannot fulfill a ${order.status} sales order` });
      }

      const byId = new Map(order.lines.map((l) => [l.id, l]));
      for (const f of dto.lines) {
        const line = byId.get(f.lineId);
        if (!line) throw new BadRequestException({ code: 'LINE_NOT_FOUND', message: `Line ${f.lineId} not found` });
        const fulfilled = toDecimal(f.quantityFulfilled);
        if (fulfilled.greaterThan(toDecimal(line.quantity))) {
          throw new BadRequestException({ code: 'OVER_FULFILLED', message: 'Fulfilled quantity exceeds ordered quantity' });
        }
        line.quantityFulfilled = fulfilled.toFixed(4);
        await manager.save(line);
      }

      // Recompute status from fulfillment progress.
      const fresh = await manager.find(SalesOrderLineItem, { where: { salesOrderId: order.id } });
      const allFull = fresh.every((l) => toDecimal(l.quantityFulfilled).greaterThanOrEqualTo(toDecimal(l.quantity)));
      const anyFull = fresh.some((l) => toDecimal(l.quantityFulfilled).greaterThan(0));
      order.status = allFull ? 'fulfilled' : anyFull ? 'partial' : 'open';
      await manager.save(order);
      return (await manager.findOne(SalesOrder, { where: { id, companyId }, relations: { lines: true } }))!;
    });
  }

  async convertToInvoice(companyId: string, userId: string, id: string, dto: ConvertSalesOrderDto) {
    const order = await this.getById(companyId, id);
    if (order.status === 'invoiced') {
      throw new BadRequestException({ code: 'ALREADY_INVOICED', message: 'Sales order already invoiced' });
    }
    if (order.status === 'cancelled') {
      throw new BadRequestException({ code: 'ORDER_CANCELLED', message: 'Cancelled sales orders cannot be invoiced' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const due = dto.dueDate ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const invoice = await this.invoices.create(companyId, userId, {
      customerId: order.customerId,
      invoiceDate: today,
      dueDate: due,
      discountType: order.discountType,
      discountValue: order.discountValue,
      status: 'sent',
      notes: `Converted from sales order ${order.orderNumber}`,
      lines: order.lines.map((l) => ({
        description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        taxRate: l.taxRate, accountId: l.accountId ?? undefined,
      })),
    });
    order.status = 'invoiced';
    order.invoiceId = invoice.id;
    await this.repo.save(order);
    return { salesOrder: await this.getById(companyId, id), invoice };
  }

  async cancel(companyId: string, id: string): Promise<SalesOrder> {
    const order = await this.getById(companyId, id);
    if (order.status === 'invoiced') {
      throw new BadRequestException({ code: 'ALREADY_INVOICED', message: 'Invoiced sales orders cannot be cancelled' });
    }
    order.status = 'cancelled';
    await this.repo.save(order);
    return order;
  }

  async delete(companyId: string, id: string) {
    const order = await this.getById(companyId, id);
    if (order.status === 'invoiced') {
      throw new BadRequestException({ code: 'CANNOT_DELETE', message: 'Invoiced sales orders cannot be deleted' });
    }
    await this.repo.remove(order);
    return { id, deleted: true };
  }

  private computeTotals(
    lines: SalesOrderLineDto[],
    discountType: 'percent' | 'amount' | 'none' | undefined,
    discountValue: string | undefined,
  ): { subtotal: string; discountAmount: string; taxAmount: string; total: string; lines: LineCalc[] } {
    const calc: LineCalc[] = [];
    let subtotal = new Decimal(0);
    let taxTotal = new Decimal(0);
    lines.forEach((l, i) => {
      const qty = toDecimal(l.quantity);
      const price = toDecimal(l.unitPrice);
      const taxRate = toDecimal(l.taxRate ?? '0');
      const base = qty.times(price);
      const tax = base.times(taxRate).dividedBy(100);
      subtotal = subtotal.plus(base);
      taxTotal = taxTotal.plus(tax);
      calc.push({
        description: l.description, quantity: qty.toFixed(4), unitPrice: price.toFixed(4),
        taxRate: taxRate.toFixed(4), taxAmount: tax.toFixed(4), lineTotal: base.plus(tax).toFixed(4),
        accountId: l.accountId ?? null, lineOrder: i,
      });
    });
    let discountAmount = new Decimal(0);
    if (discountType === 'percent') discountAmount = subtotal.times(toDecimal(discountValue ?? 0)).dividedBy(100);
    else if (discountType === 'amount') discountAmount = toDecimal(discountValue ?? 0);
    if (discountAmount.greaterThan(subtotal)) discountAmount = subtotal;
    const total = subtotal.minus(discountAmount).plus(taxTotal);
    return {
      subtotal: subtotal.toFixed(4), discountAmount: discountAmount.toFixed(4),
      taxAmount: taxTotal.toFixed(4), total: total.toFixed(4), lines: calc,
    };
  }
}
