import { BadRequestException } from '@nestjs/common';

/** Today in the ISO date form every `date` column and posting path uses. */
export function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Reject a posting date in the future.
 *
 * The period lock in PostingService only guards the PAST — it refuses anything
 * dated on or before the closed-books date and has no upper bound at all. So a
 * document dated 2099 posts happily and sits in every future period's report
 * until someone notices.
 *
 * Back-dating is legitimate (it is what the period lock exists to police);
 * forward-dating a completed physical event is not. Anything that records
 * something that has ALREADY happened — stock counted, stock written off —
 * calls this.
 *
 * Compared as ISO strings, matching assertPeriodOpen, so this is a calendar-day
 * comparison in UTC rather than an instant comparison.
 */
export function assertNotFutureDate(date: string, label: string): void {
  if (date > todayIso()) {
    throw new BadRequestException({
      code: 'FUTURE_DATE',
      message: `${label} cannot be dated in the future (got ${date}).`,
    });
  }
}
