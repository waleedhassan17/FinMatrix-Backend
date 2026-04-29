import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { SalesOrder } from './entities/sales-order.entity';
import { SalesOrderLine } from './entities/sales-order-line.entity';
import {
  CreateSalesOrderDto,
  FulfillOrderDto,
  ListSalesOrdersQueryDto,
} from './dto/sales-order.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { formatSalesOrderRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { InvoicesService } from '../invoices/invoices.service';
import { SalesOrderStatus } from '../../types';

@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly invoices: InvoicesService,
    @InjectRepository(SalesOrder)
    private readonly repo: Repository<SalesOrder>,
  ) {}

  async list(
    companyId: string,
    query: ListSalesOrdersQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('o')
      .where('o.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('o.status = :s', { s: query.status });
    if (query.customerId) qb.andWhere('o.customerId = :c', { c: query.customerId });
    qb.orderBy('o.orderDate', 'DESC');
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

  async getById(companyId: string, id: string): Promise<SalesOrder> {
    const o = await this.repo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!o) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
    }
    o.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return o;
  }

  async create(companyId: string, dto: CreateSalesOrderDto): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      let subtotal = new Decimal(0);
      let tax = new Decimal(0);
      const calc = dto.lines.map((l, i) => {
        const qty = toDecimal(l.orderedQty);
        const price = toDecimal(l.unitPrice);
        const rate = toDecimal(l.taxRate ?? '0');
        const base = qty.times(price);
        const t = base.times(rate).dividedBy(100);
        subtotal = subtotal.plus(base);
        tax = tax.plus(t);
        return {
          description: l.description,
          orderedQty: qty.toFixed(4),
          fulfilledQty: '0',
          unitPrice: price.toFixed(4),
          taxRate: rate.toFixed(4),
          lineTotal: base.plus(t).toFixed(4),
          itemId: l.itemId ?? null,
          lineOrder: i,
        };
      });
      const total = subtotal.plus(tax);

      const year = parseInt(dto.orderDate.slice(0, 4), 10);
      const seq = await nextYearlySequence(
        manager,
        'sales_orders',
        companyId,
        year,
        'order_date',
        'SO',
        'order_number',
      );
      const order = manager.create(SalesOrder, {
        companyId,
        customerId: dto.customerId,
        orderNumber: formatSalesOrderRef(year, seq),
        orderDate: dto.orderDate,
        expectedDate: dto.expectedDate ?? null,
        subtotal: subtotal.toFixed(4),
        taxAmount: tax.toFixed(4),
        total: total.toFixed(4),
        status: 'draft',
        notes: dto.notes ?? null,
      });
      await manager.save(order);
      const lines = calc.map((l) =>
        manager.create(SalesOrderLine, { ...l, orderId: order.id }),
      );
      await manager.save(lines);
      order.lines = lines;
      return order;
    });
  }

  async fulfill(
    companyId: string,
    id: string,
    dto: FulfillOrderDto,
  ): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(SalesOrder, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!order) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
      }
      const lineMap = new Map(order.lines.map((l) => [l.id, l]));
      for (const fl of dto.lines) {
        const line = lineMap.get(fl.lineId);
        if (!line) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Line ${fl.lineId} not found on this order`,
          });
        }
        const newQty = toDecimal(fl.fulfilledQty);
        if (newQty.greaterThan(toDecimal(line.orderedQty))) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Cannot fulfill more than ordered (${line.orderedQty})`,
          });
        }
        line.fulfilledQty = newQty.toFixed(4);
        await manager.save(line);
      }
      order.status = this.deriveStatus(order.lines);
      await manager.save(order);
      return order;
    });
  }

  async createInvoice(
    companyId: string,
    userId: string,
    id: string,
  ): Promise<{ order: SalesOrder; invoiceId: string }> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(SalesOrder, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!order) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
      }
      const fulfilledLines = order.lines.filter((l) =>
        toDecimal(l.fulfilledQty).greaterThan(0),
      );
      if (fulfilledLines.length === 0) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Nothing to invoice — no fulfilled quantities',
        });
      }

      const today = new Date().toISOString().slice(0, 10);
      const due = new Date();
      due.setDate(due.getDate() + 30);

      const invoice = await this.invoices.create(companyId, userId, {
        customerId: order.customerId,
        invoiceDate: today,
        dueDate: due.toISOString().slice(0, 10),
        status: 'sent',
        notes: `Created from sales order ${order.orderNumber}`,
        lines: fulfilledLines.map((l) => ({
          description: l.description,
          quantity: l.fulfilledQty,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
        })),
      });

      order.status = this.deriveStatus(order.lines);
      await manager.save(order);
      return { order, invoiceId: invoice.id };
    });
  }

  async update(companyId: string, id: string, dto: CreateSalesOrderDto): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(SalesOrder, { where: { id, companyId }, relations: { lines: true } });
      if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
      if (dto.orderDate !== undefined) order.orderDate = dto.orderDate;
      if (dto.expectedDate !== undefined) order.expectedDate = dto.expectedDate;
      if (dto.notes !== undefined) order.notes = dto.notes;
      if (dto.lines) {
        let subtotal = new Decimal(0);
        let tax = new Decimal(0);
        const calc = dto.lines.map((l, i) => {
          const qty = toDecimal(l.orderedQty);
          const price = toDecimal(l.unitPrice);
          const rate = toDecimal(l.taxRate ?? '0');
          const base = qty.times(price);
          const t = base.times(rate).dividedBy(100);
          subtotal = subtotal.plus(base);
          tax = tax.plus(t);
          return { description: l.description, orderedQty: qty.toFixed(4), fulfilledQty: '0', unitPrice: price.toFixed(4), taxRate: rate.toFixed(4), lineTotal: base.plus(t).toFixed(4), itemId: l.itemId ?? null, lineOrder: i };
        });
        const total = subtotal.plus(tax);
        order.subtotal = subtotal.toFixed(4);
        order.taxAmount = tax.toFixed(4);
        order.total = total.toFixed(4);
        await manager.delete(SalesOrderLine, { orderId: order.id });
        const lines = calc.map((l) => manager.create(SalesOrderLine, { ...l, orderId: order.id }));
        await manager.save(lines);
        order.lines = lines;
      }
      await manager.save(order);
      return this.getById(companyId, id);
    });
  }

  async delete(companyId: string, id: string) {
    const o = await this.getById(companyId, id);
    await this.repo.softRemove(o);
    return { id, deleted: true };
  }

  async send(companyId: string, id: string): Promise<SalesOrder> {
    const o = await this.getById(companyId, id);
    if (o.status === 'draft') o.status = 'open';
    return this.repo.save(o);
  }

  private deriveStatus(lines: SalesOrderLine[]): SalesOrderStatus {
    let allFulfilled = true;
    let anyFulfilled = false;
    for (const l of lines) {
      const ord = toDecimal(l.orderedQty);
      const ful = toDecimal(l.fulfilledQty);
      if (ful.greaterThan(0)) anyFulfilled = true;
      if (ful.lessThan(ord)) allFulfilled = false;
    }
    if (allFulfilled) return 'fulfilled';
    if (anyFulfilled) return 'partial';
    return 'open';
  }
}
