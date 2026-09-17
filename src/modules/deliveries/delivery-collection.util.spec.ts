import {
  collectionFromAmount,
  deliveredGross,
  deliveryAdvance,
  grossOf,
  invoicePaidStatus,
  resolveCollection,
} from './delivery-collection.util';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { response?: { code?: string } }).response?.code;
  }
  return undefined;
};

describe('grossOf', () => {
  it('sums lines tax-inclusive at four decimals, like the invoice', () => {
    const gross = grossOf([
      { quantity: 3, unitPrice: '33.33', taxRate: '17' },
      { quantity: 2, unitPrice: '100', taxRate: null },
    ]);
    // 99.99 + 16.9983 + 200
    expect(gross.toFixed(4)).toBe('316.9883');
  });
});

describe('resolveCollection', () => {
  it('a fully prepaid delivery is paid whatever the rider sends', () => {
    for (const paidStatus of ['unpaid', 'partial', 'paid', undefined]) {
      const c = resolveCollection({ gross: '1000', advance: '1000', paidStatus, amountCollected: '5' });
      expect(c).toEqual({
        paidStatus: 'paid',
        amountCollected: '0.0000',
        amountDue: '0.0000',
        advanceApplied: '1000.0000',
      });
    }
  });

  it('a short delivery the advance still covers owes nothing at the door', () => {
    const c = resolveCollection({ gross: '600', advance: '1000', paidStatus: 'unpaid' });
    expect(c.paidStatus).toBe('paid');
    expect(c.advanceApplied).toBe('600.0000');
    expect(c.amountCollected).toBe('0.0000');
  });

  it('PAID collects exactly what the advance leaves', () => {
    const c = resolveCollection({ gross: '1000', advance: '300', paidStatus: 'paid' });
    expect(c).toMatchObject({ paidStatus: 'paid', amountCollected: '700.0000', amountDue: '700.0000' });
  });

  it('NOT PAID collects nothing, and an old app that sends nothing is NOT PAID', () => {
    expect(resolveCollection({ gross: '1000', advance: '0', paidStatus: 'unpaid' }).amountCollected).toBe('0.0000');
    expect(resolveCollection({ gross: '1000', advance: '0' }).paidStatus).toBe('unpaid');
  });

  it('PARTIAL records the amount received', () => {
    const c = resolveCollection({ gross: '1000', advance: '200', paidStatus: 'partial', amountCollected: '350.5' });
    expect(c).toMatchObject({ paidStatus: 'partial', amountCollected: '350.5000', amountDue: '800.0000' });
  });

  it('PARTIAL needs an amount above zero and no more than is due', () => {
    expect(codeOf(() => resolveCollection({ gross: '1000', advance: '0', paidStatus: 'partial' }))).toBe('COLLECTED_OUT_OF_RANGE');
    expect(codeOf(() => resolveCollection({ gross: '1000', advance: '0', paidStatus: 'partial', amountCollected: '0' }))).toBe('COLLECTED_OUT_OF_RANGE');
    expect(codeOf(() => resolveCollection({ gross: '1000', advance: '0', paidStatus: 'partial', amountCollected: '-5' }))).toBe('COLLECTED_OUT_OF_RANGE');
    expect(codeOf(() => resolveCollection({ gross: '1000', advance: '0', paidStatus: 'partial', amountCollected: '1000.01' }))).toBe('COLLECTED_OUT_OF_RANGE');
  });

  it('PARTIAL for the whole amount due, to the paisa, is PAID', () => {
    const c = resolveCollection({ gross: '316.9883', advance: '0', paidStatus: 'partial', amountCollected: '316.99' });
    expect(c).toMatchObject({ paidStatus: 'paid', amountCollected: '316.9883' });
  });

  it('refuses an unknown status', () => {
    expect(codeOf(() => resolveCollection({ gross: '10', advance: '0', paidStatus: 'maybe' }))).toBe('VALIDATION_FAILED');
  });
});

describe('collectionFromAmount (the owner’s cash count)', () => {
  it('zero is unpaid, the full amount is paid, between is partial', () => {
    expect(collectionFromAmount('500', '0', '0').paidStatus).toBe('unpaid');
    expect(collectionFromAmount('500', '0', '500').paidStatus).toBe('paid');
    expect(collectionFromAmount('500', '100', '150')).toMatchObject({ paidStatus: 'partial', amountCollected: '150.0000' });
  });

  it('refuses more cash than was due', () => {
    expect(codeOf(() => collectionFromAmount('500', '100', '401'))).toBe('COLLECTED_OUT_OF_RANGE');
  });

  it('refuses something that is not a number', () => {
    expect(codeOf(() => collectionFromAmount('500', '0', 'abc'))).toBe('COLLECTED_OUT_OF_RANGE');
  });
});

describe('delivery helpers', () => {
  const line = (itemId: string, orderedQty: string, unitPrice: string, taxRate = '0') => ({
    itemId,
    orderedQty,
    quantity: orderedQty,
    unitPrice,
    taxRate,
  });

  it('deliveredGross values only what the customer kept, clamped to what left', () => {
    const lines = [line('a', '10', '100', '10'), line('b', '2', '50')];
    expect(deliveredGross(lines).toFixed(4)).toBe('1200.0000');
    expect(deliveredGross(lines, new Map([['a', '8']])).toFixed(4)).toBe('980.0000');
    expect(deliveredGross(lines, new Map([['a', '99'], ['b', '-1']])).toFixed(4)).toBe('1100.0000');
  });

  it('a legacy prepaid delivery (no receipt) is covered in full', () => {
    expect(deliveryAdvance({ prepaid: true, advancePaymentId: null, advanceAmount: '0' }, '750').toFixed(2)).toBe('750.00');
    expect(deliveryAdvance({ prepaid: false, advancePaymentId: 'r1', advanceAmount: '300' }, '750').toFixed(2)).toBe('300.00');
  });

  it('invoicePaidStatus reads the invoice', () => {
    expect(invoicePaidStatus({ balance: '0', amountPaid: '100' })).toBe('paid');
    expect(invoicePaidStatus({ balance: '40', amountPaid: '60' })).toBe('partial');
    expect(invoicePaidStatus({ balance: '100', amountPaid: '0' })).toBe('unpaid');
  });
});
