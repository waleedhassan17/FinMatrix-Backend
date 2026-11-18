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
import {
  SalesOrder,
  DiscountType,
  SalesOrderStatus,
} from './entities/sales-order.entity';
import { SalesOrderLineItem } from './entities/sales-order-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import {
  CloseSalesOrderDto,
  ConvertSalesOrderDto,
  CreateSalesOrderDto,
  FulfillSalesOrderDto,
  ListSalesOrdersQueryDto,
  SalesOrderLineDto,
  UpdateSalesOrderDto,
} from './dto/sales-order.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { nextDocumentNumber, yearOf } from '../../common/utils/sequence.util';
import { applyTextSearch } from '../../common/utils/search-query.util';
import { InvoicesService } from '../invoices/invoices.service';
import {
  addDaysIso,
  businessToday,
} from '../../common/utils/business-date.util';
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
import {
  pagedResponse,
  statusSummary,
} from '../../common/utils/paged-response.util';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { liveInvoiceDiscount, lockSalesOrder } from './sales-order-invoicing';
import {
  ApprovedConversion,
  billedNotShippedQty,
  deriveSalesOrderStatus,
  hasAnyInvoiced,
  hasAnyShipped,
  hasShippedUninvoiced,
  InvoicePlan,
  invoiceableQty,
  isUntouched,
  planSalesOrderInvoice,
  shipmentChange,
  toShipQty,
  validateApprovedConversion,
} from './sales-order-status.util';

/** Statuses an order is still being worked under (shipping or invoicing). */
const OPEN_STATUSES: SalesOrderStatus[] = ['open', 'partial', 'fulfilled'];

function appendNote(notes: string | null, line: string): string {
  return notes ? `${notes}\n${line}` : line;
}

/** Options for sales orders created by the system rather than typed by a user. */
export interface CreateSalesOrderOptions {
  /** A delivery's own order: its stock already left the shelf at dispatch. */
  skipStockChecks?: boolean;
  /** Approving a request filed before lines had to be classified. */
  treatFreeTextAsService?: boolean;
}

interface LineCalc {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  accountId: string | null;
  itemId: string | null;
  lineOrder: number;
}

@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly invoices: InvoicesService,
    @InjectRepository(SalesOrder) private readonly repo: Repository<SalesOrder>,
    @InjectRepository(SalesOrderLineItem)
    private readonly lineRepo: Repository<SalesOrderLineItem>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
    private readonly audit: OperationalAuditService,
  ) {}

  async list(
    companyId: string,
    query: ListSalesOrdersQueryDto,
    pagination: PaginationParams,
  ) {
    // Everything but the status tab: the summary counts every tab of these.
    const filtered = () => {
      const qb = this.repo
        .createQueryBuilder('o')
        .where('o.companyId = :companyId', { companyId });
      if (query.customerId)
        qb.andWhere('o.customerId = :c', { c: query.customerId });
      if (query.startDate && query.endDate) {
        // Named apart from the status's `:s`: one name holds one value per query.
        qb.andWhere('o.orderDate BETWEEN :startDate AND :endDate', {
          startDate: query.startDate,
          endDate: query.endDate,
        });
      }
      applyTextSearch(qb, query.search, companyId, {
        columns: ['o.orderNumber', 'o.notes'],
        customerColumn: 'o.customerId',
      });
      return qb;
    };
    const qb = filtered();
    if (query.status) qb.andWhere('o.status = :s', { s: query.status });
    qb.orderBy('o.orderDate', 'DESC').addOrderBy('o.createdAt', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();
    const customerIds = [
      ...new Set(data.map((o) => o.customerId).filter(Boolean)),
    ];
    const customers = customerIds.length
      ? await this.customerRepo.findByIds(customerIds)
      : [];
    const nameMap = Object.fromEntries(customers.map((c) => [c.id, c.name]));

    // Over everything the search matches — the tabs' counts — not the page.
    const summary = await statusSummary(filtered(), 'o', { total: 'o.total' });

    // pagedResponse: the envelope used to drop the summary and pagination.
    return pagedResponse(
      data.map((o) => ({ ...o, customerName: nameMap[o.customerId] ?? '' })),
      { page: pagination.page, limit: pagination.limit, total },
      summary,
    );
  }

  async getById(companyId: string, id: string): Promise<SalesOrder> {
    const so = await this.repo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!so)
      throw new NotFoundException({
        code: 'SALES_ORDER_NOT_FOUND',
        message: 'Sales order not found',
      });
    so.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return so;
  }

  /**
   * The order as the detail screen shows it: each line with what has shipped,
   * been invoiced and is left, each stock line's live stock position and
   * backorder, the invoices raised from it, what the next invoice would bill,
   * and which actions apply now (so web and mobile cannot disagree).
   */
  async getDetail(companyId: string, id: string) {
    const so = await this.getById(companyId, id);
    const manager = this.dataSource.manager;
    const delivery = await manager.findOne(Delivery, {
      where: { companyId, salesOrderId: so.id },
      select: ['id', 'referenceNo'],
    });
    const managed = !!delivery;
    const positions = await stockPositions(
      manager,
      companyId,
      so.lines.map((l) => l.itemId).filter((x): x is string => !!x),
      { excludeSalesOrderId: so.id },
    );
    const open = OPEN_STATUSES.includes(so.status);
    const shippable =
      !managed && so.status !== 'closed' && so.status !== 'cancelled';
    // This order's own goods that have gone but are still in the books'
    // on-hand: they cannot also cover what it has still to ship.
    const ownOut = new Map<string, Decimal>();
    for (const l of so.lines) {
      if (!l.itemId) continue;
      ownOut.set(
        l.itemId,
        (ownOut.get(l.itemId) ?? new Decimal(0)).plus(invoiceableQty(l)),
      );
    }
    let hasBackorder = false;
    const totals = {
      ordered: new Decimal(0),
      shipped: new Decimal(0),
      invoiced: new Decimal(0),
      toInvoice: new Decimal(0),
      toShip: new Decimal(0),
      billedNotShipped: new Decimal(0),
    };
    const lines = so.lines.map((l) => {
      const pos = l.itemId ? positions.get(l.itemId) : undefined;
      const toShip = shippable ? toShipQty(l) : new Decimal(0);
      const toInvoice = managed ? new Decimal(0) : invoiceableQty(l);
      const stillFromShelf = Decimal.max(
        toDecimal(l.quantity).minus(
          Decimal.max(
            toDecimal(l.quantityFulfilled),
            toDecimal(l.quantityInvoiced),
          ),
        ),
        0,
      );
      const backorderQty =
        pos && open && !managed
          ? Decimal.max(
              stillFromShelf.minus(
                Decimal.max(
                  toDecimal(pos.available).minus(
                    ownOut.get(l.itemId!) ?? new Decimal(0),
                  ),
                  0,
                ),
              ),
              0,
            )
          : new Decimal(0);
      if (backorderQty.greaterThan(0)) hasBackorder = true;
      totals.ordered = totals.ordered.plus(toDecimal(l.quantity));
      totals.shipped = totals.shipped.plus(toDecimal(l.quantityFulfilled));
      totals.invoiced = totals.invoiced.plus(toDecimal(l.quantityInvoiced));
      totals.toInvoice = totals.toInvoice.plus(toInvoice);
      totals.toShip = totals.toShip.plus(toShip);
      totals.billedNotShipped = totals.billedNotShipped.plus(
        billedNotShippedQty(l),
      );
      return Object.assign(l, {
        lineKind: lineKindOf(l.itemId),
        stock: pos
          ? {
              onHand: pos.onHand,
              committed: pos.committed,
              available: pos.available,
              sku: pos.sku,
            }
          : null,
        backorderQty: backorderQty.toFixed(4),
        toInvoice: toInvoice.toFixed(4),
        toShip: toShip.toFixed(4),
      });
    });

    const invoices = await this.invoices.listForSalesOrder(companyId, so.id);
    const nextInvoice =
      open && !managed ? await this.previewNextInvoice(manager, so) : null;
    const untouched = isUntouched(so.lines);
    const actions = {
      ship: shippable && totals.toShip.greaterThan(0),
      invoice: !!nextInvoice,
      close:
        !managed && so.status === 'partial' && !hasShippedUninvoiced(so.lines),
      reopen: !managed && so.status === 'closed',
      cancel:
        !managed &&
        untouched &&
        so.status !== 'cancelled' &&
        so.status !== 'closed',
      delete: !managed && untouched && invoices.length === 0,
      edit: !managed && open,
      editLines: !managed && open && untouched,
    };
    return Object.assign(so, {
      lines,
      hasBackorder,
      deliveryId: delivery?.id ?? null,
      deliveryReference: delivery?.referenceNo ?? null,
      invoices,
      nextInvoice,
      totals: {
        ordered: totals.ordered.toFixed(4),
        shipped: totals.shipped.toFixed(4),
        invoiced: totals.invoiced.toFixed(4),
        toInvoice: totals.toInvoice.toFixed(4),
        toShip: totals.toShip.toFixed(4),
        billedNotShipped: totals.billedNotShipped.toFixed(4),
      },
      actions,
    });
  }

  /** What the next invoice raised from this order would bill (nothing saved). */
  async invoicePreview(companyId: string, id: string) {
    const so = await this.getById(companyId, id);
    this.assertInvoiceable(so);
    await this.assertNotDeliveryOrder(
      this.dataSource.manager,
      companyId,
      so.id,
    );
    const preview = await this.previewNextInvoice(this.dataSource.manager, so);
    if (!preview) throw this.nothingToInvoice(so);
    return preview;
  }

  private async previewNextInvoice(manager: EntityManager, so: SalesOrder) {
    const used = await liveInvoiceDiscount(manager, so.companyId, so.id);
    const plan = planSalesOrderInvoice(so, so.lines, used);
    if (!plan) return null;
    const lines = this.invoiceLinesFor(so, plan);
    const totals = this.invoices.previewTotals(
      lines,
      plan.discount.type,
      plan.discount.value,
    );
    return {
      mode: plan.mode,
      isFinal: plan.isFinal,
      discountType: plan.discount.type,
      discountValue: plan.discount.value,
      lines: lines.map((l, idx) => ({
        salesOrderLineId: plan.lines[idx].lineId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRate: l.taxRate,
      })),
      ...totals,
    };
  }

  async create(
    companyId: string,
    userId: string,
    dto: CreateSalesOrderDto,
    sourceEstimateId: string | null = null,
    opts: CreateSalesOrderOptions = {},
  ): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) =>
      this.createInTransaction(
        manager,
        companyId,
        userId,
        dto,
        sourceEstimateId,
        opts,
      ),
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
      const customer = await manager.findOne(Customer, {
        where: { id: dto.customerId, companyId },
      });
      if (!customer)
        throw new NotFoundException({
          code: 'CUSTOMER_NOT_FOUND',
          message: 'Customer not found',
        });
      await this.assertItemsBelongToCompany(manager, companyId, dto.lines);
      await assertSalesLinesClassified(manager, companyId, dto.lines, {
        treatFreeTextAsService: opts.treatFreeTextAsService,
      });
      if (!opts.skipStockChecks) {
        await this.assertBackorderAccepted(
          manager,
          companyId,
          dto.lines,
          dto.acceptBackorder,
          null,
        );
      }

      const totals = this.computeTotals(
        dto.lines,
        dto.discountType,
        dto.discountValue,
      );
      const orderNumber = await nextDocumentNumber(
        manager,
        companyId,
        'SO',
        yearOf(dto.orderDate),
      );

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

      const lines = totals.lines.map((l) =>
        manager.create(SalesOrderLineItem, {
          salesOrderId: order.id,
          quantityFulfilled: '0',
          ...l,
        }),
      );
      await manager.save(lines);
      order.lines = lines;
      if (!opts.skipStockChecks) {
        // Not a block: an order only promises goods. It warns early that
        // shipping all of it would take the customer past their credit limit.
        const creditCheck = await assessCredit(
          manager,
          companyId,
          order.customerId,
          order.total,
          {
            excludeSalesOrderId: order.id,
          },
        );
        return Object.assign(order, { creditCheck });
      }
      return order;
    }
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateSalesOrderDto,
  ): Promise<SalesOrder> {
    return this.dataSource.transaction(async (manager) => {
      const order = await lockSalesOrder(manager, companyId, id);
      if (!OPEN_STATUSES.includes(order.status)) {
        throw new BadRequestException({
          code: 'CANNOT_EDIT',
          message: `Cannot edit a ${order.status} sales order`,
        });
      }
      if (
        hasAnyInvoiced(order.lines) &&
        (dto.lines ||
          dto.discountType !== undefined ||
          dto.discountValue !== undefined)
      ) {
        // Invoices already carry their share of these prices and discount.
        throw new BadRequestException({
          code: 'SO_HAS_INVOICES',
          message:
            'This order has been invoiced in part, so its lines and discount can no longer be changed.',
        });
      }

      if (dto.orderDate !== undefined) order.orderDate = dto.orderDate;
      if (dto.expectedDate !== undefined) order.expectedDate = dto.expectedDate;
      if (dto.notes !== undefined) order.notes = dto.notes;

      if (
        dto.lines &&
        order.lines.some((l) => toDecimal(l.quantityFulfilled).greaterThan(0))
      ) {
        // Rebuilding the lines resets what has already been shipped to zero.
        throw new BadRequestException({
          code: 'SO_HAS_SHIPMENTS',
          message:
            'Goods have already been shipped on this order, so its lines can no longer be changed.',
        });
      }

      if (
        dto.lines ||
        dto.discountType !== undefined ||
        dto.discountValue !== undefined
      ) {
        if (dto.lines) {
          await this.assertItemsBelongToCompany(manager, companyId, dto.lines);
          await assertSalesLinesClassified(manager, companyId, dto.lines);
          await this.assertBackorderAccepted(
            manager,
            companyId,
            dto.lines,
            dto.acceptBackorder,
            order.id,
          );
        }
        const nextLines =
          dto.lines ??
          order.lines.map<SalesOrderLineDto>((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            accountId: l.accountId ?? undefined,
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
          const newLines = totals.lines.map((l) =>
            manager.create(SalesOrderLineItem, {
              salesOrderId: order.id,
              quantityFulfilled: '0',
              ...l,
            }),
          );
          await manager.save(newLines);
          // See the same line in EstimatesService.update: the cascade on
          // `manager.save(order)` below would otherwise walk the rows just
          // deleted and null their FK, which is a 500.
          order.lines = newLines;
        }
      }
      await manager.save(order);
      const saved = (await manager.findOne(SalesOrder, {
        where: { id, companyId },
        relations: { lines: true },
      }))!;
      const unshipped = saved.lines.reduce(
        (sum, l) =>
          sum.plus(
            grossValue(
              Decimal.max(
                toDecimal(l.quantity).minus(toDecimal(l.quantityFulfilled)),
                0,
              ),
              l.unitPrice,
              l.taxRate,
            ),
          ),
        new Decimal(0),
      );
      const creditCheck = await assessCredit(
        manager,
        companyId,
        saved.customerId,
        unshipped,
        {},
      );
      return Object.assign(saved, { creditCheck });
    });
  }

  /**
   * Record shipped quantities (running totals per line). Allowed while the
   * order is open, partly shipped or fully shipped but not yet invoiced — and
   * on an order invoiced in full before partial invoicing existed whose goods
   * have not all been delivered yet (billed, delivery pending).
   *
   * Only units that are new to the books — above both what was shipped and
   * what was invoiced — are checked against stock and the credit limit: units
   * already invoiced left the shelf and are already owed.
   */
  async fulfill(
    companyId: string,
    id: string,
    dto: FulfillSalesOrderDto,
    creditOverride: CreditOverride | null = null,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const order = await lockSalesOrder(manager, companyId, id);
      if (order.status === 'cancelled' || order.status === 'closed') {
        throw new BadRequestException({
          code: 'CANNOT_FULFILL',
          message:
            order.status === 'closed'
              ? `${order.orderNumber} is closed. Reopen it to ship more.`
              : `Cannot fulfill a cancelled sales order`,
        });
      }
      await this.assertNotDeliveryOrder(manager, companyId, order.id);
      if (
        order.status === 'invoiced' &&
        !order.lines.some((l) => toShipQty(l).greaterThan(0))
      ) {
        throw new BadRequestException({
          code: 'CANNOT_FULFILL',
          message: `${order.orderNumber} is fully shipped and invoiced.`,
        });
      }

      const byId = new Map(order.lines.map((l) => [l.id, l]));
      // Shipping is where "we don't have it" becomes a hard stop: an order may
      // be taken on backorder, but goods cannot leave that are not on the shelf.
      const shippingByItem = new Map<string, Decimal>();
      const updates: Array<{ line: SalesOrderLineItem; next: Decimal }> = [];
      let shippedValue = new Decimal(0);
      for (const f of dto.lines) {
        const line = byId.get(f.lineId);
        if (!line)
          throw new BadRequestException({
            code: 'LINE_NOT_FOUND',
            message: `Line ${f.lineId} not found`,
          });
        const change = shipmentChange(line, toDecimal(f.quantityFulfilled));
        if (!change.ok) {
          throw new BadRequestException({
            code: change.code,
            message: change.message,
          });
        }
        if (line.itemId && change.checkDelta.greaterThan(0)) {
          shippingByItem.set(
            line.itemId,
            (shippingByItem.get(line.itemId) ?? new Decimal(0)).plus(
              change.checkDelta,
            ),
          );
        }
        if (change.checkDelta.greaterThan(0))
          shippedValue = shippedValue.plus(
            grossValue(change.checkDelta, line.unitPrice, line.taxRate),
          );
        updates.push({ line, next: change.next });
      }
      // Goods leaving on credit: the customer's credit limit is checked here,
      // before anything is recorded as shipped.
      if (shippedValue.greaterThan(0)) {
        await enforceCreditLimit(
          manager,
          companyId,
          order.customerId,
          shippedValue,
          {
            action: 'sales_order_shipment',
            targetType: 'sales_order',
            targetId: order.id,
            override: creditOverride,
          },
        );
      }
      await this.assertPhysicallyOnShelf(manager, companyId, shippingByItem);
      for (const u of updates) {
        u.line.quantityFulfilled = u.next.toFixed(4);
        await manager.save(u.line);
      }
      await manager.update(
        SalesOrder,
        { id: order.id, companyId },
        { status: deriveSalesOrderStatus(order.lines) },
      );
    });
    return this.getDetail(companyId, id);
  }

  /**
   * What converting this order would invoice, without posting anything. A
   * staff member's conversion is filed as an invoice approval carrying this,
   * so the owner reviews the actual lines and amounts before it posts — and
   * the approval bills exactly these, or refuses if the order changed since.
   */
  async conversionPayload(
    companyId: string,
    id: string,
    dto: ConvertSalesOrderDto,
  ) {
    const order = await this.getById(companyId, id);
    this.assertInvoiceable(order);
    await this.assertNotDeliveryOrder(
      this.dataSource.manager,
      companyId,
      order.id,
    );
    const preview = await this.previewNextInvoice(
      this.dataSource.manager,
      order,
    );
    if (!preview) throw this.nothingToInvoice(order);
    const byId = new Map(order.lines.map((l) => [l.id, l]));
    return {
      orderNumber: order.orderNumber,
      preview,
      payload: {
        sourceSalesOrderId: order.id,
        customerId: order.customerId,
        invoiceDate: businessToday(),
        dueDate: dto.dueDate ?? addDaysIso(businessToday(), 30),
        mode: preview.mode,
        closeRemaining: dto.closeRemaining === true,
        discountType: preview.discountType,
        discountValue: preview.discountValue,
        notes: `Converted from sales order ${order.orderNumber}`,
        expectedTotal: preview.total,
        lines: preview.lines.map((l) => {
          const so = byId.get(l.salesOrderLineId)!;
          return {
            salesOrderLineId: l.salesOrderLineId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            accountId: so.accountId ?? undefined,
            itemId: so.itemId ?? undefined,
            lineKind: lineKindOf(so.itemId),
          };
        }),
      },
    };
  }

  /**
   * Invoice what has shipped and is not billed yet. An order with nothing
   * shipped or invoiced is shipped and invoiced in one step, in full. The order
   * stays open for whatever has not shipped; `closeRemaining` closes it
   * instead. `opts.approved` is a staff request the owner approved: it bills
   * exactly what was reviewed, or refuses (409) if the order changed since.
   */
  async convertToInvoice(
    companyId: string,
    userId: string,
    id: string,
    dto: ConvertSalesOrderDto,
    creditOverride: CreditOverride | null = null,
    opts: { approved?: ApprovedConversion } = {},
  ) {
    let closedReason: string | null = null;
    // One transaction with the order row locked: converting twice at once (a
    // double tap) used to raise two invoices for one order.
    const invoice = await this.dataSource.transaction(async (manager) => {
      const order = await lockSalesOrder(manager, companyId, id);
      this.assertInvoiceable(order);
      await this.assertNotDeliveryOrder(manager, companyId, order.id);
      const used = await liveInvoiceDiscount(manager, companyId, order.id);
      let plan: InvoicePlan | null;
      if (opts.approved) {
        const v = validateApprovedConversion(
          order,
          order.lines,
          used,
          opts.approved,
        );
        if (!v.ok) {
          throw new ConflictException({
            code: 'SO_CHANGED_SINCE_REQUEST',
            message: `${order.orderNumber} changed since this invoice was requested (${v.reason}). Request it again from the order as it is now.`,
          });
        }
        plan = v.plan;
      } else {
        plan = planSalesOrderInvoice(order, order.lines, used);
      }
      if (!plan) throw this.nothingToInvoice(order);

      const byId = new Map(order.lines.map((l) => [l.id, l]));
      if (plan.mode === 'ship_and_invoice') {
        // Invoicing records the shipment too: the goods must be on the shelf.
        const byItem = new Map<string, Decimal>();
        for (const pl of plan.lines) {
          const l = byId.get(pl.lineId)!;
          if (!l.itemId) continue;
          byItem.set(
            l.itemId,
            (byItem.get(l.itemId) ?? new Decimal(0)).plus(pl.quantity),
          );
        }
        await this.assertPhysicallyOnShelf(manager, companyId, byItem);
      }
      // Quantities first, invoice second: the credit check inside the invoice
      // then sees exactly the shipped goods still unbilled on this order (now
      // without these) plus the invoice itself — nothing counted twice.
      for (const pl of plan.lines) {
        const l = byId.get(pl.lineId)!;
        if (plan.mode === 'ship_and_invoice') l.quantityFulfilled = l.quantity;
        l.quantityInvoiced = toDecimal(l.quantityInvoiced)
          .plus(pl.quantity)
          .toFixed(4);
        await manager.save(l);
      }
      const closeRemaining = dto.closeRemaining === true;
      if (closeRemaining && hasShippedUninvoiced(order.lines)) {
        throw new BadRequestException({
          code: 'SO_HAS_UNINVOICED_SHIPMENTS',
          message: `Some goods shipped on ${order.orderNumber} are not on this invoice. Invoice them before closing the order.`,
        });
      }

      const today = businessToday();
      const created = await this.invoices.createInTransaction(
        manager,
        companyId,
        userId,
        {
          customerId: order.customerId,
          invoiceDate: today,
          dueDate: dto.dueDate ?? addDaysIso(today, 30),
          discountType: plan.discount.type,
          discountValue: plan.discount.value,
          status: 'sent',
          notes: `Converted from sales order ${order.orderNumber}`,
          // itemId rides along: the invoice is created as 'sent', so it posts,
          // and posting is where the ordered item finally means something --
          // Dr COGS / Cr Inventory and a stock movement per line. Conversion is
          // refused (INSUFFICIENT_STOCK) when the stock is not there.
          lines: this.invoiceLinesFor(order, plan),
        },
        {
          credit: { override: creditOverride },
          salesOrder: {
            id: order.id,
            lineIds: plan.lines.map((l) => l.lineId),
            autoShipped: plan.mode === 'ship_and_invoice',
          },
        },
      );

      let status: SalesOrderStatus = deriveSalesOrderStatus(order.lines);
      let notes = order.notes;
      if (closeRemaining && status !== 'invoiced') {
        status = 'closed';
        closedReason = 'Closed with its final invoice';
        notes = appendNote(
          notes,
          `[CLOSED] ${closedReason} ${created.invoiceNumber}`,
        );
      }
      await manager.update(
        SalesOrder,
        { id: order.id, companyId },
        { status, invoiceId: created.id, notes },
      );
      return created;
    });
    if (closedReason) {
      await this.audit.record({
        companyId,
        actorUserId: userId,
        action: 'sales_order_closed',
        targetType: 'sales_order',
        targetId: id,
        details: { reason: closedReason, invoiceId: invoice.id },
      });
    }
    return { salesOrder: await this.getDetail(companyId, id), invoice };
  }

  /**
   * Short-close an order: what has not shipped will not ship. Posts nothing,
   * so staff may do it (as with closing a purchase order). Refused while goods
   * shipped on it are unbilled — they would never be invoiced.
   */
  async close(
    companyId: string,
    userId: string,
    id: string,
    dto: CloseSalesOrderDto,
  ) {
    const reason = dto.reason?.trim() || null;
    const changed = await this.dataSource.transaction(async (manager) => {
      const order = await lockSalesOrder(manager, companyId, id);
      await this.assertNotDeliveryOrder(manager, companyId, order.id);
      if (order.status === 'closed') return false;
      if (isUntouched(order.lines)) {
        throw new BadRequestException({
          code: 'SO_NOTHING_TO_CLOSE',
          message: `Nothing has shipped on ${order.orderNumber} yet. Cancel it instead.`,
        });
      }
      if (hasShippedUninvoiced(order.lines)) {
        throw new BadRequestException({
          code: 'SO_HAS_UNINVOICED_SHIPMENTS',
          message: `Invoice the goods shipped on ${order.orderNumber} before closing it, so they are billed.`,
        });
      }
      if (order.status !== 'partial') {
        throw new BadRequestException({
          code: 'INVALID_STATUS_TRANSITION',
          message:
            order.status === 'invoiced'
              ? `${order.orderNumber} is fully invoiced; there is nothing left to close.`
              : `A ${order.status} sales order cannot be closed.`,
        });
      }
      await manager.update(
        SalesOrder,
        { id: order.id, companyId },
        {
          status: 'closed',
          notes: appendNote(
            order.notes,
            `[CLOSED] ${reason ?? 'The rest of the order will not ship.'}`,
          ),
        },
      );
      return true;
    });
    if (changed) {
      await this.audit.record({
        companyId,
        actorUserId: userId,
        action: 'sales_order_closed',
        targetType: 'sales_order',
        targetId: id,
        details: { reason },
      });
    }
    return this.getDetail(companyId, id);
  }

  /** A closed order goes back to where its shipments and invoices put it. */
  async reopen(companyId: string, userId: string, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const order = await lockSalesOrder(manager, companyId, id);
      await this.assertNotDeliveryOrder(manager, companyId, order.id);
      if (order.status !== 'closed') {
        throw new BadRequestException({
          code: 'INVALID_STATUS_TRANSITION',
          message: `${order.orderNumber} is not closed.`,
        });
      }
      await manager.update(
        SalesOrder,
        { id: order.id, companyId },
        { status: deriveSalesOrderStatus(order.lines) },
      );
    });
    await this.audit.record({
      companyId,
      actorUserId: userId,
      action: 'sales_order_reopened',
      targetType: 'sales_order',
      targetId: id,
    });
    return this.getDetail(companyId, id);
  }

  async cancel(companyId: string, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const order = await lockSalesOrder(manager, companyId, id);
      if (order.status === 'cancelled') return;
      await this.assertNotDeliveryOrder(manager, companyId, order.id);
      if (order.status === 'invoiced') {
        throw new BadRequestException({
          code: 'ALREADY_INVOICED',
          message: 'Invoiced sales orders cannot be cancelled',
        });
      }
      if (hasAnyInvoiced(order.lines) || order.status === 'closed') {
        throw new BadRequestException({
          code: 'SO_HAS_INVOICES',
          message: `${order.orderNumber} has been invoiced in part. Close it instead, so the rest does not ship.`,
        });
      }
      if (hasAnyShipped(order.lines)) {
        throw new BadRequestException({
          code: 'SO_HAS_SHIPMENTS',
          message: `Goods have shipped on ${order.orderNumber}. Invoice them and close the order, or set the shipped quantities back to 0 first.`,
        });
      }
      await manager.update(
        SalesOrder,
        { id: order.id, companyId },
        { status: 'cancelled' },
      );
    });
    return this.getDetail(companyId, id);
  }

  async delete(companyId: string, id: string) {
    return this.dataSource.transaction(async (manager) => {
      const order = await lockSalesOrder(manager, companyId, id);
      await this.assertNotDeliveryOrder(manager, companyId, order.id);
      const invoiced = await manager.count(Invoice, {
        where: { companyId, salesOrderId: order.id },
      });
      if (
        order.status === 'invoiced' ||
        invoiced > 0 ||
        hasAnyInvoiced(order.lines)
      ) {
        throw new BadRequestException({
          code: 'CANNOT_DELETE',
          message: `${order.orderNumber} has invoices against it and cannot be deleted. Close it instead.`,
        });
      }
      if (hasAnyShipped(order.lines)) {
        throw new BadRequestException({
          code: 'CANNOT_DELETE',
          message: `Goods have shipped on ${order.orderNumber}, so it cannot be deleted.`,
        });
      }
      await manager.remove(order);
      return { id, deleted: true };
    });
  }

  private assertInvoiceable(order: SalesOrder): void {
    if (order.status === 'invoiced') {
      throw new BadRequestException({
        code: 'ALREADY_INVOICED',
        message: 'Sales order already invoiced',
      });
    }
    if (order.status === 'cancelled') {
      throw new BadRequestException({
        code: 'ORDER_CANCELLED',
        message: 'Cancelled sales orders cannot be invoiced',
      });
    }
    if (order.status === 'closed') {
      throw new BadRequestException({
        code: 'ORDER_CLOSED',
        message: `${order.orderNumber} is closed. Reopen it to invoice more.`,
      });
    }
  }

  private nothingToInvoice(order: SalesOrder) {
    return new BadRequestException({
      code: 'NOTHING_TO_INVOICE',
      message: `Everything shipped on ${order.orderNumber} has already been invoiced. Record the next shipment first.`,
    });
  }

  /** The invoice lines a plan bills, in plan order. */
  private invoiceLinesFor(order: SalesOrder, plan: InvoicePlan) {
    const byId = new Map(order.lines.map((l) => [l.id, l]));
    return plan.lines.map((pl) => {
      const l = byId.get(pl.lineId)!;
      return {
        description: l.description,
        quantity: pl.quantity.toFixed(4),
        unitPrice: l.unitPrice,
        taxRate: l.taxRate,
        accountId: l.accountId ?? undefined,
        itemId: l.itemId ?? undefined,
        lineKind: lineKindOf(l.itemId),
      };
    });
  }

  /**
   * Goods can only leave if they are on the shelf. Units shipped on any open
   * order but not yet invoiced are still in the books' on-hand, so they are
   * taken off first.
   */
  private async assertPhysicallyOnShelf(
    manager: EntityManager,
    companyId: string,
    byItem: Map<string, Decimal>,
  ): Promise<void> {
    if (byItem.size === 0) return;
    const positions = await stockPositions(manager, companyId, [
      ...byItem.keys(),
    ]);
    for (const [itemId, qty] of byItem) {
      const pos = positions.get(itemId);
      if (!pos) continue;
      const shelf = Decimal.max(toDecimal(pos.physicallyAvailable), 0);
      if (qty.greaterThan(shelf)) {
        const out = toDecimal(pos.shippedNotInvoiced);
        throw new UnprocessableEntityException({
          code: 'INSUFFICIENT_STOCK',
          message:
            `Cannot ship ${qty.toFixed(0)} x ${pos.name}: only ${shelf.toFixed(0)} on the shelf` +
            (out.greaterThan(0)
              ? ` (${toDecimal(pos.onHand).toFixed(0)} on hand, ${out.toFixed(0)} already shipped on orders not invoiced yet).`
              : '.'),
        });
      }
    }
  }

  /**
   * A delivery creates its own sales order and settles it: stock leaves at
   * dispatch and the invoice is raised when the delivery is approved. Shipping
   * or invoicing that order by hand as well would move the stock twice and
   * book the revenue twice.
   */
  private async assertNotDeliveryOrder(
    manager: EntityManager,
    companyId: string,
    orderId: string,
  ): Promise<void> {
    const delivery = await manager.findOne(Delivery, {
      where: { companyId, salesOrderId: orderId },
    });
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
    const short = await backorderLines(manager, companyId, lines, {
      excludeSalesOrderId,
    });
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
    const ids = [
      ...new Set(lines.map((l) => l.itemId).filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return;
    const found = await manager.getRepository(InventoryItem).find({
      where: { id: In(ids), companyId },
      select: ['id'],
    });
    if (found.length !== ids.length) {
      throw new BadRequestException({
        code: 'ITEM_NOT_FOUND',
        message:
          'One or more line items reference an inventory item that does not exist',
      });
    }
  }

  private computeTotals(
    lines: SalesOrderLineDto[],
    discountType: 'percent' | 'amount' | 'none' | undefined,
    discountValue: string | undefined,
  ): {
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    total: string;
    lines: LineCalc[];
  } {
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
        description: l.description,
        quantity: qty.toFixed(4),
        unitPrice: price.toFixed(4),
        taxRate: taxRate.toFixed(4),
        taxAmount: tax.toFixed(4),
        lineTotal: base.plus(tax).toFixed(4),
        accountId: l.accountId ?? null,
        itemId: l.itemId ?? null,
        lineOrder: i,
      });
    });
    let discountAmount = new Decimal(0);
    if (discountType === 'percent')
      discountAmount = subtotal
        .times(toDecimal(discountValue ?? 0))
        .dividedBy(100);
    else if (discountType === 'amount')
      discountAmount = toDecimal(discountValue ?? 0);
    if (discountAmount.greaterThan(subtotal)) discountAmount = subtotal;
    const total = subtotal.minus(discountAmount).plus(taxTotal);
    return {
      subtotal: subtotal.toFixed(4),
      discountAmount: discountAmount.toFixed(4),
      taxAmount: taxTotal.toFixed(4),
      total: total.toFixed(4),
      lines: calc,
    };
  }
}
