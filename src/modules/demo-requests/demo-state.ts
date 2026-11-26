import { ConflictException } from '@nestjs/common';
import type { DemoStatus } from './entities/demo-request.entity';

/**
 * The demo pipeline, enforced on the server. Anything else is 409.
 *
 *   new → contacted → scheduled → completed → converted
 *   scheduled → rescheduled → scheduled          (a new time)
 *   scheduled → no_show → rescheduled
 *   any open state → lost                        (a reason is required)
 *
 * A demo can be scheduled straight from `new` (booking a call is contacting).
 * `converted` and `lost` are final.
 */
export const DEMO_TRANSITIONS: Record<DemoStatus, readonly DemoStatus[]> = {
  new: ['contacted', 'scheduled', 'lost'],
  contacted: ['scheduled', 'lost'],
  scheduled: ['completed', 'no_show', 'rescheduled', 'lost'],
  rescheduled: ['scheduled', 'lost'],
  no_show: ['rescheduled', 'lost'],
  completed: ['converted', 'lost'],
  converted: [],
  lost: [],
};

export function canTransition(from: DemoStatus, to: DemoStatus): boolean {
  return DEMO_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: DemoStatus, to: DemoStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({
      code: 'DEMO_INVALID_TRANSITION',
      message: `A demo that is ${from.replace('_', ' ')} cannot be marked ${to.replace('_', ' ')}.`,
      details: { from, to, allowed: DEMO_TRANSITIONS[from] },
    });
  }
}

/** Open = still in the pipeline (counts towards the per-person booking cap). */
export const OPEN_DEMO_STATUSES: readonly DemoStatus[] = [
  'new',
  'contacted',
  'scheduled',
  'rescheduled',
  'no_show',
];

/** Statuses whose time holds a slot. */
export const SLOT_HOLDING_STATUSES: readonly DemoStatus[] = [
  'new',
  'contacted',
  'scheduled',
  'rescheduled',
];

/**
 * The automatic conversion when the prospect signs up from the invite may
 * come from any open or completed state — it is recorded, not chosen.
 */
export function canAutoConvert(from: DemoStatus): boolean {
  return from !== 'converted' && from !== 'lost';
}
