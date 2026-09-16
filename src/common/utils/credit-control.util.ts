import {
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { toDecimal } from './money.util';

/**
 * Customer credit limits.
 *
 * A credit limit is the most a customer may owe the business at once. It is
 * judged on EXPOSURE, not on the invoices alone — goods already shipped on
 * credit count even before they are invoiced, and money the customer has paid
 * in advance counts in their favour:
 *
 *   exposure = unpaid invoices
 *            + dispatched deliveries not yet approved (on credit)
 *            + goods shipped on sales orders not yet invoiced
 *            − advances the customer has paid − open credit memos
 *            + what this shipment or invoice adds
 *
 * It is checked where goods leave or an invoice posts. Past the limit, the
 * sale needs an advance covering at least the excess — Rs 107,250 against a
 * Rs 100,000 limit needs Rs 7,250 up front — or an owner's override with a
 * reason, which is audited. A limit of 0 means no limit.
 */
export interface CreditAssessment {
  customerId: string;
  customerName: string;
  limited: boolean;
  limit: string;
  openInvoices: string;
  inTransit: string;
  shippedNotInvoiced: string;
  advances: string;
  credits: string;
  thisAmount: string;
  exposure: string;
  excess: string;
  /** Advance needed before this can go ahead without an override. */
  requiredAdvance: string;
  withinLimit: boolean;
}

export interface CreditOverride {
  reason: string;
  userId: string;
  role: string;
}

const money = (d: Decimal) => d.toFixed(4);

export async function assessCredit(
  manager: EntityManager,
  companyId: string,
  customerId: string,
  thisAmount: Decimal.Value,
  opts: { excludeSalesOrderId?: string | null } = {},
): Promise<CreditAssessment> {
  const [row] = await manager.query(
    `SELECT c.name,
            c.credit_limit AS limit,
            (SELECT COALESCE(SUM(i.balance), 0) FROM invoices i
              WHERE i.company_id = $1 AND i.customer_id = $2
                AND i.status NOT IN ('draft', 'void')) AS open_invoices,
            (SELECT COALESCE(SUM(
                      (CASE WHEN di.ordered_qty > 0 THEN di.ordered_qty ELSE di.quantity END)
                      * di.unit_price * (1 + di.tax_rate / 100)), 0)
               FROM deliveries d JOIN delivery_items di ON di.delivery_id = d.id
              WHERE d.company_id = $1 AND d.customer_id = $2
                AND d.ledger_status = 'in_transit' AND d.prepaid = false) AS in_transit,
            (SELECT COALESCE(SUM(l.quantity_fulfilled * l.unit_price * (1 + l.tax_rate / 100)), 0)
               FROM sales_orders o JOIN sales_order_line_items l ON l.sales_order_id = o.id
              WHERE o.company_id = $1 AND o.customer_id = $2
                AND o.status IN ('partial', 'fulfilled')
                AND ($3::uuid IS NULL OR o.id <> $3::uuid)
                AND NOT EXISTS (SELECT 1 FROM deliveries dd WHERE dd.sales_order_id = o.id)) AS shipped,
            (SELECT COALESCE(SUM(p.amount - COALESCE(a.applied, 0)), 0)
               FROM payments p
               LEFT JOIN (SELECT payment_id, SUM(amount_applied) AS applied
                            FROM payment_applications GROUP BY payment_id) a ON a.payment_id = p.id
              WHERE p.company_id = $1 AND p.customer_id = $2
                AND p.amount - COALESCE(a.applied, 0) > 0) AS advances,
            (SELECT COALESCE(SUM(m.balance), 0) FROM credit_memos m
              WHERE m.company_id = $1 AND m.customer_id = $2
                AND m.status <> 'void') AS credits
       FROM customers c
      WHERE c.company_id = $1 AND c.id = $2`,
    [companyId, customerId, opts.excludeSalesOrderId ?? null],
  );
  const limit = toDecimal(row?.limit ?? 0);
  const openInvoices = toDecimal(row?.open_invoices ?? 0);
  const inTransit = toDecimal(row?.in_transit ?? 0);
  const shipped = toDecimal(row?.shipped ?? 0);
  const advances = toDecimal(row?.advances ?? 0);
  const credits = toDecimal(row?.credits ?? 0);
  const adds = toDecimal(thisAmount as never);
  const exposure = openInvoices.plus(inTransit).plus(shipped).minus(advances).minus(credits).plus(adds);
  const limited = limit.greaterThan(0);
  const excess = limited ? Decimal.max(exposure.minus(limit), 0) : new Decimal(0);
  return {
    customerId,
    customerName: row?.name ?? '',
    limited,
    limit: money(limit),
    openInvoices: money(openInvoices),
    inTransit: money(inTransit),
    shippedNotInvoiced: money(shipped),
    advances: money(advances),
    credits: money(credits),
    thisAmount: money(adds),
    exposure: money(exposure),
    excess: money(excess),
    requiredAdvance: money(excess),
    withinLimit: excess.lessThanOrEqualTo(0),
  };
}

/**
 * Refuse a shipment or invoice that takes the customer past their credit
 * limit, unless the owner overrides it with a reason.
 */
export async function enforceCreditLimit(
  manager: EntityManager,
  companyId: string,
  customerId: string,
  thisAmount: Decimal.Value,
  ctx: {
    action: string;
    targetType: string;
    targetId?: string | null;
    excludeSalesOrderId?: string | null;
    override?: CreditOverride | null;
  },
): Promise<CreditAssessment> {
  const assessment = await assessCredit(manager, companyId, customerId, thisAmount, {
    excludeSalesOrderId: ctx.excludeSalesOrderId,
  });
  if (assessment.withinLimit) return assessment;

  if (ctx.override) {
    if (ctx.override.role !== 'admin') {
      throw new ForbiddenException({
        code: 'CREDIT_OVERRIDE_OWNER_ONLY',
        message: 'Only the owner can let a sale go past a customer’s credit limit.',
      });
    }
    const reason = (ctx.override.reason ?? '').trim();
    if (reason.length < 5) {
      throw new BadRequestException({
        code: 'CREDIT_OVERRIDE_REASON_REQUIRED',
        message: 'Say why this sale may go past the credit limit (at least 5 characters).',
      });
    }
    await manager.query(
      `INSERT INTO operational_audit_events (company_id, actor_user_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'credit_limit_override', $3, $4, $5::jsonb)`,
      [
        companyId,
        ctx.override.userId,
        ctx.targetType,
        ctx.targetId ?? null,
        JSON.stringify({ reason, action: ctx.action, ...assessment }),
      ],
    );
    return assessment;
  }

  const fmt = (v: string) =>
    `Rs ${toDecimal(v).toNumber().toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  throw new UnprocessableEntityException({
    code: 'CREDIT_LIMIT_EXCEEDED',
    message:
      `${assessment.customerName || 'This customer'} would owe ${fmt(assessment.exposure)} against a credit ` +
      `limit of ${fmt(assessment.limit)}. Record an advance of at least ${fmt(assessment.requiredAdvance)} ` +
      'first, or ask the owner to approve it past the limit.',
    details: assessment,
  });
}

/** Tax-inclusive value of a quantity at a price. */
export function grossValue(quantity: Decimal.Value, unitPrice: Decimal.Value, taxRate: Decimal.Value): Decimal {
  const base = toDecimal(quantity as never).times(toDecimal(unitPrice as never));
  return base.plus(base.times(toDecimal(taxRate as never)).dividedBy(100));
}
