import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { normalizeCompanyStatus } from '../../common/utils/company-status.util';
import {
  getPlanConfig,
  isPlanKey,
  isTrialPlan,
  type PlanKey,
} from './plan-config';

/**
 * What a super-admin sends when switching a plan on WITHOUT a payment: a path-B
 * approval, an activation request, or "Activate plan" on a lapsed company.
 */
export interface AdminPlanTermsInput {
  plan?: string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
}

export interface PlanTerms {
  plan: PlanKey;
  planLabel: string;
  start: Date;
  end: Date;
}

/** The plan the owner can ask for when they do not know: shown as "Not sure". */
export const UNSURE_PLAN = 'unsure';

/** Label for a requested plan, including "Not sure". */
export function requestedPlanLabel(plan: string | null | undefined): string {
  if (!plan || plan === UNSURE_PLAN)
    return 'Not sure — FinMatrix will contact me';
  return isPlanKey(plan) ? getPlanConfig(plan).label : plan;
}

function toDate(raw: string | Date | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Validate admin-supplied plan terms. A plan (never `free`, never the trial —
 * that has its own path) and an end date in the future are REQUIRED: no
 * approval may leave a company active with unlimited free access again.
 */
export function parseAdminPlanTerms(
  input: AdminPlanTermsInput,
  now: Date = new Date(),
): PlanTerms {
  const plan = input.plan ?? '';
  if (!isPlanKey(plan) || plan === 'free' || isTrialPlan(plan)) {
    throw new BadRequestException({
      code: 'PLAN_REQUIRED_FOR_APPROVAL',
      message:
        'Choose the plan to switch on (approval needs a plan, a start date and an end date). ' +
        'If you are using an older admin console, update it.',
    });
  }
  const start = toDate(input.startDate) ?? now;
  const end = toDate(input.endDate);
  if (!end) {
    throw new BadRequestException({
      code: 'END_DATE_REQUIRED',
      message: 'Set the date the plan ends.',
    });
  }
  if (end.getTime() <= start.getTime() || end.getTime() <= now.getTime()) {
    throw new BadRequestException({
      code: 'INVALID_PLAN_DATES',
      message: 'The end date must be after the start date and in the future.',
    });
  }
  return { plan, planLabel: getPlanConfig(plan).label, start, end };
}

/**
 * The invariant every activation path asserts before saving: an ACTIVE company
 * has a real plan and an end date. Legacy rows that predate this rule are never
 * re-saved through these paths, so they are untouched; a failure here is a
 * programming error, and it rolls the transaction back.
 *
 * Why not a database CHECK: thousands of legacy companies are active on the
 * never-expiring `free` plan, and the previous release keeps writing such rows
 * during a deploy (migrations run before the new API is live).
 */
export function assertActivePlanTerms(company: {
  status?: string | null;
  subscriptionPlan?: string | null;
  subscriptionExpiryDate?: Date | string | null;
}): void {
  if (normalizeCompanyStatus(company.status) !== 'active') return;
  const plan = company.subscriptionPlan ?? 'free';
  if (plan === 'free' || !company.subscriptionExpiryDate) {
    throw new InternalServerErrorException({
      code: 'ACTIVE_WITHOUT_PLAN_TERMS',
      message: 'Refusing to activate a company without a plan and an end date.',
    });
  }
}
