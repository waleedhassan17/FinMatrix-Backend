import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Readable } from 'stream';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { User } from '../users/entities/user.entity';
import { StorageService } from '../../common/storage/storage.service';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { PlatformAuditService } from '../../common/audit/platform-audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { normalizeCompanyStatus } from '../../common/utils/company-status.util';
import { reconcileRiderSeats } from '../delivery-personnel/rider-seats';
import {
  businessToday,
  daysBetweenIso,
} from '../../common/utils/business-date.util';
import { trialReminderDays } from '../../config/launch.settings';
import { TrialAttempt } from './entities/trial-attempt.entity';

/** Customers are in Pakistan: trial days and reminder dates count in PKT. */
export const BILLING_TIMEZONE = 'Asia/Karachi';
import {
  PaymentSubmission,
  SubmissionKind,
  SubmissionReviewSource,
  SubmissionStatus,
} from './entities/payment-submission.entity';
import {
  AdminPlanTermsInput,
  assertActivePlanTerms,
  parseAdminPlanTerms,
  requestedPlanLabel,
} from './plan-terms';
import { PlatformRevenue } from './entities/platform-revenue.entity';
import { TrialClaim } from './entities/trial-claim.entity';
import {
  formatMinorUnits,
  getPlanConfig,
  getPlatformBank,
  isTrialPlan,
  normalizePlan,
  PLAN_CONFIG,
  PlanKey,
  type PlanConfig,
  plansForType,
  riderSeatLimit,
  trialDurationDays,
  TRIAL_PLAN_KEY,
} from './plan-config';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The days-left thresholds at which a trial-ending reminder (email AND in-app)
 * goes out — TRIAL_REMINDER_DAYS, default 7, 3, 1. Each is sent once per trial
 * period.
 */
export function trialReminderMilestones(): number[] {
  return trialReminderDays();
}

/**
 * The milestone a trial with `days` left has reached — the smallest threshold
 * that is still ≥ days — or null while it is further out than the largest.
 */
export function trialEmailMilestone(days: number): number | null {
  const reached = trialReminderMilestones().filter((m) => days <= m);
  return reached.length ? Math.min(...reached) : null;
}

/** Calendar date (YYYY-MM-DD) of an instant in Asia/Karachi. */
function karachiDate(d: Date): string {
  return businessToday(BILLING_TIMEZONE, d);
}

/** Listing filter: a specific kind, or every non-trial payment. */
export type SubmissionKindFilter = SubmissionKind | 'PAYMENT';

export interface SubmissionListFilters {
  status?: SubmissionStatus;
  kind?: SubmissionKindFilter;
  order?: 'asc' | 'desc';
}

export interface AdminRecipient {
  userId: string;
  email: string | null;
  displayName: string;
}

/** Who is deciding a submission: a super-admin, or the system's instant approval. */
export interface SubmissionReviewer {
  userId: string | null;
  source: SubmissionReviewSource;
}

/** Thrown when a decision would switch on a company a super-admin suspended. */
export function companySuspendedError() {
  return new ConflictException({
    code: 'COMPANY_SUSPENDED',
    message:
      'This company is suspended. Reinstate it before switching a plan on.',
  });
}

/** Add whole months to a date (clamps to end-of-month like most billing systems). */
function addMonths(base: Date, months: number): Date {
  const d = new Date(base.getTime());
  const targetMonth = d.getMonth() + months;
  const result = new Date(d);
  result.setMonth(targetMonth);
  // Guard against e.g. Jan-31 + 1mo landing on Mar-3 — clamp to last day.
  if (result.getDate() < d.getDate()) {
    result.setDate(0);
  }
  return result;
}

/** Why a zero-priced plan cannot be paid for — the trial is requested, not bought. */
function unpayablePlanMessage(plan: PlanKey): string {
  return isTrialPlan(plan)
    ? 'The free trial is not purchased. Request it from the plan selection step instead.'
    : 'The Free plan does not require a payment.';
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(PaymentSubmission)
    private readonly submissionRepo: Repository<PaymentSubmission>,
    @InjectRepository(PlatformRevenue)
    private readonly revenueRepo: Repository<PlatformRevenue>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(UserCompany)
    private readonly userCompanyRepo: Repository<UserCompany>,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly audit: OperationalAuditService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  /**
   * Resolve the company for a billing call. A fresh-signup JWT carries no
   * companyId (the company is created AFTER signin), so fall back to the
   * user's own membership — never to a client-supplied header, which could
   * name someone else's company.
   */
  async resolveCompanyId(
    userId: string,
    jwtCompanyId: string | null,
  ): Promise<string | null> {
    if (jwtCompanyId) return jwtCompanyId;
    const membership = await this.userCompanyRepo.findOne({
      where: { userId },
    });
    return membership?.companyId ?? null;
  }

  // ── Read-only status for the app (renew screen + settings) ────────────────

  async getStatus(companyId: string) {
    const company = await this.getCompanyOrFail(companyId);
    const plan = normalizePlan(company.subscriptionPlan);
    const config = getPlanConfig(plan);
    const now = new Date();
    const expiry = company.subscriptionExpiryDate
      ? new Date(company.subscriptionExpiryDate)
      : null;
    const accountStatus = normalizeCompanyStatus(company.status);
    // Calendar days in Asia/Karachi, the same count the reminders use.
    const daysRemaining = expiry
      ? daysBetweenIso(karachiDate(now), karachiDate(expiry))
      : null;

    const lastSubmission = company.lastSubmissionId
      ? await this.submissionRepo.findOne({
          where: { id: company.lastSubmissionId },
        })
      : null;

    return {
      companyId,
      companyName: company.name,
      plan,
      planLabel: config.label,
      accountStatus, // pending | active | inactive | rejected
      subscriptionStatus: company.subscriptionStatus, // active | expiring | expired
      paymentStatus: company.paymentStatus, // none | submitted | paid | rejected
      startDate: company.subscriptionStartDate,
      expiryDate: expiry,
      daysRemaining,
      // The trial has no month count but does expire (durationDays).
      neverExpires:
        config.durationMonths === null && config.durationDays === undefined,
      priceMinorUnits: config.priceMinorUnits,
      priceLabel: formatMinorUnits(config.priceMinorUnits, config.currency),
      monthlyMinorUnits: config.monthlyMinorUnits,
      monthlyLabel: formatMinorUnits(config.monthlyMinorUnits, config.currency),
      deliveryPersonnelLimit: config.deliveryPersonnelLimit,
      lastSubmission: lastSubmission
        ? {
            id: lastSubmission.id,
            plan: lastSubmission.plan,
            planLabel:
              lastSubmission.kind === 'ACTIVATION'
                ? requestedPlanLabel(lastSubmission.plan)
                : getPlanConfig(lastSubmission.plan).label,
            kind: lastSubmission.kind,
            status: lastSubmission.status,
            amountMinorUnits: lastSubmission.amountMinorUnits,
            rejectionReason: lastSubmission.rejectionReason,
            createdAt: lastSubmission.createdAt,
          }
        : null,
      // ── Free trial ──
      // isTrial is permanent history; "currently trialing" additionally needs
      // no conversion (and an unexpired date, which daysRemaining shows).
      isTrial: company.isTrial,
      trialRequestedAt: company.trialRequestedAt,
      trialStartedAt: company.trialStartedAt,
      trialConvertedAt: company.trialConvertedAt,
      trialDaysRemaining:
        company.isTrial && !company.trialConvertedAt ? daysRemaining : null,
      // Derived from the submission already loaded above — no extra query.
      // requestTrial and createSubmission both point lastSubmissionId at the
      // newest request, so an open trial request is always the last one.
      trialPending:
        lastSubmission?.kind === 'TRIAL' &&
        lastSubmission.status === 'submitted',
      // An activation request is with the FinMatrix team.
      activationPending:
        lastSubmission?.kind === 'ACTIVATION' &&
        lastSubmission.status === 'submitted',
      suspended: !!company.suspendedAt,
    };
  }

  // ── Selectable plans for a company type (FinMatrix.md Phase 2) ────────────

  /**
   * The TWO plan cards (3-month + 6-month) for a company type, with the
   * 6-month savings pre-computed so the client renders, never calculates.
   */
  async getPlansForType(companyId: string, companyTypeOverride?: string) {
    const company = await this.getCompanyOrFail(companyId);
    const companyType =
      companyTypeOverride ?? company.companyType ?? 'warehouse';
    const plans = plansForType(companyType);
    if (plans.length === 0) {
      // This fires whenever the catalogue is EMPTY for the type, which is not
      // the same as the type being invalid. The old message claimed
      // "companyType must be one of small_business | large_org | warehouse"
      // and then rejected small_business and large_org — both perfectly valid
      // names — because this build ships warehouse-only and their catalogues
      // are empty. Saying so plainly stops the next person debugging their
      // request instead of the configuration.
      throw new BadRequestException({
        code: 'NO_PLANS_FOR_COMPANY_TYPE',
        message: `No subscription plans are configured for company type '${companyType}'.`,
        companyType,
      });
    }
    // Savings are measured against the SHORTEST billing period within the
    // same delivery-personnel rung. The previous version hardcoded "3 months
    // vs 6" and searched every plan of the company type, so it silently
    // stopped computing when the offered durations changed, and compared one
    // rung's pricing against another's.
    const baselineForRung = new Map<number, PlanConfig>();
    for (const p of plans) {
      const cur = baselineForRung.get(p.deliveryPersonnelLimit);
      const shorter =
        !cur ||
        (p.durationMonths ?? Infinity) < (cur.durationMonths ?? Infinity);
      if (shorter) baselineForRung.set(p.deliveryPersonnelLimit, p);
    }
    return {
      companyType,
      plans: plans.map((p) => {
        const baseline =
          baselineForRung.get(p.deliveryPersonnelLimit)?.monthlyMinorUnits ??
          p.monthlyMinorUnits;
        const monthlySavings = Math.max(0, baseline - p.monthlyMinorUnits);
        return {
          key: p.key,
          label: p.label,
          durationMonths: p.durationMonths,
          monthlyMinorUnits: p.monthlyMinorUnits,
          monthlyLabel: formatMinorUnits(p.monthlyMinorUnits, p.currency),
          totalMinorUnits: p.priceMinorUnits,
          totalLabel: formatMinorUnits(p.priceMinorUnits, p.currency),
          currency: p.currency,
          deliveryPersonnelLimit: p.deliveryPersonnelLimit,
          monthlySavingsMinorUnits: monthlySavings,
          monthlySavingsLabel:
            monthlySavings > 0
              ? `${formatMinorUnits(monthlySavings, p.currency)}/month`
              : null,
        };
      }),
    };
  }

  // ── Delivery-personnel plan limits ────────────────────────────────────────

  async getPlanLimits(companyId: string) {
    const company = await this.getCompanyOrFail(companyId);
    const plan = normalizePlan(company.subscriptionPlan);
    const config = getPlanConfig(plan);
    const currentCount = await this.countActivePersonnel(companyId);
    const lockedRows: Array<{ count: number }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count
         FROM delivery_personnel_profiles
        WHERE company_id = $1 AND status = 'plan_locked'`,
      [companyId],
    );
    // BILLING-DISABLED BUILD: read the cap through riderSeatLimit() so the
    // uncapped `free` plan is what both clients' usage bars and "can I add
    // another rider?" checks see. Without this the app would still draw
    // "1 of 1 — plan limit reached" over a server that now allows more.
    const seatLimit = riderSeatLimit(config);
    return {
      plan,
      planLabel: config.label,
      deliveryPersonnelLimit: seatLimit,
      currentCount,
      // Riders paused because the plan allows fewer than the company has.
      lockedCount: Number(lockedRows[0]?.count ?? 0),
      canAddMore: currentCount < seatLimit,
      // The next paid tier's limit, for the "upgrade for more" prompt.
      upgradeLimit: PLAN_CONFIG.standard.deliveryPersonnelLimit,
    };
  }

  /** Count of active delivery personnel for a company (never counts removed ones). */
  async countActivePersonnel(companyId: string): Promise<number> {
    const rows: Array<{ count: string }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count
         FROM delivery_personnel_profiles
        WHERE company_id = $1 AND status = 'active'`,
      [companyId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ── Bill + bank details for a chosen plan ─────────────────────────────────

  async getBankDetails(plan: PlanKey) {
    const config = getPlanConfig(plan);
    if (config.priceMinorUnits <= 0) {
      throw new BadRequestException(unpayablePlanMessage(plan));
    }
    return {
      plan: config.key,
      planLabel: config.label,
      durationMonths: config.durationMonths,
      monthlyMinorUnits: config.monthlyMinorUnits,
      monthlyLabel: formatMinorUnits(config.monthlyMinorUnits, config.currency),
      amountDueMinorUnits: config.priceMinorUnits,
      amountDueLabel: formatMinorUnits(config.priceMinorUnits, config.currency),
      currency: config.currency,
      bankAccount: getPlatformBank(),
    };
  }

  // ── Submit a manual payment (screenshot) ──────────────────────────────────

  async createSubmission(
    companyId: string,
    userId: string | null,
    plan: PlanKey,
    file?: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    const company = await this.getCompanyOrFail(companyId);
    const config = getPlanConfig(plan);
    if (config.priceMinorUnits <= 0) {
      throw new BadRequestException(unpayablePlanMessage(plan));
    }
    // Tier plans are only purchasable by their own company type (legacy plans
    // carry companyType null and stay renewable by whoever already has one).
    if (
      config.companyType &&
      company.companyType &&
      config.companyType !== company.companyType
    ) {
      throw new BadRequestException({
        code: 'PLAN_TYPE_MISMATCH',
        message:
          `The "${config.label}" plan is for ${config.companyType.replace(/_/g, ' ')} companies; ` +
          `this company is registered as ${company.companyType.replace(/_/g, ' ')}.`,
      });
    }
    // Legacy plans (standard/pro) are grandfathered ONLY for companies already
    // on that same plan; a tier company must buy one of its own tier plans.
    // Without this, a stale client offering the legacy cards could move a
    // tier company onto legacy pricing.
    if (!config.companyType && company.companyType) {
      const currentPlan = normalizePlan(company.subscriptionPlan);
      if (currentPlan !== plan) {
        throw new BadRequestException({
          code: 'PLAN_TYPE_MISMATCH',
          message:
            `The "${config.label}" plan is no longer offered. Please choose one of the ` +
            `${company.companyType.replace(/_/g, ' ')} plans.`,
        });
      }
    }
    if (!file) {
      throw new BadRequestException('A payment screenshot is required.');
    }
    // A free-trial request is in review. Stacking a payment on top of it would
    // leave two activations racing each other in the admin queue — the owner
    // waits for the trial decision (or it is rejected) first. The mirror guard
    // lives in CompaniesService.requestTrial.
    if (company.lastSubmissionId && company.paymentStatus === 'submitted') {
      const open = await this.submissionRepo.findOne({
        where: { id: company.lastSubmissionId },
      });
      if (open?.kind === 'TRIAL' && open.status === 'submitted') {
        throw new ConflictException({
          code: 'REQUEST_PENDING_REVIEW',
          message:
            'Your free trial request is still being reviewed. You can subscribe once it has been decided.',
        });
      }
    }

    // Persist the screenshot durably via StorageService: Cloudinary
    // (type=authenticated) when configured, Postgres bytea otherwise — never
    // the dyno filesystem. Only the storage key is kept on the submission;
    // the legacy screenshotData bytea remains readable for old rows.
    const stored = await this.storage.putBuffer({
      bucket: 'payment-screenshots',
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
      publicPath: `/billing/submissions/screenshot`,
    });

    const kind = this.determineKind(company, plan);

    const submission = this.submissionRepo.create({
      companyId,
      plan,
      kind,
      status: 'submitted',
      amountMinorUnits: config.priceMinorUnits, // SERVER-set, never from client
      currency: config.currency,
      screenshotKey: stored.key,
      screenshotMime: file.mimetype,
      submittedBy: userId,
    });
    await this.submissionRepo.save(submission);

    // Mark the account as awaiting verification (does not change accountStatus).
    company.paymentStatus = 'submitted';
    company.lastSubmissionId = submission.id;
    await this.companyRepo.save(company);

    this.logger.log(
      `Payment submission ${submission.id} (${kind} ${plan}) for company ${companyId}`,
    );

    return this.toSubmissionView(submission, company.name);
  }

  async getMySubmissions(companyId: string) {
    const rows = await this.submissionRepo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((s) => this.toSubmissionView(s));
  }

  // ── Screenshot streaming (company owns it, or super-admin) ────────────────

  async getScreenshot(
    submissionId: string,
  ): Promise<{ stream: Readable; mime: string; length?: number }> {
    // screenshotData is select:false — pull it explicitly for streaming.
    const submission = await this.submissionRepo
      .createQueryBuilder('s')
      .addSelect('s.screenshotData')
      .where('s.id = :id', { id: submissionId })
      .getOne();
    if (
      !submission ||
      (!submission.screenshotData && !submission.screenshotKey)
    ) {
      throw new NotFoundException('Screenshot not found');
    }
    const mime = submission.screenshotMime ?? 'image/jpeg';

    // Durable copy in Postgres first (survives dyno restarts) …
    if (submission.screenshotData && submission.screenshotData.length > 0) {
      return {
        stream: Readable.from(submission.screenshotData),
        mime,
        length: submission.screenshotData.length,
      };
    }
    // … disk fallback only for legacy rows created before the bytea column.
    const file = submission.screenshotKey
      ? await this.storage.read(submission.screenshotKey)
      : null;
    if (!file)
      throw new NotFoundException('Screenshot file is no longer available');
    return { stream: file.stream, mime };
  }

  async assertOwnsSubmission(submissionId: string, companyId: string) {
    const submission = await this.submissionRepo.findOne({
      where: { id: submissionId },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.companyId !== companyId) {
      throw new ForbiddenException(
        'You do not have access to this submission.',
      );
    }
  }

  // ── Super-admin: list + approve + reject ──────────────────────────────────

  async listSubmissions(filters: SubmissionListFilters = {}) {
    const qb = this.submissionRepo
      .createQueryBuilder('s')
      .leftJoin(Company, 'c', 'c.id = s.companyId')
      .leftJoin(User, 'u', 'u.id = s.submittedBy')
      .addSelect('c.name', 'c_name')
      .addSelect('c.email', 'c_email')
      .addSelect('c.phone', 'c_phone')
      .addSelect('u.displayName', 'u_name')
      .addSelect('u.email', 'u_email')
      .orderBy('s.createdAt', filters.order === 'asc' ? 'ASC' : 'DESC');
    if (filters.status) qb.andWhere('s.status = :st', { st: filters.status });
    if (filters.kind === 'PAYMENT') {
      // Real payments only: trials and activations carry no money.
      qb.andWhere(`s.kind NOT IN ('TRIAL', 'ACTIVATION')`);
    } else if (filters.kind) {
      qb.andWhere('s.kind = :kind', { kind: filters.kind });
    }

    const { entities, raw } = await qb.getRawAndEntities();
    return entities.map((s, i) =>
      this.toSubmissionView(
        s,
        raw[i]?.c_name ?? null,
        raw[i]?.c_email ?? null,
        {
          requesterName: raw[i]?.u_name ?? null,
          requesterEmail: raw[i]?.u_email ?? null,
          requesterPhone: raw[i]?.c_phone ?? null,
        },
      ),
    );
  }

  /**
   * Approve a submission — the single activation path used by ALL three flows.
   * Idempotent: re-approving an already-approved submission returns the same
   * result and records revenue only once (unique submission_id).
   */
  async approveSubmission(
    submissionId: string,
    reviewerId: string,
    decision: AdminPlanTermsInput = {},
  ) {
    // Emails and audit rows go out only once the transaction has COMMITTED:
    // telling an owner their trial is live, then rolling back, is worse than
    // telling them nothing.
    let afterCommit: (() => Promise<void>) | null = null;

    const view = await this.dataSource.transaction(async (em) => {
      const submissionRepo = em.getRepository(PaymentSubmission);
      const companyRepo = em.getRepository(Company);
      const revenueRepo = em.getRepository(PlatformRevenue);

      // Row locks: two admins approving at once (or approve racing reject)
      // serialize instead of both activating.
      const submission = await submissionRepo.findOne({
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!submission) throw new NotFoundException('Submission not found');

      const company = await companyRepo.findOne({
        where: { id: submission.companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!company) throw new NotFoundException('Company not found');

      if (submission.kind === 'TRIAL') {
        const outcome = await this.approveTrialInTransaction(
          em,
          submission,
          company,
          { userId: reviewerId, source: 'admin' },
        );
        afterCommit = outcome.afterCommit;
        return outcome.view;
      }
      if (submission.kind === 'ACTIVATION') {
        const outcome = await this.approveActivation(
          em,
          submission,
          company,
          reviewerId,
          decision,
        );
        afterCommit = outcome.afterCommit;
        return outcome.view;
      }

      // Idempotency: already approved → ensure revenue exists, return as-is.
      if (submission.status === 'approved') {
        await this.ensureRevenue(revenueRepo, submission);
        return this.toSubmissionView(submission, company.name);
      }
      if (submission.status === 'rejected') {
        throw new BadRequestException('This submission was already rejected.');
      }
      if (company.suspendedAt) throw companySuspendedError();

      const plan = normalizePlan(submission.plan);
      const config = getPlanConfig(plan);
      const now = new Date();

      // The first real payment after a free trial. The trial ENDS here: the
      // paid plan starts now, with its full term. Unused trial days are not
      // carried over — the owner chose to subscribe, and the trial's expiry
      // must not be mistaken for a paid expiry to extend from.
      const convertingTrial = company.isTrial && !company.trialConvertedAt;

      // Extend from the later of (now, current expiry) so early action loses no
      // paid days — applies to RENEWAL/UPGRADE of an already-paid plan.
      const hadPaidPlan =
        company.paymentStatus === 'paid' ||
        company.subscriptionExpiryDate != null;
      const currentExpiry = company.subscriptionExpiryDate
        ? new Date(company.subscriptionExpiryDate)
        : null;
      const base =
        !convertingTrial && hadPaidPlan && currentExpiry && currentExpiry > now
          ? currentExpiry
          : now;
      const expiry =
        config.durationMonths === null
          ? null
          : addMonths(base, config.durationMonths);

      // Activate plan + account. NEVER touches business data.
      company.subscriptionPlan = plan;
      company.subscriptionStartDate = now;
      company.subscriptionExpiryDate = expiry;
      company.subscriptionStatus = 'active';
      company.paymentStatus = 'paid';
      company.status = 'active'; // accountStatus → active (restores login)
      company.subscriptionReminderOn = null; // reset reminder dedupe
      company.rejectionReason = null;
      // isTrial is deliberately left true: it is permanent trial history.
      if (convertingTrial) company.trialConvertedAt = now;
      assertActivePlanTerms(company);
      await companyRepo.save(company);

      submission.status = 'approved';
      submission.reviewedBy = reviewerId;
      submission.reviewedAt = now;
      submission.reviewSource = 'admin';
      submission.rejectionReason = null;
      await submissionRepo.save(submission);

      // Record ONE platform_revenue row (idempotent via unique submission_id).
      await this.ensureRevenue(revenueRepo, submission);

      // Keep active riders within the new plan (restores locked riders when
      // the limit went up). Same transaction as the plan change.
      const seats = await reconcileRiderSeats(
        em,
        company.id,
        config.deliveryPersonnelLimit,
      );

      this.logger.log(
        `Approved submission ${submission.id} → company ${company.id} plan=${plan} ` +
          `expiry=${expiry ? expiry.toISOString() : 'never'} by ${reviewerId}` +
          (convertingTrial ? ' (trial converted)' : '') +
          (seats.lock.length || seats.unlock.length
            ? ` seats locked=${seats.lock.length} unlocked=${seats.unlock.length}`
            : ''),
      );

      // Notify the company's admins (best-effort, in-app).
      await this.notifyCompanyAdmins(company.id, {
        type: 'subscription_activated',
        title: convertingTrial
          ? 'Subscription activated — trial ended'
          : 'Subscription activated',
        message: convertingTrial
          ? `Your free trial has ended and your ${config.label} plan is now active` +
            (expiry ? ` until ${expiry.toDateString()}.` : '.')
          : `Your ${config.label} plan is now active` +
            (expiry ? ` until ${expiry.toDateString()}.` : '.'),
        data: { plan, expiryDate: expiry, route: 'billing' },
      });

      afterCommit = () =>
        this.recordSeatChanges(company.id, reviewerId, seats, config);

      return this.toSubmissionView(submission, company.name);
    });

    await this.runAfterCommit(afterCommit);
    return view;
  }

  /**
   * Grant a free trial, INSIDE the caller's transaction, with the submission
   * and company rows already locked by the caller.
   *
   * The one implementation behind every way a trial starts:
   *   - a super-admin approving a held trial (approveSubmission, kind TRIAL);
   *   - the instant approval of an eligible owner (TrialService.start), which
   *     calls this in the SAME transaction that inserted the claim, so two
   *     simultaneous requests can never both get a trial;
   *   - a super-admin approving a path-B request as a trial, or granting one.
   *
   * An approved trial is an ordinary subscription on the trial plan: the same
   * columns, expiry mechanism, CompanyGuard check and cron as a paid one. The
   * trial days are counted from NOW — the moment it is granted — never from
   * the request, so time spent waiting for review is not taken out of it.
   *
   * No platform_revenue row. Notifications, emails and audit run only after
   * the caller's transaction commits (the returned afterCommit).
   */
  async approveTrialInTransaction(
    em: EntityManager,
    submission: PaymentSubmission,
    company: Company,
    reviewer: SubmissionReviewer,
  ): Promise<{
    view: ReturnType<BillingService['toSubmissionView']>;
    afterCommit: () => Promise<void>;
    trialEndsAt: Date | null;
  }> {
    const noop = async () => undefined;
    if (submission.status === 'approved') {
      return {
        view: this.toSubmissionView(submission, company.name),
        afterCommit: noop,
        trialEndsAt: company.subscriptionExpiryDate ?? null,
      };
    }
    if (submission.status === 'rejected') {
      throw new BadRequestException('This trial request was already rejected.');
    }
    if (company.suspendedAt) throw companySuspendedError();
    // Something else activated the company while the request waited (a paid
    // submission, or a manual activation). Granting a trial now would
    // overwrite a real subscription's plan and expiry.
    const accountStatus = normalizeCompanyStatus(company.status);
    if (
      company.isTrial ||
      company.paymentStatus === 'paid' ||
      (accountStatus !== 'draft' &&
        accountStatus !== 'pending' &&
        accountStatus !== 'rejected')
    ) {
      throw new BadRequestException({
        code: 'TRIAL_SUPERSEDED',
        message:
          'This company has already been activated or has used its trial. Reject this request instead.',
      });
    }

    const now = new Date();
    const trialDays = trialDurationDays();
    const trialEndsAt = new Date(now.getTime() + trialDays * DAY_MS);
    const config = getPlanConfig(TRIAL_PLAN_KEY);

    company.isTrial = true;
    company.trialStartedAt = now;
    company.subscriptionPlan = TRIAL_PLAN_KEY;
    company.subscriptionStartDate = now;
    company.subscriptionExpiryDate = trialEndsAt;
    company.subscriptionStatus = 'active';
    company.paymentStatus = 'none';
    company.status = 'active';
    company.subscriptionReminderOn = null;
    company.trialReminderMilestone = null;
    company.rejectionReason = null;
    company.reviewedBy = reviewer.userId;
    company.reviewedAt = now;
    assertActivePlanTerms(company);
    await em.getRepository(Company).save(company);

    submission.status = 'approved';
    submission.reviewedBy = reviewer.userId;
    submission.reviewedAt = now;
    submission.reviewSource = reviewer.source;
    submission.autoApproved = reviewer.source === 'system:auto';
    submission.rejectionReason = null;
    await em.getRepository(PaymentSubmission).save(submission);

    // Only the request's own pending claim becomes approved; a `granted`
    // override keeps its status (it must stay outside the unique indexes).
    await em
      .getRepository(TrialClaim)
      .update(
        { submissionId: submission.id, status: 'pending' },
        { status: 'approved', decidedAt: now },
      );

    const seats = await reconcileRiderSeats(
      em,
      company.id,
      config.deliveryPersonnelLimit,
    );

    this.logger.log(
      `Approved TRIAL ${submission.id} → company ${company.id} ends=${trialEndsAt.toISOString()} ` +
        `by ${reviewer.userId ?? reviewer.source}`,
    );

    const companyName = company.name;
    const companyId = company.id;
    return {
      view: this.toSubmissionView(submission, companyName),
      trialEndsAt,
      afterCommit: async () => {
        await this.notifyCompanyAdmins(companyId, {
          type: 'subscription_activated',
          title: 'Your free trial is active',
          message:
            `Your ${trialDays}-day free trial is active until ${trialEndsAt.toDateString()}. ` +
            'Bring your data in from your old system with the Migration Center.',
          data: {
            plan: TRIAL_PLAN_KEY,
            expiryDate: trialEndsAt,
            route: 'migration',
          },
        });
        if (reviewer.userId) {
          await this.recordSeatChanges(
            companyId,
            reviewer.userId,
            seats,
            config,
          );
        }
        for (const a of await this.adminRecipients(companyId)) {
          if (a.email) {
            await this.mail.sendTrialApprovedEmail(
              a.email,
              a.displayName,
              companyName,
              trialEndsAt,
            );
          }
        }
      },
    };
  }

  /**
   * ACTIVATION branch of approveSubmission: switch a plan on WITHOUT a
   * payment. The admin chooses the plan and dates (defaulting the plan to the
   * one the owner asked for). A running trial ends here and is recorded as
   * converted. No platform_revenue row and nothing on any company's books:
   * this is access control, not a sale.
   */
  private async approveActivation(
    em: EntityManager,
    submission: PaymentSubmission,
    company: Company,
    reviewerId: string,
    decision: AdminPlanTermsInput,
  ): Promise<{
    view: ReturnType<BillingService['toSubmissionView']>;
    afterCommit: () => Promise<void>;
  }> {
    if (submission.status === 'approved') {
      return {
        view: this.toSubmissionView(submission, company.name),
        afterCommit: async () => undefined,
      };
    }
    if (submission.status === 'rejected') {
      throw new BadRequestException('This request was already rejected.');
    }
    if (company.suspendedAt) throw companySuspendedError();

    const terms = parseAdminPlanTerms({
      plan: decision.plan ?? submission.plan,
      startDate: decision.startDate,
      endDate: decision.endDate,
    });
    const now = new Date();
    const converting = company.isTrial && !company.trialConvertedAt;

    company.subscriptionPlan = terms.plan;
    company.subscriptionStartDate = terms.start;
    company.subscriptionExpiryDate = terms.end;
    company.subscriptionStatus = 'active';
    company.paymentStatus = 'none';
    company.status = 'active';
    company.subscriptionReminderOn = null;
    company.rejectionReason = null;
    company.reviewedBy = reviewerId;
    company.reviewedAt = now;
    if (converting) company.trialConvertedAt = now;
    assertActivePlanTerms(company);
    await em.getRepository(Company).save(company);

    submission.plan = terms.plan;
    submission.status = 'approved';
    submission.reviewedBy = reviewerId;
    submission.reviewedAt = now;
    submission.reviewSource = 'admin';
    submission.rejectionReason = null;
    await em.getRepository(PaymentSubmission).save(submission);

    const config = getPlanConfig(terms.plan);
    const seats = await reconcileRiderSeats(
      em,
      company.id,
      config.deliveryPersonnelLimit,
    );

    const companyId = company.id;
    const companyName = company.name;
    return {
      view: this.toSubmissionView(submission, companyName),
      afterCommit: async () => {
        await this.recordSeatChanges(companyId, reviewerId, seats, config);
        await this.notifyCompanyAdmins(companyId, {
          type: 'subscription_activated',
          title: converting
            ? 'Your plan is active — trial converted'
            : 'Your plan is active',
          message: `Your ${terms.planLabel} plan is active until ${terms.end.toDateString()}.`,
          data: { plan: terms.plan, expiryDate: terms.end, route: 'billing' },
        });
        for (const a of await this.adminRecipients(companyId)) {
          if (a.email) {
            await this.mail.sendPlanActivatedEmail(
              a.email,
              a.displayName,
              companyName,
              terms.planLabel,
              terms.end,
            );
          }
        }
        await this.platformAudit.record({
          actorUserId: reviewerId,
          action: 'activation_approved',
          targetType: 'company',
          targetId: companyId,
          companyId,
          companyName,
          details: {
            submissionId: submission.id,
            plan: terms.plan,
            start: terms.start.toISOString(),
            end: terms.end.toISOString(),
            trialConverted: converting,
          },
        });
      },
    };
  }

  async rejectSubmission(
    submissionId: string,
    reviewerId: string,
    reason: string,
    opts: { blockFutureTrials?: boolean } = {},
  ) {
    const peek = await this.submissionRepo.findOne({
      where: { id: submissionId },
    });
    if (!peek) throw new NotFoundException('Submission not found');
    if (peek.kind === 'TRIAL') {
      return this.rejectTrial(
        submissionId,
        reviewerId,
        reason,
        opts.blockFutureTrials === true,
      );
    }
    if (peek.kind === 'ACTIVATION') {
      return this.rejectActivation(submissionId, reviewerId, reason);
    }

    const submission = await this.submissionRepo.findOne({
      where: { id: submissionId },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status === 'approved') {
      throw new BadRequestException('This submission was already approved.');
    }
    submission.status = 'rejected';
    submission.reviewedBy = reviewerId;
    submission.reviewedAt = new Date();
    submission.reviewSource = 'admin';
    submission.rejectionReason = reason;
    await this.submissionRepo.save(submission);

    const company = await this.companyRepo.findOne({
      where: { id: submission.companyId },
    });
    if (company && company.lastSubmissionId === submission.id) {
      company.paymentStatus = 'rejected';
      await this.companyRepo.save(company);
    }

    await this.notifyCompanyAdmins(submission.companyId, {
      type: 'subscription_rejected',
      title: 'Payment could not be verified',
      message: `Your payment was not verified: ${reason}. Please resubmit.`,
      data: { submissionId: submission.id, route: 'billing' },
    });

    return this.toSubmissionView(submission, company?.name ?? null);
  }

  /**
   * Reject a free-trial request. The company stays a draft, so the owner can
   * still choose a paid plan; trialRequestedAt is kept as history.
   *
   *   blockFutureTrials = false → the claim is RELEASED: that email and phone
   *                               may request a trial again (e.g. the request
   *                               was just incomplete).
   *   blockFutureTrials = true  → the claim is BLOCKED, permanently.
   */
  private async rejectTrial(
    submissionId: string,
    reviewerId: string,
    reason: string,
    blockFutureTrials: boolean,
  ) {
    const result = await this.dataSource.transaction(async (em) => {
      const submission = await em.getRepository(PaymentSubmission).findOne({
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!submission) throw new NotFoundException('Submission not found');
      if (submission.status === 'approved') {
        throw new BadRequestException(
          'This trial request was already approved.',
        );
      }
      // A decided claim may already have been superseded by a newer request
      // from the same email/phone; re-deciding the old one could collide with
      // it. One decision per request.
      if (submission.status === 'rejected') {
        throw new BadRequestException(
          'This trial request was already rejected.',
        );
      }

      const now = new Date();
      submission.status = 'rejected';
      submission.reviewedBy = reviewerId;
      submission.reviewedAt = now;
      submission.reviewSource = 'admin';
      submission.rejectionReason = reason;
      await em.getRepository(PaymentSubmission).save(submission);

      const companyRepo = em.getRepository(Company);
      const company = await companyRepo.findOne({
        where: { id: submission.companyId },
        lock: { mode: 'pessimistic_write' },
      });
      // Only undo the "awaiting review" flag this request set — if something
      // newer has happened on the company since, leave it alone.
      if (
        company &&
        company.lastSubmissionId === submission.id &&
        company.paymentStatus === 'submitted'
      ) {
        company.paymentStatus = 'none';
        await companyRepo.save(company);
      }

      await em.getRepository(TrialClaim).update(
        { submissionId: submission.id },
        {
          status: blockFutureTrials ? 'blocked' : 'released',
          releaseReason: blockFutureTrials ? null : 'rejected',
          decidedAt: now,
        },
      );

      return { submission, companyName: company?.name ?? null };
    });

    const { submission, companyName } = result;
    this.logger.log(
      `Rejected TRIAL ${submission.id} for company ${submission.companyId} ` +
        `(${blockFutureTrials ? 'blocked' : 'released'}) by ${reviewerId}`,
    );

    await this.notifyCompanyAdmins(submission.companyId, {
      type: 'subscription_rejected',
      title: 'Free trial not activated',
      message:
        `We couldn't start a free trial: ${reason}. ` +
        'You can still request account approval.',
      data: { submissionId: submission.id, route: 'billing' },
    });

    await this.runAfterCommit(async () => {
      for (const a of await this.adminRecipients(submission.companyId)) {
        if (a.email) {
          await this.mail.sendTrialRejectedEmail(
            a.email,
            a.displayName,
            companyName ?? 'your company',
            reason,
          );
        }
      }
    });

    return this.toSubmissionView(submission, companyName);
  }

  /**
   * Super-admin revenue dashboard: every approved payment (platform_revenue
   * rows — written exactly once per approved submission) with all-time /
   * this-month totals, per-plan breakdown, a 6-month trend, and per-company
   * totals. This is PLATFORM money, unrelated to any company's books.
   */
  /** Reject an ACTIVATION request. The company keeps whatever access it had. */
  private async rejectActivation(
    submissionId: string,
    reviewerId: string,
    reason: string,
  ) {
    const result = await this.dataSource.transaction(async (em) => {
      const submission = await em.getRepository(PaymentSubmission).findOne({
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!submission) throw new NotFoundException('Submission not found');
      if (submission.status !== 'submitted') {
        throw new BadRequestException(
          `This request was already ${submission.status}.`,
        );
      }
      submission.status = 'rejected';
      submission.reviewedBy = reviewerId;
      submission.reviewedAt = new Date();
      submission.reviewSource = 'admin';
      submission.rejectionReason = reason;
      await em.getRepository(PaymentSubmission).save(submission);

      const company = await em.getRepository(Company).findOne({
        where: { id: submission.companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        company &&
        company.lastSubmissionId === submission.id &&
        company.paymentStatus === 'submitted'
      ) {
        company.paymentStatus = 'none';
        await em.getRepository(Company).save(company);
      }
      return { submission, companyName: company?.name ?? null };
    });

    const { submission, companyName } = result;
    await this.runAfterCommit(async () => {
      await this.notifyCompanyAdmins(submission.companyId, {
        type: 'subscription_rejected',
        title: 'Activation request not approved yet',
        message: `We couldn't activate a plan yet: ${reason}.`,
        data: { submissionId: submission.id, route: 'billing' },
      });
      for (const a of await this.adminRecipients(submission.companyId)) {
        if (a.email) {
          await this.mail.sendActivationRejectedEmail(
            a.email,
            a.displayName,
            companyName ?? 'your company',
            reason,
          );
        }
      }
      await this.platformAudit.record({
        actorUserId: reviewerId,
        action: 'activation_rejected',
        targetType: 'company',
        targetId: submission.companyId,
        companyId: submission.companyId,
        companyName,
        reason,
        details: { submissionId: submission.id },
      });
    });
    return this.toSubmissionView(submission, companyName);
  }

  async getRevenueSummary() {
    const { entities, raw } = await this.revenueRepo
      .createQueryBuilder('r')
      .leftJoin(Company, 'c', 'c.id = r.companyId')
      .addSelect('c.name', 'c_name')
      .orderBy('r.recordedAt', 'DESC')
      .getRawAndEntities();

    const entries = entities.map((r, i) => ({
      id: r.id,
      submissionId: r.submissionId,
      companyId: r.companyId,
      companyName: (raw[i]?.c_name as string | null) ?? 'Unknown',
      plan: r.plan,
      planLabel: getPlanConfig(r.plan).label,
      amountMinorUnits: r.amountMinorUnits,
      amountLabel: formatMinorUnits(r.amountMinorUnits, r.currency),
      currency: r.currency,
      recordedAt: r.recordedAt,
    }));

    const now = new Date();
    const monthKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const thisMonthKey = monthKey(now);

    let totalMinorUnits = 0;
    let thisMonthMinorUnits = 0;
    const byPlanMap = new Map<
      string,
      {
        plan: string;
        planLabel: string;
        payments: number;
        totalMinorUnits: number;
      }
    >();
    const byCompanyMap = new Map<
      string,
      {
        companyId: string;
        companyName: string;
        payments: number;
        totalMinorUnits: number;
        lastPlan: string;
      }
    >();

    for (const e of entries) {
      totalMinorUnits += e.amountMinorUnits;
      const recorded = new Date(e.recordedAt);
      if (monthKey(recorded) === thisMonthKey)
        thisMonthMinorUnits += e.amountMinorUnits;

      const p = byPlanMap.get(e.plan) ?? {
        plan: e.plan,
        planLabel: e.planLabel,
        payments: 0,
        totalMinorUnits: 0,
      };
      p.payments += 1;
      p.totalMinorUnits += e.amountMinorUnits;
      byPlanMap.set(e.plan, p);

      const co = byCompanyMap.get(e.companyId) ?? {
        companyId: e.companyId,
        companyName: e.companyName,
        payments: 0,
        totalMinorUnits: 0,
        lastPlan: e.planLabel,
      };
      co.payments += 1;
      co.totalMinorUnits += e.amountMinorUnits;
      byCompanyMap.set(e.companyId, co);
    }

    // Last 6 calendar months (oldest → newest), collected revenue per month.
    const monthly: { year: number; month: number; totalMinorUnits: number }[] =
      [];
    for (let back = 5; back >= 0; back--) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1),
      );
      monthly.push({
        year: d.getUTCFullYear(),
        month: d.getUTCMonth(),
        totalMinorUnits: 0,
      });
    }
    for (const e of entries) {
      const d = new Date(e.recordedAt);
      const slot = monthly.find(
        (m) => m.year === d.getUTCFullYear() && m.month === d.getUTCMonth(),
      );
      if (slot) slot.totalMinorUnits += e.amountMinorUnits;
    }

    const pendingCount = await this.submissionRepo.count({
      where: { status: 'submitted' },
    });

    return {
      totalMinorUnits,
      totalLabel: formatMinorUnits(totalMinorUnits),
      thisMonthMinorUnits,
      thisMonthLabel: formatMinorUnits(thisMonthMinorUnits),
      paymentsCount: entries.length,
      pendingSubmissions: pendingCount,
      byPlan: [...byPlanMap.values()].sort(
        (a, b) => b.totalMinorUnits - a.totalMinorUnits,
      ),
      byCompany: [...byCompanyMap.values()].sort(
        (a, b) => b.totalMinorUnits - a.totalMinorUnits,
      ),
      monthly,
      entries: entries.slice(0, 50),
    };
  }

  // ── Scheduled expiry + reminder scan (idempotent; run daily by cron) ──────

  /**
   * phase2.md step 5. For paid plans only:
   *  - within 10 days of expiry → subscriptionStatus='expiring' + ONE reminder
   *    notification per day (deduped by `subscription_reminder_on`).
   *  - on/after expiry → subscriptionStatus='expired', accountStatus='inactive'
   *    (login blocked → renew-only). Business data is NEVER touched.
   * Free plans are skipped entirely. Safe to run many times per day.
   */
  async runExpiryScan(now: Date = new Date()) {
    // Calendar days in Asia/Karachi — never UTC, never a rounded-up fraction.
    // A trial ending at 3 pm today has 0 days left today, 1 day left yesterday.
    const today = karachiDate(now);
    let remindersSent = 0;
    let expiringMarked = 0;
    let deactivated = 0;

    // Only paid plans with an expiry date participate. A trial REQUEST still in
    // review has no expiry date (it is set at approval), so it never reaches
    // this loop; an APPROVED trial does, like any other plan.
    const companies = await this.companyRepo
      .createQueryBuilder('c')
      .where(`c.subscriptionPlan <> 'free'`)
      .andWhere('c.subscriptionExpiryDate IS NOT NULL')
      .getMany();

    for (const company of companies) {
      const expiry = new Date(
        company.subscriptionExpiryDate as unknown as Date,
      );
      const accountStatus = normalizeCompanyStatus(company.status);
      const trialing = company.isTrial && !company.trialConvertedAt;
      const suspended = !!company.suspendedAt;

      if (expiry.getTime() > now.getTime()) {
        // Still active — reminder window?
        const days = daysBetweenIso(today, karachiDate(expiry));
        if (days <= 10) {
          if (company.subscriptionStatus !== 'expiring') {
            company.subscriptionStatus = 'expiring';
            expiringMarked += 1;
          }
          // A suspended company gets no reminders: nobody can act on them.
          if (trialing && !suspended) {
            // Trials: ONE reminder (email + in-app) per milestone. Compared
            // against the last one sent rather than exact day numbers, so a
            // missed cron run still sends the next one.
            const milestone = trialEmailMilestone(days);
            const due =
              milestone !== null &&
              (company.trialReminderMilestone === null ||
                milestone < company.trialReminderMilestone);
            if (due) company.trialReminderMilestone = milestone;
            await this.companyRepo.save(company);
            if (due) {
              remindersSent += 1;
              await this.notifyCompanyAdmins(company.id, {
                type: 'subscription_expiring',
                title: 'Free trial ending soon',
                message:
                  days <= 0
                    ? 'Your free trial ends today. Request activation to keep going without a break.'
                    : `Your free trial ends in ${days} day${days === 1 ? '' : 's'}. ` +
                      'Request activation to keep going without a break.',
                data: {
                  daysRemaining: days,
                  expiryDate: expiry,
                  route: 'billing',
                },
              });
              for (const a of await this.adminRecipients(company.id)) {
                if (a.email) {
                  await this.mail.sendTrialEndingEmail(
                    a.email,
                    a.displayName,
                    company.name,
                    Math.max(days, 0),
                  );
                }
              }
            }
          } else if (!suspended) {
            // Paid plans keep the daily in-app reminder (unchanged).
            if (company.subscriptionReminderOn !== today) {
              company.subscriptionReminderOn = today;
              await this.notifyCompanyAdmins(company.id, {
                type: 'subscription_expiring',
                title: 'Subscription expiring soon',
                message:
                  `Your ${getPlanConfig(company.subscriptionPlan).label} plan expires in ` +
                  `${days} day${days === 1 ? '' : 's'}. Request activation to avoid interruption.`,
                data: {
                  daysRemaining: days,
                  expiryDate: expiry,
                  route: 'billing',
                },
              });
              remindersSent += 1;
            }
            await this.companyRepo.save(company);
          } else {
            await this.companyRepo.save(company);
          }
        } else if (company.subscriptionStatus !== 'active') {
          // Moved back outside the window (e.g. after renewal) — normalize.
          company.subscriptionStatus = 'active';
          await this.companyRepo.save(company);
        }
      } else {
        // Expired. Deactivate the account ONCE — never delete data.
        if (suspended) {
          // A suspension outranks expiry: keep status 'suspended', and make
          // reinstating land on the expired state rather than on 'active'.
          if (
            company.subscriptionStatus !== 'expired' ||
            company.statusBeforeSuspension !== 'inactive'
          ) {
            company.subscriptionStatus = 'expired';
            company.statusBeforeSuspension = 'inactive';
            await this.companyRepo.save(company);
          }
          continue;
        }
        const alreadyHandled =
          company.subscriptionStatus === 'expired' &&
          accountStatus === 'inactive';
        if (!alreadyHandled) {
          company.subscriptionStatus = 'expired';
          company.status = 'inactive';
          await this.companyRepo.save(company);
          deactivated += 1;
          if (trialing) {
            await this.notifyCompanyAdmins(company.id, {
              type: 'subscription_expired',
              title: 'Your free trial has ended',
              message:
                'Your free trial has ended, so your account is paused. Your data is safe: ' +
                'download a backup any time, or request activation to keep using FinMatrix.',
              data: { route: 'billing' },
            });
            for (const a of await this.adminRecipients(company.id)) {
              if (a.email)
                await this.mail.sendTrialEndedEmail(
                  a.email,
                  a.displayName,
                  company.name,
                );
            }
          } else {
            await this.notifyCompanyAdmins(company.id, {
              type: 'subscription_expired',
              title: 'Plan ended — request activation to restore',
              message:
                'Your plan has ended and your account is paused. Your data is safe. ' +
                'Request activation to restore full access.',
              data: { route: 'billing' },
            });
          }
        }
      }
    }

    // The per-IP trial-attempt counter only needs the last day; keep a month.
    await this.dataSource
      .getRepository(TrialAttempt)
      .createQueryBuilder()
      .delete()
      .where(`created_at < now() - interval '30 days'`)
      .execute();

    this.logger.log(
      `Expiry scan: ${expiringMarked} expiring, ${remindersSent} reminders, ${deactivated} deactivated`,
    );
    return {
      remindersSent,
      expiringMarked,
      deactivated,
      scanned: companies.length,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getCompanyOrFail(companyId: string): Promise<Company> {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private determineKind(company: Company, plan: PlanKey): SubmissionKind {
    // The first payment after a free trial is the company's first purchase —
    // label it NEW whether the trial is still running or has lapsed, rather
    // than a RENEWAL/UPGRADE of a plan nobody ever paid for.
    if (company.isTrial && !company.trialConvertedAt) return 'NEW';
    const accountStatus = normalizeCompanyStatus(company.status);
    const currentPlan = normalizePlan(company.subscriptionPlan);
    // An expired/deactivated account restoring access = RENEWAL.
    if (
      accountStatus === 'inactive' ||
      company.subscriptionStatus === 'expired'
    ) {
      return 'RENEWAL';
    }
    if (currentPlan !== 'free') {
      return plan === currentPlan ? 'RENEWAL' : 'UPGRADE';
    }
    // Currently Free: a running (active) company moving to paid is an UPGRADE
    // (Flow 3); a brand-new not-yet-active signup is NEW (Flow 1).
    return accountStatus === 'active' ? 'UPGRADE' : 'NEW';
  }

  private async ensureRevenue(
    revenueRepo: Repository<PlatformRevenue>,
    submission: PaymentSubmission,
  ) {
    const existing = await revenueRepo.findOne({
      where: { submissionId: submission.id },
    });
    if (existing) return existing;
    try {
      return await revenueRepo.save(
        revenueRepo.create({
          submissionId: submission.id,
          companyId: submission.companyId,
          plan: submission.plan,
          amountMinorUnits: submission.amountMinorUnits,
          currency: submission.currency,
          recordedAt: new Date(),
        }),
      );
    } catch (err) {
      // Unique-constraint race → someone else recorded it; that's fine.
      const again = await revenueRepo.findOne({
        where: { submissionId: submission.id },
      });
      if (again) return again;
      throw err;
    }
  }

  async notifyCompanyAdmins(
    companyId: string,
    payload: {
      type: string;
      title: string;
      message: string;
      data?: Record<string, unknown>;
    },
  ) {
    const admins = await this.userCompanyRepo.find({
      where: { companyId, role: 'admin' },
    });
    for (const a of admins) {
      await this.notifications.create({
        companyId,
        userId: a.userId,
        ...payload,
      });
    }
  }

  /** Company admins who should hear about billing events, with their inbox. */
  async adminRecipients(companyId: string): Promise<AdminRecipient[]> {
    const admins = await this.userCompanyRepo.find({
      where: { companyId, role: 'admin' },
      relations: { user: true },
    });
    return admins.map((a) => ({
      userId: a.userId,
      email: a.user?.email ?? null,
      displayName: a.user?.displayName ?? 'there',
    }));
  }

  /**
   * Post-commit side effects (email, audit). Never allowed to fail the call
   * that already committed — the decision stands; a lost email is logged.
   */
  async runAfterCommit(fn: (() => Promise<void>) | null): Promise<void> {
    if (!fn) return;
    try {
      await fn();
    } catch (err) {
      this.logger.error(
        `Post-commit side effect failed: ${(err as Error).message}`,
      );
    }
  }

  /** Audit + tell the owner which riders a plan change locked or restored. */
  private async recordSeatChanges(
    companyId: string,
    actorUserId: string,
    seats: { lock: string[]; unlock: string[] },
    config: PlanConfig,
  ): Promise<void> {
    for (const userId of seats.lock) {
      await this.audit.record({
        companyId,
        actorUserId,
        action: 'personnel_plan_locked',
        targetType: 'delivery_personnel',
        targetId: userId,
        details: { plan: config.key, limit: config.deliveryPersonnelLimit },
      });
    }
    for (const userId of seats.unlock) {
      await this.audit.record({
        companyId,
        actorUserId,
        action: 'personnel_plan_unlocked',
        targetType: 'delivery_personnel',
        targetId: userId,
        details: { plan: config.key, limit: config.deliveryPersonnelLimit },
      });
    }
    if (seats.lock.length > 0) {
      const n = seats.lock.length;
      await this.notifyCompanyAdmins(companyId, {
        type: 'personnel_plan_locked',
        title: `${n} delivery rider${n === 1 ? '' : 's'} paused`,
        message:
          `Your ${config.label} plan includes ${config.deliveryPersonnelLimit} active ` +
          `rider${config.deliveryPersonnelLimit === 1 ? '' : 's'}, so ${n} ` +
          `${n === 1 ? 'rider was' : 'riders were'} paused. Upgrade your plan, or deactivate ` +
          'a rider and reactivate a paused one to swap seats.',
        data: { lockedUserIds: seats.lock, route: 'delivery-personnel' },
      });
    }
  }

  private toSubmissionView(
    s: PaymentSubmission,
    companyName?: string | null,
    companyEmail?: string | null,
    requester?: {
      requesterName: string | null;
      requesterEmail: string | null;
      requesterPhone: string | null;
    },
  ) {
    const createdAt = new Date(s.createdAt);
    return {
      id: s.id,
      companyId: s.companyId,
      companyName: companyName ?? undefined,
      companyEmail: companyEmail ?? undefined,
      plan: s.plan,
      planLabel:
        s.kind === 'ACTIVATION' && s.status === 'submitted'
          ? requestedPlanLabel(s.plan)
          : getPlanConfig(s.plan).label,
      kind: s.kind,
      status: s.status,
      autoApproved: s.autoApproved ?? false,
      reviewSource: s.reviewSource ?? null,
      // Super-admin views only — the owner never sees why a trial was held.
      holdReason: s.holdReason ?? null,
      note: s.note ?? null,
      amountMinorUnits: s.amountMinorUnits,
      amountLabel: formatMinorUnits(s.amountMinorUnits, s.currency),
      currency: s.currency,
      hasScreenshot: !!s.screenshotKey,
      rejectionReason: s.rejectionReason,
      reviewedAt: s.reviewedAt,
      createdAt: s.createdAt,
      // Who asked, and how long they have waited — a trial row has no amount
      // or screenshot to review, so this is what the admin decides on. The
      // owner was promised activation within 24 hours.
      requesterName: requester?.requesterName ?? undefined,
      requesterEmail: requester?.requesterEmail ?? undefined,
      requesterPhone: requester?.requesterPhone ?? undefined,
      ageHours:
        s.status === 'submitted'
          ? Math.max(
              0,
              Math.round(
                ((Date.now() - createdAt.getTime()) / 3_600_000) * 10,
              ) / 10,
            )
          : null,
    };
  }
}
