import { buildDashboardAlerts } from './dashboard-alerts';

const none = { overdueCount: 0, overdueAmount: 0, pendingAP: 0, pendingDeliveries: 0 };

describe('buildDashboardAlerts', () => {
  it('returns nothing when nothing is open', () => {
    expect(buildDashboardAlerts(none)).toEqual([]);
  });

  it('words one overdue invoice in the singular and carries count + amount', () => {
    const [a] = buildDashboardAlerts({ ...none, overdueCount: 1, overdueAmount: 12400 });
    expect(a).toEqual({
      id: 'overdue',
      severity: 'red',
      message: '1 invoice is past due.',
      count: 1,
      amount: 12400,
    });
  });

  it('words several overdue invoices in the plural, with no "(s)"', () => {
    const [a] = buildDashboardAlerts({ ...none, overdueCount: 7, overdueAmount: 90000 });
    expect(a.message).toBe('7 invoices are past due.');
    expect(a.count).toBe(7);
  });

  it('formats unpaid bills as a rounded rupee figure with no count', () => {
    const [a] = buildDashboardAlerts({ ...none, pendingAP: 12399.6 });
    expect(a).toEqual({
      id: 'pending_bills',
      severity: 'amber',
      message: 'Rs 12,400 in unpaid bills.',
      amount: 12399.6,
    });
  });

  it('words deliveries in the singular and plural', () => {
    expect(buildDashboardAlerts({ ...none, pendingDeliveries: 1 })[0].message).toBe(
      '1 delivery is waiting to be assigned.',
    );
    const [a] = buildDashboardAlerts({ ...none, pendingDeliveries: 5 });
    expect(a).toEqual({
      id: 'pending_delivery',
      severity: 'blue',
      message: '5 deliveries are waiting to be assigned.',
      count: 5,
    });
  });

  it('keeps the order overdue → bills → deliveries', () => {
    const ids = buildDashboardAlerts({
      overdueCount: 2,
      overdueAmount: 10,
      pendingAP: 5,
      pendingDeliveries: 3,
    }).map((a) => a.id);
    expect(ids).toEqual(['overdue', 'pending_bills', 'pending_delivery']);
  });

  it('ignores negative and fractional inputs rather than inventing alerts', () => {
    expect(
      buildDashboardAlerts({ overdueCount: -1, overdueAmount: -5, pendingAP: -100, pendingDeliveries: 0.4 }),
    ).toEqual([]);
  });
});
