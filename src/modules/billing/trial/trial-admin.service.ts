import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getPlanConfig } from '../plan-config';
import { requestedPlanLabel } from '../plan-terms';
import { BILLING_TIMEZONE } from '../billing.service';
import {
  businessToday,
  daysBetweenIso,
} from '../../../common/utils/business-date.util';

export type TrialAdminView =
  | 'active'
  | 'held'
  | 'approvals'
  | 'activations'
  | 'ended';

export const TRIAL_ADMIN_VIEWS: TrialAdminView[] = [
  'active',
  'held',
  'approvals',
  'activations',
  'ended',
];

interface ListOptions {
  view: TrialAdminView;
  search?: string;
  page?: number;
  limit?: number;
  /** Active trials ending within this many days (dashboard tile). */
  endingWithinDays?: number;
}

/**
 * Read models for the admin console's "Trials & approvals" page and the
 * dashboard tiles. Read-only: every decision goes through TrialService,
 * BillingService or SuperAdminService.
 */
@Injectable()
export class TrialAdminService {
  constructor(private readonly dataSource: DataSource) {}

  async list(opts: ListOptions) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    let where: string;
    let order = 'c.created_at DESC';
    let joinSubmission = '';
    switch (opts.view) {
      case 'active':
        where = `c.is_trial AND c.trial_converted_at IS NULL
                 AND c.subscription_expiry_date > now() AND c.suspended_at IS NULL`;
        order = 'c.subscription_expiry_date ASC';
        if (opts.endingWithinDays) {
          where += ` AND c.subscription_expiry_date <= now() + (${p(
            opts.endingWithinDays,
          )} || ' days')::interval`;
        }
        break;
      case 'ended':
        where = `c.is_trial AND c.trial_converted_at IS NULL
                 AND c.subscription_expiry_date <= now()`;
        order = 'c.subscription_expiry_date DESC';
        break;
      case 'held':
        joinSubmission = `JOIN platform_payment_submissions s
                            ON s.company_id = c.id AND s.kind = 'TRIAL' AND s.status = 'submitted'`;
        where = 'true';
        order = 's.created_at ASC';
        break;
      case 'activations':
        joinSubmission = `JOIN platform_payment_submissions s
                            ON s.company_id = c.id AND s.kind = 'ACTIVATION' AND s.status = 'submitted'`;
        where = 'true';
        order = 's.created_at ASC';
        break;
      case 'approvals':
      default:
        where = `c.status = 'pending_approval' AND c.suspended_at IS NULL`;
        order = 'c.submitted_at ASC NULLS LAST';
        break;
    }

    const term = opts.search?.trim();
    if (term) {
      const q = p(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where += ` AND (c.name ILIKE ${q} OR c.phone ILIKE ${q} OR o.email ILIKE ${q}
                      OR o.display_name ILIKE ${q})`;
    }

    const from = `FROM companies c
      LEFT JOIN users o ON o.id = c.created_by
      ${joinSubmission}
      WHERE ${where}`;

    const [{ total }] = await this.dataSource.query(
      `SELECT count(*)::int AS total ${from}`,
      params,
    );
    const rows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT c.id, c.name, c.phone, c.industry, c.status, c.is_trial,
              c.trial_started_at, c.subscription_expiry_date, c.subscription_plan,
              c.trial_converted_at, c.requested_plan, c.approval_note,
              c.submitted_at, c.created_at, c.is_demo,
              o.id AS owner_id, o.display_name AS owner_name, o.email AS owner_email,
              o.is_email_verified AS owner_email_verified,
              (SELECT bool_or(ts.auto_approved) FROM platform_payment_submissions ts
                WHERE ts.company_id = c.id AND ts.kind = 'TRIAL' AND ts.status = 'approved')
                AS auto_approved
              ${
                joinSubmission
                  ? `, s.id AS submission_id, s.created_at AS submitted_request_at,
                     s.hold_reason, s.plan AS submission_plan, s.note AS submission_note`
                  : ''
              }
         ${from}
        ORDER BY ${order}
        LIMIT ${p(limit)} OFFSET ${p((page - 1) * limit)}`,
      params,
    );

    const fromDemo = await this.fromDemo(rows.map((r) => r.id));
    const claims =
      opts.view === 'held'
        ? await this.matchedClaimsFor(rows.map((r) => r.submission_id))
        : new Map<string, unknown[]>();
    const today = businessToday(BILLING_TIMEZONE);

    // `items`, not `data`: the response envelope unwraps a top-level `data`
    // and would drop `pagination`.
    return {
      view: opts.view,
      items: rows.map((r) => {
        const endsAt = r.subscription_expiry_date
          ? new Date(r.subscription_expiry_date)
          : null;
        return {
          companyId: r.id,
          companyName: r.name,
          ownerId: r.owner_id,
          ownerName: r.owner_name,
          ownerEmail: r.owner_email,
          ownerEmailVerified: r.owner_email_verified ?? false,
          phone: r.phone,
          businessType: r.industry,
          status: r.status,
          isDemo: r.is_demo,
          fromDemo: fromDemo.has(r.id),
          autoApproved: r.auto_approved === true,
          startedAt: r.trial_started_at,
          endsAt,
          daysLeft: endsAt
            ? daysBetweenIso(today, businessToday(BILLING_TIMEZONE, endsAt))
            : null,
          plan: r.subscription_plan,
          planLabel: getPlanConfig(r.subscription_plan).label,
          requestedPlan: r.requested_plan,
          requestedPlanLabel: r.requested_plan
            ? requestedPlanLabel(r.requested_plan)
            : null,
          approvalNote: r.approval_note,
          submittedAt: r.submitted_request_at ?? r.submitted_at,
          submissionId: r.submission_id ?? null,
          holdReason: r.hold_reason ?? null,
          activationRequestedPlan:
            opts.view === 'activations' ? r.submission_plan : null,
          activationRequestedPlanLabel:
            opts.view === 'activations'
              ? requestedPlanLabel(r.submission_plan)
              : null,
          activationNote:
            opts.view === 'activations' ? r.submission_note : null,
          matchedClaims: claims.get(r.submission_id) ?? [],
        };
      }),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** Counts for the dashboard tiles. */
  async counts() {
    const [row] = await this.dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM companies c
          WHERE c.is_trial AND c.trial_converted_at IS NULL
            AND c.subscription_expiry_date > now() AND c.suspended_at IS NULL) AS active,
        (SELECT count(*)::int FROM companies c
          WHERE c.is_trial AND c.trial_converted_at IS NULL AND c.suspended_at IS NULL
            AND c.subscription_expiry_date > now()
            AND c.subscription_expiry_date <= now() + interval '7 days') AS ending7,
        (SELECT count(*)::int FROM platform_payment_submissions
          WHERE kind = 'TRIAL' AND status = 'submitted') AS held,
        (SELECT count(*)::int FROM companies
          WHERE status = 'pending_approval' AND suspended_at IS NULL) AS approvals,
        (SELECT count(*)::int FROM platform_payment_submissions
          WHERE kind = 'ACTIVATION' AND status = 'submitted') AS activations
    `);
    return {
      activeTrials: row.active,
      trialsEndingIn7Days: row.ending7,
      heldTrials: row.held,
      approvalRequests: row.approvals,
      activationRequests: row.activations,
    };
  }

  /** Every trial claim on this company or its owner, newest first. */
  async claimHistory(companyId: string) {
    const [company] = await this.dataSource.query(
      `SELECT c.id, c.created_by, c.phone, c.tax_id, o.email
         FROM companies c LEFT JOIN users o ON o.id = c.created_by
        WHERE c.id = $1`,
      [companyId],
    );
    if (!company) throw new NotFoundException('Company not found');
    const rows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT t.id, t.status, t.source, t.release_reason, t.created_at, t.decided_at,
              t.company_id, co.name AS company_name, t.user_id,
              (t.company_id = $1) AS same_company,
              (t.user_id = $2) AS same_user
         FROM trial_claims t
         LEFT JOIN companies co ON co.id = t.company_id
        WHERE t.company_id = $1 OR t.user_id = $2
        ORDER BY t.created_at DESC
        LIMIT 100`,
      [companyId, company.created_by],
    );
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      source: r.source,
      releaseReason: r.release_reason,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      companyId: r.company_id,
      companyName: r.company_name,
      matchedOn: [
        ...(r.same_company ? ['company'] : []),
        ...(r.same_user ? ['owner'] : []),
      ],
    }));
  }

  /** Other claims sharing an identity with each held request's claim. */
  private async matchedClaimsFor(submissionIds: string[]) {
    const ids = submissionIds.filter(Boolean);
    const out = new Map<string, unknown[]>();
    if (!ids.length) return out;
    const rows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT mine.submission_id, o.id, o.status, o.source, o.created_at,
              co.name AS company_name,
              (o.email_normalized = mine.email_normalized) AS on_email,
              (o.phone_normalized = mine.phone_normalized) AS on_phone,
              (o.tax_id_normalized = mine.tax_id_normalized) AS on_tax,
              (o.user_id = mine.user_id) AS on_user
         FROM trial_claims mine
         JOIN trial_claims o ON o.id <> mine.id AND (
              o.email_normalized = mine.email_normalized
           OR o.phone_normalized = mine.phone_normalized
           OR o.tax_id_normalized = mine.tax_id_normalized
           OR o.user_id = mine.user_id)
         LEFT JOIN companies co ON co.id = o.company_id
        WHERE mine.submission_id = ANY($1::uuid[])
        ORDER BY o.created_at DESC`,
      [ids],
    );
    for (const r of rows) {
      const list = out.get(r.submission_id) ?? [];
      list.push({
        claimId: r.id,
        status: r.status,
        source: r.source,
        createdAt: r.created_at,
        companyName: r.company_name,
        matchedOn: [
          ...(r.on_email ? ['email'] : []),
          ...(r.on_phone ? ['phone'] : []),
          ...(r.on_tax ? ['ntn'] : []),
          ...(r.on_user ? ['owner'] : []),
        ],
      });
      out.set(r.submission_id, list);
    }
    return out;
  }

  /** Companies linked to a converted demo request (once demo_requests exists). */
  private async fromDemo(companyIds: string[]): Promise<Set<string>> {
    if (!companyIds.length) return new Set();
    const [{ exists }] = await this.dataSource.query(
      `SELECT to_regclass('public.demo_requests') IS NOT NULL AS exists`,
    );
    if (!exists) return new Set();
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT DISTINCT converted_company_id AS id FROM demo_requests
        WHERE converted_company_id = ANY($1::uuid[])`,
      [companyIds],
    );
    return new Set(rows.map((r) => r.id));
  }
}
