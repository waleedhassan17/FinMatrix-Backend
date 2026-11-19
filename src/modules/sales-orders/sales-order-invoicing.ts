import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { SalesOrder } from './entities/sales-order.entity';
import { SalesOrderLineItem } from './entities/sales-order-line-item.entity';
import { toDecimal } from '../../common/utils/money.util';
import { applyRelease } from './sales-order-status.util';

/**
 * Database helpers shared by SalesOrdersService and InvoicesService. Plain
 * functions rather than a provider: SalesOrdersModule imports InvoicesModule,
 * so InvoicesService cannot inject anything from the sales-order side.
 *
 * Lock order on every path that touches both: invoice row → sales order row
 * → (its lines) → customer → items. Converting never locks an existing
 * invoice, so it cannot cross a void.
 */

/** SELECT … FOR UPDATE the order row, then load its lines in order. */
export async function lockSalesOrder(
  manager: EntityManager,
  companyId: string,
  id: string,
): Promise<SalesOrder> {
  const order = await manager
    .createQueryBuilder(SalesOrder, 'o')
    .setLock('pessimistic_write')
    .where('o.id = :id AND o.companyId = :companyId', { id, companyId })
    .getOne();
  if (!order) {
    throw new NotFoundException({
      code: 'SALES_ORDER_NOT_FOUND',
      message: 'Sales order not found',
    });
  }
  order.lines = await manager.find(SalesOrderLineItem, {
    where: { salesOrderId: order.id },
    order: { lineOrder: 'ASC' },
  });
  return order;
}

/** Discount already given on this order's live invoices. */
export async function liveInvoiceDiscount(
  manager: EntityManager,
  companyId: string,
  salesOrderId: string,
): Promise<Decimal> {
  const [row] = await manager.query(
    `SELECT COALESCE(SUM(discount_amount), 0) AS used
       FROM invoices
      WHERE company_id = $1 AND sales_order_id = $2 AND status <> 'void'`,
    [companyId, salesOrderId],
  );
  return toDecimal(row?.used ?? 0);
}

/** The newest live invoice of an order, other than `exceptId`. */
export async function latestLiveInvoiceId(
  manager: EntityManager,
  companyId: string,
  salesOrderId: string,
  exceptId: string | null = null,
): Promise<string | null> {
  const [row] = await manager.query(
    `SELECT id FROM invoices
      WHERE company_id = $1 AND sales_order_id = $2 AND status <> 'void'
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      ORDER BY created_at DESC
      LIMIT 1`,
    [companyId, salesOrderId, exceptId],
  );
  return row?.id ?? null;
}

/**
 * An invoice raised from a sales order is being voided or deleted: give its
 * quantities back so they can be invoiced again (and, for a one-step invoice,
 * shipped again). Mirrors BillsService.releasePurchaseOrderBilling. Call it
 * once, while the invoice is still live, inside the void/delete transaction.
 */
export async function releaseSalesOrderInvoicing(
  manager: EntityManager,
  companyId: string,
  invoice: {
    id: string;
    salesOrderId: string | null;
    salesOrderAutoShipped: boolean;
    lines?: Array<{ salesOrderLineId: string | null; quantity: string }>;
  },
): Promise<void> {
  if (!invoice.salesOrderId) return;
  const order = await manager
    .createQueryBuilder(SalesOrder, 'o')
    .setLock('pessimistic_write')
    .where('o.id = :id AND o.companyId = :companyId', {
      id: invoice.salesOrderId,
      companyId,
    })
    .getOne();
  if (!order) return;
  const lines = await manager.find(SalesOrderLineItem, {
    where: { salesOrderId: order.id },
    order: { lineOrder: 'ASC' },
  });

  const released = new Map<string, Decimal>();
  for (const il of invoice.lines ?? []) {
    if (!il.salesOrderLineId) continue;
    released.set(
      il.salesOrderLineId,
      (released.get(il.salesOrderLineId) ?? new Decimal(0)).plus(
        toDecimal(il.quantity),
      ),
    );
  }
  const result = applyRelease(lines, released, {
    autoShipped: invoice.salesOrderAutoShipped,
    status: order.status,
  });
  const byId = new Map(result.lines.map((l) => [l.id, l]));
  for (const line of lines) {
    const next = byId.get(line.id)!;
    if (
      next.quantityInvoiced !== line.quantityInvoiced ||
      next.quantityFulfilled !== line.quantityFulfilled
    ) {
      line.quantityInvoiced = next.quantityInvoiced;
      line.quantityFulfilled = next.quantityFulfilled;
      await manager.save(line);
    }
  }
  order.status = result.status as SalesOrder['status'];
  order.invoiceId = await latestLiveInvoiceId(
    manager,
    companyId,
    order.id,
    invoice.id,
  );
  // Save the row only: a cascade over `lines` is not wanted here.
  await manager.update(
    SalesOrder,
    { id: order.id, companyId },
    { status: order.status, invoiceId: order.invoiceId },
  );
}
