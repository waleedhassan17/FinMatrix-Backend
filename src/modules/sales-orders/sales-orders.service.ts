import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { SalesOrder, DiscountType, SalesOrderStatus } from './entities/sales-order.entity';
import { SalesOrderLineItem } from './entities/sales-order-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import {
  ConvertSalesOrderDto, CreateSalesOrderDto, FulfillSalesOrderDto, ListSalesOrdersQueryDto,
  SalesOrderLineDto, UpdateSalesOrderDto,
} from './dto/sales-order.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { nextDocumentNumber, yearOf } from '../../common/utils/sequence.util';
import { applyTextSearch } from '../../common/utils/search-query.util';
import { InvoicesService } from '../invoices/invoices.service';
import { addDaysIso, businessToday } from '../../common/utils/business-date.util';
import {
  assertSalesLinesClassified,
  backorderLines,
  lineKindOf,
  stockPositions,
} from '../../common/utils/sales-lines.util';
import {
  assessCredit,
  CreditOverride,
  enforceCreditLimit,
  grossValue,
} from '../../common/utils/credit-control.util';

/** Options for sales orders created by the system rather than typed by a user. */
export interface CreateSalesOrderOptions {
  /** A delivery's own order: its stock already left the shelf at dispatch. */
  skipStockChecks?: boolean;
  /** Approving a request filed before lines had to be classified. */
  treatFreeTextAsService?: boolean;
}

interface LineCalc {
  description: string; quantity: string; unitPrice: string; taxRate: string;
  taxAmount: string; lineTotal: string; accountId: string | null;
  itemId: string | null; lineOrder: number;
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
      // Named apart from the status's `:s`: one name holds one value per query.
      qb.andWhere('o.orderDate BETWEEN :startDate AND :endDate', { startDate: query.startDate, endDate: query.endDate });
    }
    applyTextSearch(qb, query.search, companyId, {
      columns: ['o.orderNumber', 'o.notes'],
      customerColumn: 'o.customerId',
    });
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

  /**
   * The order as the detail screen shows it: each stock line with its live
   * stock position — on hand, promised elsewhere, available — and how much of
   * it is on backorder.
   */
  async getDetail(companyId: string, id: string) {
    const so = await this.getById(companyId, id);
    const positions = await stockPositions(
      this.dataSource.manager,
      companyId,
      so.lines.map((l) => l.itemId).filter((x): x is string => !!x),
      { excludeSalesOrderId: so.id },
    );
    const open = so.status !== 'invoiced' && so.status !== 'cancelled';
    let hasBackorder = false;
    const lines = so.lines.map((l) => {
      const pos = l.itemId ? positions.get(l.itemId) : undefined;
      const stillToShip = Decimal.max(toDecimal(l.quantity).minus(toDecimal(l.quantityFulfilled)), 0);
      const backorderQty = pos && open
        ? Decimal.max(stillToShip.minus(Decimal.max(toDecimal(pos.available), 0)), 0)
        : new Decimal(0);
      if (backorderQty.greaterThan(0)) hasBackorder = true;
      return Object.assign(l, {
        lineKind: lineKindOf(l.itemId),
        stock: pos
          ? { onHand: pos.onHand, committed: pos.committed, available: pos.available, sku: pos.sku }
          : null,
        backorderQty: backorderQty.toFixed(4),
      });
    });
    return Object.assign(so, { lines, hasBackorder });
  }

  async create(
    companyId: string,
    userId: string,
    dto: CreateSalesOrderDto,
    sourceEstimateId: string | null = null,
    opts: CreateSalesOrderOptions = {},
  ): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) =>
      this.createInTransaction(manager, companyId, userId, dto, sourceEstimateId, opts),
    );
  }

  /**
   * Transaction-aware variant of create(): lets the delivery Stage-1 dispatch
   * create the (non-posting) Sales Order atomically with the Goods-in-Transit
   * posting and the stock reduction.
   */
  async createInTransaction(
    manager: EntityManager,
    companyId: string,
    userId: string,
    dto: CreateSalesOrderDto,
    sourceEstimateId: string | null = null,
    opts: CreateSalesOrderOptions = {},
  ): Promise<SalesOrder> {
    {
      const customer = await manager.findOne(Customer, { where: { id: dto.customerId, companyId } });
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
      await this.assertItemsBelongToCompany(manager, companyId, dto.lines);
      await assertSalesLinesClassified(manager, companyId, dto.lines, {
        treatFreeTextAsService: opts.treatFreeTextAsService,
      });
      if (!opts.skipStockChecks) {
        await this.assertBackorderAccepted(manager, companyId, dto.lines, dto.acceptBackorder, null);
      }

      const totals = this.computeTotals(dto.lines, dto.discountType, dto.discountValue);
      const orderNumber = await nextDocumentNumber(manager, companyId, 'SO', yearOf(dto.orderDate));

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
      if (!opts.skipStockChecks) {
        // Not a block: an order only promises goods. It warns early that
        // shipping all of it would take the customer past their credit limit.
        const creditCheck = await assessCredit(manager, companyId, order.customerId, order.total, {
          excludeSalesOrderId: order.id,
        });
        return Object.assign(order, { creditCheck });
      }
      return order;
    }
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

      if (dto.lines && order.lines.some((l) => toDecimal(l.quantityFulfilled).greaterThan(0))) {
        // Rebuilding the lines resets what has already been shipped to zero.
        throw new BadRequestException({
          code: 'SO_HAS_SHIPMENTS',
          message: 'Goods have already been shipped on this order, so its lines can no longer be changed.',
        });
      }

      if (dto.lines || dto.discountType !== undefined || dto.discountValue !== undefined) {
        if (dto.lines) {
          await this.assertItemsBelongToCompany(manager, companyId, dto.lines);
          await assertSalesLinesClassified(manager, companyId, dto.lines);
          await this.assertBackorderAccepted(manager, companyId, dto.lines, dto.acceptBackorder, order.id);
        }
        const nextLines = dto.lines ?? order.lines.map<SalesOrderLineDto>((l) => ({
          description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
          taxRate: l.taxRate, accountId: l.accountId ?? undefined,
          itemId: l.itemId ?? undefined,
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
          const newLines = totals.lines.map((l) => manager.create(SalesOrderLineItem, {
            salesOrderId: order.id, quantityFulfilled: '0', ...l,
          }));
          await manager.save(newLines);
          // See the same line in EstimatesService.update: the cascade on
          // `manager.save(order)` below would otherwise walk the rows just
          // deleted and null their FK, which is a 500.
          order.lines = newLines;
        }
      }
      await manager.save(order);
      const saved = (await manager.findOne(SalesOrder, { where: { id, companyId }, relations: { lines: true } }))!;
      const unshipped = saved.lines.reduce(
        (sum, l) => sum.plus(grossValue(Decimal.max(toDecimal(l.quantity).minus(toDecimal(l.quantityFulfilled)), 0), l.unitPrice, l.taxRate)),
        new Decimal(0),
      );
      const creditCheck = await assessCredit(manager, companyId, saved.customerId, unshipped, {});
      return Object.assign(saved, { creditCheck });
    });
  }

  async fulfill(
    companyId: string,
    id: string,
    dto: FulfillSalesOrderDto,
    creditOverride: CreditOverride | null = null,
  ): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(SalesOrder, { where: { id, companyId }, relations: { lines: true } });
      if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Sales order not found' });
      if (order.status === 'invoiced' || order.status === 'cancelled') {
        throw new BadRequestException({ code: 'CANNOT_FULFILL', message: `Cannot fulfill a ${order.status} sales order` });
      }
      await this.assertNotDeliveryOrder(manager, companyId, order.id);

      const byId = new Map(order.lines.map((l) => [l.id, l]));
      // Shipping is where "we don't have it" becomes a hard stop: an order may
      // be taken on backorder, but goods cannot leave that are not on the shelf.
      const shippingByItem = new Map<string, Decimal>();
      const updates: Array<{ line: SalesOrderLineItem; fulfilled: Decimal }> = [];
      let shippedValue = new Decimal(0);
      for (const f of dto.lines) {
        const line = byId.get(f.lineId);
        if (!line) throw new BadRequestException({ code: 'LINE_NOT_FOUND', message: `Line ${f.lineId} not found` });
        const fulfilled = toDecimal(f.quantityFulfilled);
        if (fulfilled.lessThan(0)) {
          throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Shipped quantity cannot be negative' });
        }
        if (fulfilled.greaterThan(toDecimal(line.quantity))) {
          throw new BadRequestException({ code: 'OVER_FULFILLED', message: 'Fulfilled quantity exceeds ordered quantity' });
        }
        const delta = fulfilled.minus(toDecimal(line.quantityFulfilled));
        if (line.itemId && delta.greaterThan(0)) {
          shippingByItem.set(line.itemId, (shippingByItem.get(line.itemId) ?? new Decimal(0)).plus(delta));
        }
        if (delta.greaterThan(0)) shippedValue = shippedValue.plus(grossValue(delta, line.unitPrice, line.taxRate));
        updates.push({ line, fulfilled });
      }
      // Goods leaving on credit: the customer's credit limit is checked here,
      // before anything is recorded as shipped.
      if (shippedValue.greaterThan(0)) {
        await enforceCreditLimit(manager, companyId, order.customerId, shippedValue, {
          action: 'sales_order_shipment',
          targetType: 'sales_order',
          targetId: order.id,
          override: creditOverride,
        });
      }
      if (shippingByItem.size > 0) {
        const positions = await stockPositions(manager, companyId, [...shippingByItem.keys()]);
        for (const [itemId, qty] of shippingByItem) {
          const pos = positions.get(itemId);
          if (pos && qty.greaterThan(toDecimal(pos.onHand))) {
            throw new UnprocessableEntityException({
              code: 'INSUFFICIENT_STOCK',
              message: `Cannot ship ${qty.toFixed(0)} x ${pos.name}: only ${toDecimal(pos.onHand).toFixed(0)} on hand.`,
            });
          }
        }
      }
      for (const u of updates) {
        u.line.quantityFulfilled = u.fulfilled.toFixed(4);
        await manager.save(u.line);
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

  /**
   * What converting this order would invoice, without posting anything. A
   * staff member's conversion is filed as an invoice approval carrying this,
   * so the owner reviews the actual lines and amounts before it posts.
   */
  async conversionPayload(companyId: string, id: string, dto: ConvertSalesOrderDto) {
    const order = await this.getById(companyId, id);
    if (order.status === 'invoiced') {
      throw new BadRequestException({ code: 'ALREADY_INVOICED', message: 'Sales order already invoiced' });
    }
    if (order.status === 'cancelled') {
      throw new BadRequestException({ code: 'ORDER_CANCELLED', message: 'Cancelled sales orders cannot be invoiced' });
    }
    await this.assertNotDeliveryOrder(this.dataSource.manager, companyId, order.id);
    return {
      orderNumber: order.orderNumber,
      payload: {
        sourceSalesOrderId: order.id,
        customerId: order.customerId,
        invoiceDate: businessToday(),
        dueDate: dto.dueDate ?? addDaysIso(businessToday(), 30),
        discountType: order.discountType,
        discountValue: order.discountValue,
        notes: `Converted from sales order ${order.orderNumber}`,
        lines: order.lines.map((l) => ({
          description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
          taxRate: l.taxRate, itemId: l.itemId ?? undefined, lineKind: lineKindOf(l.itemId),
        })),
      },
    };
  }

  async convertToInvoice(
    companyId: string,
    userId: string,
    id: string,
    dto: ConvertSalesOrderDto,
    creditOverride: CreditOverride | null = null,
  ) {
    // One transaction with the order row locked: converting twice at once (a
    // double tap) used to raise two invoices for one order.
    const invoice = await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(SalesOrder, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id AND o.companyId = :companyId', { id, companyId })
        .getOne();
      if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Sales order not found' });
      if (order.status === 'invoiced') {
        throw new BadRequestException({ code: 'ALREADY_INVOICED', message: 'Sales order already invoiced' });
      }
      if (order.status === 'cancelled') {
        throw new BadRequestException({ code: 'ORDER_CANCELLED', message: 'Cancelled sales orders cannot be invoiced' });
      }
      await this.assertNotDeliveryOrder(manager, companyId, order.id);
      const lines = await manager.find(SalesOrderLineItem, {
        where: { salesOrderId: order.id },
        order: { lineOrder: 'ASC' },
      });
      const today = businessToday();
      const created = await this.invoices.createInTransaction(
        manager,
        companyId,
        userId,
        {
          customerId: order.customerId,
          invoiceDate: today,
          dueDate: dto.dueDate ?? addDaysIso(today, 30),
          discountType: order.discountType,
          discountValue: order.discountValue,
          status: 'sent',
          notes: `Converted from sales order ${order.orderNumber}`,
          // itemId rides along: the invoice is created as 'sent', so it posts,
          // and posting is where the ordered item finally means something --
          // Dr COGS / Cr Inventory and a stock movement per line. Conversion is
          // refused (INSUFFICIENT_STOCK) when the stock is not there.
          lines: lines.map((l) => ({
            description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
            taxRate: l.taxRate, accountId: l.accountId ?? undefined,
            itemId: l.itemId ?? undefined,
            lineKind: lineKindOf(l.itemId),
          })),
        },
        // This order's shipped value is already part of the customer's
        // exposure; it becomes the invoice rather than adding to it.
        { credit: { excludeSalesOrderId: order.id, override: creditOverride } },
      );
      order.status = 'invoiced';
      order.invoiceId = created.id;
      await manager.save(order);
      return created;
    });
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

  /**
   * A delivery creates its own sales order and settles it: stock leaves at
   * dispatch and the invoice is raised when the delivery is approved. Shipping
   * or invoicing that order by hand as well would move the stock twice and
   * book the revenue twice.
   */
  private async assertNotDeliveryOrder(manager: EntityManager, companyId: string, orderId: string): Promise<void> {
    const delivery = await manager.findOne(Delivery, { where: { companyId, salesOrderId: orderId } });
    if (delivery) {
      throw new BadRequestException({
        code: 'SO_MANAGED_BY_DELIVERY',
        message: `This order belongs to delivery ${delivery.referenceNo ?? delivery.id}. It is shipped and invoiced through that delivery.`,
      });
    }
  }

  /**
   * An order may ask for more than is available — that is a backorder, and
   * wholesale runs on them — but it has to be a deliberate choice. Without
   * acceptBackorder the request answers 409 with the short items, so the client
   * can show them and ask.
   */
  private async assertBackorderAccepted(
    manager: EntityManager,
    companyId: string,
    lines: SalesOrderLineDto[],
    accepted: boolean | undefined,
    excludeSalesOrderId: string | null,
  ): Promise<void> {
    if (accepted) return;
    const short = await backorderLines(manager, companyId, lines, { excludeSalesOrderId });
    if (short.length === 0) return;
    throw new ConflictException({
      code: 'BACKORDER_CONFIRMATION_REQUIRED',
      message:
        `Not enough stock for ${short.map((s) => s.name).join(', ')}. ` +
        'Confirm to save the order with the shortfall on backorder.',
      details: { lines: short },
    });
  }

  /**
   * Refuse a line pointing at an item that is not this company's.
   *
   * Mirrors EstimatesService.assertItemsBelongToCompany -- see the reasoning
   * there. Short version: the invoice can skip this because it spends its
   * itemId in the same request, while an order's sits inert until conversion
   * and would otherwise fail as an invoice that quietly posts no COGS.
   */
  private async assertItemsBelongToCompany(
    manager: EntityManager,
    companyId: string,
    lines: { itemId?: string }[],
  ): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.itemId).filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    const found = await manager.getRepository(InventoryItem).find({
      where: { id: In(ids), companyId },
      select: ['id'],
    });
    if (found.length !== ids.length) {
      throw new BadRequestException({
        code: 'ITEM_NOT_FOUND',
        message: 'One or more line items reference an inventory item that does not exist',
      });
    }
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
        accountId: l.accountId ?? null, itemId: l.itemId ?? null, lineOrder: i,
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
