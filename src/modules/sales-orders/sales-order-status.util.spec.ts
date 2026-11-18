import Decimal from 'decimal.js';
import {
  applyRelease,
  buildInvoicePlan,
  deriveSalesOrderStatus,
  invoiceableQty,
  planSalesOrderInvoice,
  shipmentChange,
  SoLinePriced,
  toShipQty,
  validateApprovedConversion,
} from './sales-order-status.util';

const line = (
  id: string,
  q: number,
  s = 0,
  i = 0,
  price = 100,
): SoLinePriced => ({
  id,
  quantity: String(q),
  quantityFulfilled: String(s),
  quantityInvoiced: String(i),
  unitPrice: String(price),
  taxRate: '0',
});
const noDiscount = {
  discountType: 'none' as const,
  discountValue: '0',
  discountAmount: '0',
};

describe('deriveSalesOrderStatus', () => {
  it.each([
    ['nothing shipped', [line('a', 10)], 'open'],
    ['half shipped', [line('a', 10, 5)], 'partial'],
    ['half shipped and invoiced', [line('a', 10, 5, 5)], 'partial'],
    ['all shipped, half invoiced', [line('a', 10, 10, 5)], 'fulfilled'],
    ['all shipped and invoiced', [line('a', 10, 10, 10)], 'invoiced'],
    // Invoiced in full before partial invoicing: billed, delivery pending.
    ['legacy billed ahead of delivery', [line('a', 10, 5, 10)], 'invoiced'],
    [
      'zero-quantity line does not block completion',
      [line('a', 10, 10, 10), line('b', 0)],
      'invoiced',
    ],
    [
      'one line done, one untouched',
      [line('a', 10, 10, 10), line('b', 5)],
      'partial',
    ],
  ])('%s', (_name, lines, expected) => {
    expect(deriveSalesOrderStatus(lines)).toBe(expected);
  });
});

describe('quantities', () => {
  it('invoiceable is shipped minus invoiced, never negative', () => {
    expect(invoiceableQty(line('a', 10, 5, 2)).toNumber()).toBe(3);
    expect(invoiceableQty(line('a', 10, 5, 10)).toNumber()).toBe(0);
  });
  it('to ship counts goods billed but not yet delivered', () => {
    expect(toShipQty(line('a', 10, 4, 10)).toNumber()).toBe(6);
  });
});

describe('shipmentChange', () => {
  it('raises freely up to the ordered quantity', () => {
    const r = shipmentChange(line('a', 10, 5, 5), 8);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.checkDelta.toNumber()).toBe(3);
  });
  it('refuses more than ordered', () => {
    expect(shipmentChange(line('a', 10), 11)).toMatchObject({
      ok: false,
      code: 'OVER_FULFILLED',
    });
  });
  it('lowers down to the invoiced quantity, not below', () => {
    expect(shipmentChange(line('a', 10, 8, 5), 5)).toMatchObject({ ok: true });
    expect(shipmentChange(line('a', 10, 8, 5), 4)).toMatchObject({
      ok: false,
      code: 'SHIPPED_BELOW_INVOICED',
    });
  });
  it('legacy billed-ahead line: recording delivery needs no new stock/credit check', () => {
    const r = shipmentChange(line('a', 10, 4, 10), 10);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.checkDelta.toNumber()).toBe(0);
  });
  it('refuses negative', () => {
    expect(shipmentChange(line('a', 10), -1)).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('planSalesOrderInvoice', () => {
  it('an untouched order is shipped and invoiced in one step, in full', () => {
    const plan = planSalesOrderInvoice(
      noDiscount,
      [line('a', 10), line('b', 2)],
      0,
    )!;
    expect(plan.mode).toBe('ship_and_invoice');
    expect(plan.lines.map((l) => l.quantity.toNumber())).toEqual([10, 2]);
    expect(plan.isFinal).toBe(true);
  });
  it('a half-shipped order bills only the shipped goods', () => {
    const plan = planSalesOrderInvoice(noDiscount, [line('a', 10, 5)], 0)!;
    expect(plan.mode).toBe('shipped');
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].quantity.toNumber()).toBe(5);
    expect(plan.isFinal).toBe(false);
  });
  it('skips lines with nothing new shipped', () => {
    const plan = planSalesOrderInvoice(
      noDiscount,
      [line('a', 10, 5, 5), line('b', 4, 4)],
      0,
    )!;
    expect(plan.lines.map((l) => l.lineId)).toEqual(['b']);
  });
  it('nothing to bill once everything shipped is invoiced', () => {
    expect(
      planSalesOrderInvoice(noDiscount, [line('a', 10, 5, 5)], 0),
    ).toBeNull();
  });
  it('percent discount passes through', () => {
    const plan = planSalesOrderInvoice(
      { discountType: 'percent', discountValue: '10', discountAmount: '100' },
      [line('a', 10, 5)],
      0,
    )!;
    expect(plan.discount).toEqual({ type: 'percent', value: '10.0000' });
  });
  it('one-step keeps the order’s own fixed discount', () => {
    const plan = planSalesOrderInvoice(
      { discountType: 'amount', discountValue: '50', discountAmount: '50' },
      [line('a', 10)],
      0,
    )!;
    expect(plan.discount).toEqual({ type: 'amount', value: '50.0000' });
  });
  it('a fixed discount is shared out and adds up exactly (thirds)', () => {
    const order = {
      discountType: 'amount' as const,
      discountValue: '100',
      discountAmount: '100',
    };
    // ordered 3 × 100 = 300; invoiced one unit at a time
    const first = planSalesOrderInvoice(order, [line('a', 3, 1)], 0)!;
    expect(first.discount.value).toBe('33.3300');
    const second = planSalesOrderInvoice(order, [line('a', 3, 2, 1)], 33.33)!;
    expect(second.discount.value).toBe('33.3300');
    const last = planSalesOrderInvoice(order, [line('a', 3, 3, 2)], 66.66)!;
    expect(last.isFinal).toBe(true);
    expect(last.discount.value).toBe('33.3400');
  });
});

describe('validateApprovedConversion', () => {
  const lines = [line('a', 10, 5)];
  const approved = {
    mode: 'shipped' as const,
    lines: [
      { salesOrderLineId: 'a', quantity: '5', unitPrice: '100', taxRate: '0' },
    ],
    discountType: 'none' as const,
    discountValue: '0',
  };
  it('bills exactly what was reviewed when nothing changed', () => {
    const r = validateApprovedConversion(noDiscount, lines, 0, approved);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.lines[0].quantity.toNumber()).toBe(5);
  });
  it('refuses once those goods were invoiced meanwhile', () => {
    const r = validateApprovedConversion(
      noDiscount,
      [line('a', 10, 5, 5)],
      0,
      approved,
    );
    expect(r.ok).toBe(false);
  });
  it('refuses when the shipment was lowered since', () => {
    expect(
      validateApprovedConversion(noDiscount, [line('a', 10, 3)], 0, approved)
        .ok,
    ).toBe(false);
  });
  it('refuses a price change', () => {
    expect(
      validateApprovedConversion(
        noDiscount,
        [line('a', 10, 5, 0, 120)],
        0,
        approved,
      ).ok,
    ).toBe(false);
  });
  it('an old request without line ids is fine only while the order is untouched', () => {
    const old = { lines: [{ quantity: '10' }] };
    expect(
      validateApprovedConversion(noDiscount, [line('a', 10)], 0, old).ok,
    ).toBe(true);
    expect(validateApprovedConversion(noDiscount, lines, 0, old).ok).toBe(
      false,
    );
  });
});

describe('applyRelease (invoice voided or deleted)', () => {
  const rel = (id: string, n: number) => new Map([[id, new Decimal(n)]]);
  it('gives the invoiced quantity back; shipment stays', () => {
    const r = applyRelease([line('a', 10, 10, 10)], rel('a', 5), {
      autoShipped: false,
      status: 'invoiced',
    });
    expect(r.lines[0].quantityInvoiced).toBe('5.0000');
    expect(r.lines[0].quantityFulfilled).toBe('10');
    expect(r.status).toBe('fulfilled');
  });
  it('a one-step invoice also un-ships, so the order is open again', () => {
    const r = applyRelease([line('a', 10, 10, 10)], rel('a', 10), {
      autoShipped: true,
      status: 'invoiced',
    });
    expect(r.lines[0].quantityFulfilled).toBe('0.0000');
    expect(r.status).toBe('open');
  });
  it('a closed order reopens to be billed when shipped goods become unbilled', () => {
    const r = applyRelease([line('a', 10, 5, 5)], rel('a', 5), {
      autoShipped: false,
      status: 'closed',
    });
    expect(r.status).toBe('partial');
  });
  it('cancelled stays cancelled; never below zero', () => {
    const r = applyRelease([line('a', 10, 0, 2)], rel('a', 5), {
      autoShipped: false,
      status: 'cancelled',
    });
    expect(r.status).toBe('cancelled');
    expect(r.lines[0].quantityInvoiced).toBe('0.0000');
  });
});

describe('buildInvoicePlan', () => {
  it('isFinal looks at every line', () => {
    const plan = buildInvoicePlan(
      noDiscount,
      [line('a', 2, 2), line('b', 3)],
      'shipped',
      new Map([['a', new Decimal(2)]]),
      0,
    );
    expect(plan.isFinal).toBe(false);
  });
});
