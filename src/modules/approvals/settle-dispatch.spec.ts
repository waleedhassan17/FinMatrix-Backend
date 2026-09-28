import { ApprovalDispatcher } from './approval-dispatcher.service';

/**
 * A staff member's settlement is replayed, when the owner approves it, as the
 * same all-or-nothing settlement — not as a plain cash payment that would drop
 * the credits the staff member chose.
 */
describe('ApprovalDispatcher — settlements', () => {
  const make = () => {
    const payments = {
      settle: jest
        .fn()
        .mockResolvedValue({
          payment: { id: 'rct-1', journalEntryId: 'je-1' },
          credits: [],
        }),
      receive: jest.fn(),
      apply: jest.fn(),
    };
    const bills = {
      settle: jest
        .fn()
        .mockResolvedValue({
          payment: null,
          credits: [{ vendorCreditId: 'vc-1' }],
        }),
      pay: jest.fn(),
    };
    const svc = new ApprovalDispatcher(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      bills as never,
      {} as never,
      {} as never,
      payments as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, payments, bills };
  };

  const dispatch = (
    svc: ApprovalDispatcher,
    type: string,
    payload: Record<string, unknown>,
  ) =>
    (
      svc.dispatch as unknown as (
        ...args: unknown[]
      ) => Promise<{ id: string; journalEntryId: string | null }>
    )(type, payload, 'company-1', 'owner-1', {});

  it('replays a customer settlement through settle, credits and all', async () => {
    const { svc, payments } = make();
    const payload = {
      action: 'settle',
      customerId: 'c1',
      paymentDate: '2026-09-28',
      credits: [
        { kind: 'advance', id: 'rct-0', invoiceId: 'i1', amount: '300' },
      ],
      cash: { amount: '500', paymentMethod: 'cash' },
    };
    const out = await dispatch(svc, 'invoice_payment', payload);
    expect(payments.settle).toHaveBeenCalledWith(
      'company-1',
      'owner-1',
      expect.objectContaining(payload),
    );
    expect(payments.receive).not.toHaveBeenCalled();
    expect(out).toEqual({ id: 'rct-1', journalEntryId: 'je-1' });
  });

  it('replays a vendor settlement through settle, even when credit covered it all', async () => {
    const { svc, bills } = make();
    const out = await dispatch(svc, 'bill_payment', {
      action: 'settle',
      vendorId: 'v1',
      paymentDate: '2026-09-28',
      credits: [{ vendorCreditId: 'vc-1', billId: 'b1', amount: '120' }],
    });
    expect(bills.settle).toHaveBeenCalled();
    expect(bills.pay).not.toHaveBeenCalled();
    expect(out).toEqual({ id: 'vc-1', journalEntryId: null });
  });

  it('still replays a plain bill payment as a payment', async () => {
    const { svc, bills } = make();
    bills.pay.mockResolvedValue({ id: 'bp-1', journalEntryId: 'je-2' });
    await dispatch(svc, 'bill_payment', { vendorId: 'v1', applications: [] });
    expect(bills.pay).toHaveBeenCalled();
    expect(bills.settle).not.toHaveBeenCalled();
  });
});
