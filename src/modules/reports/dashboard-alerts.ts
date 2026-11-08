/**
 * The "needs attention" items on the admin home dashboard.
 *
 * Pure so the wording and the zero cases can be tested without a database —
 * `dashboardSummary` does the counting and hands the figures here.
 *
 * `count` / `amount` travel next to `message` so a client can word an item for
 * its own layout (the app titles a row "3 overdue invoices" and puts the sum
 * underneath) instead of parsing a number back out of a sentence. `message`
 * stays a complete sentence for clients that just print it (the web's
 * Needs-attention card).
 *
 * The ids and severities are a contract: both clients key their links off the
 * id (overdue → AR aging, pending_bills → AP aging, pending_delivery → the
 * delivery monitor) and their colour off the severity.
 */

export type DashboardAlertSeverity = 'red' | 'amber' | 'blue';

export interface DashboardAlert {
  id: 'overdue' | 'pending_bills' | 'pending_delivery';
  message: string;
  severity: DashboardAlertSeverity;
  /** How many documents the item is about. Absent for a money-only item. */
  count?: number;
  /** The money the item is about, in rupees. */
  amount?: number;
}

export interface DashboardAlertInput {
  /** Every open invoice whose due date has passed — not a sample of recent ones. */
  overdueCount: number;
  /** Their combined open balance. */
  overdueAmount: number;
  /** What is owed to suppliers (net of unapplied vendor credits). */
  pendingAP: number;
  /** Deliveries still waiting for a rider. */
  pendingDeliveries: number;
}

const rupees = (n: number): string =>
  `Rs ${Math.round(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function buildDashboardAlerts(input: DashboardAlertInput): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  const overdue = Math.max(0, Math.trunc(input.overdueCount || 0));
  if (overdue > 0) {
    alerts.push({
      id: 'overdue',
      severity: 'red',
      message: overdue === 1 ? '1 invoice is past due.' : `${overdue} invoices are past due.`,
      count: overdue,
      amount: Math.max(0, input.overdueAmount || 0),
    });
  }

  const ap = Math.max(0, input.pendingAP || 0);
  if (ap > 0) {
    alerts.push({
      id: 'pending_bills',
      severity: 'amber',
      message: `${rupees(ap)} in unpaid bills.`,
      amount: ap,
    });
  }

  const deliveries = Math.max(0, Math.trunc(input.pendingDeliveries || 0));
  if (deliveries > 0) {
    alerts.push({
      id: 'pending_delivery',
      severity: 'blue',
      message:
        deliveries === 1
          ? '1 delivery is waiting to be assigned.'
          : `${deliveries} deliveries are waiting to be assigned.`,
      count: deliveries,
    });
  }

  return alerts;
}
