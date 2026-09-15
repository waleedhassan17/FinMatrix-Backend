// ═══════════════════════════════════════════════════════
// FinMatrix — Rider seats: keeping active riders within the plan
// ═══════════════════════════════════════════════════════
// Plans differ by how many delivery riders may be ACTIVE at once. create()
// has always refused a rider beyond the limit, but nothing brought a company
// back within it when the limit itself went DOWN (a downgrade, or a renewal
// onto a smaller plan) — the extras simply kept working for free.
//
// reconcileRiderSeats runs whenever a plan is activated. Riders beyond the
// limit move to `plan_locked`: their account, history and deliveries are kept,
// but they cannot sign in or be assigned work (CompanyGuard + assignment
// checks). When the limit goes back UP, locked riders are restored first.
//
// WHO KEEPS A SEAT is decided by the server, deterministically, so a paying
// company is never left waiting on a choice:
//   1. riders with a delivery in progress — locking them would strand stock
//      that is already out on the road;
//   2. then the longest-serving riders;
//   3. user id as a final tie-break so the result never depends on row order.
// The owner can still swap: deactivate one rider, then reactivate a locked one
// (DeliveryPersonnelService.update checks the seat count on every activation).
//
// `inactive` and `on_leave` riders are never touched — those were the owner's
// decisions, not the plan's.

import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/** Delivery statuses that mean work is assigned and not yet finished. */
export const OPEN_DELIVERY_STATUSES = ['pending', 'picked_up', 'in_transit', 'arrived'] as const;

export interface SeatCandidate {
  userId: string;
  status: 'active' | 'plan_locked';
  hasOpenDelivery: boolean;
  createdAt: Date;
}

export interface SeatPlan {
  /** Riders to move active → plan_locked. */
  lock: string[];
  /** Riders to move plan_locked → active. */
  unlock: string[];
}

/** Pure ranking — which candidates keep a seat under `limit`. */
export function planRiderSeats(candidates: SeatCandidate[], limit: number): SeatPlan {
  const ranked = [...candidates].sort((a, b) => {
    if (a.hasOpenDelivery !== b.hasOpenDelivery) return a.hasOpenDelivery ? -1 : 1;
    const byAge = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (byAge !== 0) return byAge;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const seats = Math.max(0, limit);
  const lock: string[] = [];
  const unlock: string[] = [];
  ranked.forEach((c, i) => {
    const keeps = i < seats;
    if (keeps && c.status === 'plan_locked') unlock.push(c.userId);
    if (!keeps && c.status === 'active') lock.push(c.userId);
  });
  return { lock, unlock };
}

/**
 * Bring a company's active riders within `limit`, inside the caller's
 * transaction. Rows are locked FOR UPDATE so a concurrent rider activation
 * cannot slip past the count.
 */
export async function reconcileRiderSeats(
  em: EntityManager,
  companyId: string,
  limit: number,
): Promise<SeatPlan> {
  const rows: Array<{
    user_id: string;
    status: 'active' | 'plan_locked';
    created_at: Date;
    has_open_delivery: boolean;
  }> = await em.query(
    `SELECT p.user_id, p.status, p.created_at,
            EXISTS (
              SELECT 1 FROM deliveries d
               WHERE d.company_id = p.company_id
                 AND d.personnel_id = p.user_id
                 AND d.status = ANY($2)
            ) AS has_open_delivery
       FROM delivery_personnel_profiles p
      WHERE p.company_id = $1
        AND p.status IN ('active', 'plan_locked')
      FOR UPDATE OF p`,
    [companyId, [...OPEN_DELIVERY_STATUSES]],
  );

  const plan = planRiderSeats(
    rows.map((r) => ({
      userId: r.user_id,
      status: r.status,
      hasOpenDelivery: r.has_open_delivery === true,
      createdAt: r.created_at,
    })),
    limit,
  );

  if (plan.lock.length > 0) {
    await em.query(
      `UPDATE delivery_personnel_profiles
          SET status = 'plan_locked', is_available = false, updated_at = now()
        WHERE company_id = $1 AND user_id = ANY($2) AND status = 'active'`,
      [companyId, plan.lock],
    );
  }
  if (plan.unlock.length > 0) {
    await em.query(
      `UPDATE delivery_personnel_profiles
          SET status = 'active', updated_at = now()
        WHERE company_id = $1 AND user_id = ANY($2) AND status = 'plan_locked'`,
      [companyId, plan.unlock],
    );
  }
  return plan;
}

/**
 * Refuse to hand work to a rider who is not active — locked by the plan,
 * deactivated or on leave. Checked before any stock is committed.
 */
export async function assertRiderAssignable(
  em: EntityManager,
  companyId: string,
  personnelId: string,
): Promise<void> {
  const rows: Array<{ status: string }> = await em.query(
    `SELECT status FROM delivery_personnel_profiles
      WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
    [companyId, personnelId],
  );
  const status = rows[0]?.status;
  // No profile row: not this guard's concern — assignment has never required
  // one, and seed/legacy riders exist without it. This guard only refuses a
  // rider the company has explicitly paused, deactivated or put on leave.
  if (status && status !== 'active') {
    throw new BadRequestException({
      code: 'RIDER_NOT_ACTIVE',
      message:
        status === 'plan_locked'
          ? "This rider is paused because your plan's rider limit has been reached. Upgrade your plan or swap riders to assign work to them."
          : 'This rider is not active. Reactivate them before assigning deliveries.',
    });
  }
}

/** Shown to a locked rider at sign-in and on any request CompanyGuard stops. */
export const RIDER_SEAT_LOCKED_MESSAGE =
  "Your company's current plan doesn't include your rider seat right now. Ask your manager to upgrade the plan or reassign seats.";
