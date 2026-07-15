import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Readable } from 'stream';
import { DataSource, Repository } from 'typeorm';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { StorageService } from '../../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { normalizeCompanyStatus } from '../../common/utils/company-status.util';
import {
  PaymentSubmission,
  SubmissionKind,
} from './entities/payment-submission.entity';
import { PlatformRevenue } from './entities/platform-revenue.entity';
import {
  formatMinorUnits,
  getPlanConfig,
  getPlatformBank,
  normalizePlan,
  PLAN_CONFIG,
  PlanKey,
  plansForType,
} from './plan-config';

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

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
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
  ) {}

  /**
   * Resolve the company for a billing call. A fresh-signup JWT carries no
   * companyId (the company is created AFTER signin), so fall back to the
   * user's own membership — never to a client-supplied header, which could
   * name someone else's company.
   */
  async resolveCompanyId(userId: string, jwtCompanyId: string | null): Promise<string | null> {
    if (jwtCompanyId) return jwtCompanyId;
    const membership = await this.userCompanyRepo.findOne({ where: { userId } });
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
    const daysRemaining = expiry ? daysBetween(now, expiry) : null;

    const lastSubmission = company.lastSubmissionId
      ? await this.submissionRepo.findOne({ where: { id: company.lastSubmissionId } })
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
      neverExpires: config.durationMonths === null,
      priceMinorUnits: config.priceMinorUnits,
      priceLabel: formatMinorUnits(config.priceMinorUnits, config.currency),
      monthlyMinorUnits: config.monthlyMinorUnits,
      monthlyLabel: formatMinorUnits(config.monthlyMinorUnits, config.currency),
      deliveryPersonnelLimit: config.deliveryPersonnelLimit,
      lastSubmission: lastSubmission
        ? {
            id: lastSubmission.id,
            plan: lastSubmission.plan,
            kind: lastSubmission.kind,
            status: lastSubmission.status,
            amountMinorUnits: lastSubmission.amountMinorUnits,
            rejectionReason: lastSubmission.rejectionReason,
            createdAt: lastSubmission.createdAt,
          }
        : null,
    };
  }

  // ── Selectable plans for a company type (FinMatrix.md Phase 2) ────────────

  /**
   * The TWO plan cards (3-month + 6-month) for a company type, with the
   * 6-month savings pre-computed so the client renders, never calculates.
   */
  async getPlansForType(companyId: string, companyTypeOverride?: string) {
    const company = await this.getCompanyOrFail(companyId);
    const companyType = companyTypeOverride ?? company.companyType ?? 'warehouse';
    const plans = plansForType(companyType);
    if (plans.length === 0) {
      throw new BadRequestException(
        'companyType must be one of small_business | large_org | warehouse.',
      );
    }
    const threeMo = plans.find((p) => p.durationMonths === 3);
    return {
      companyType,
      plans: plans.map((p) => {
        const monthlySavings =
          threeMo && p.durationMonths === 6
            ? threeMo.monthlyMinorUnits - p.monthlyMinorUnits
            : 0;
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
            monthlySavings > 0 ? `${formatMinorUnits(monthlySavings, p.currency)}/month` : null,
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
    return {
      plan,
      planLabel: config.label,
      deliveryPersonnelLimit: config.deliveryPersonnelLimit,
      currentCount,
      canAddMore: currentCount < config.deliveryPersonnelLimit,
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
      throw new BadRequestException('The Free plan does not require a payment.');
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
      throw new BadRequestException('The Free plan does not require a payment.');
    }
    // Tier plans are only purchasable by their own company type (legacy plans
    // carry companyType null and stay renewable by whoever already has one).
    if (config.companyType && company.companyType && config.companyType !== company.companyType) {
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
    if (!submission || (!submission.screenshotData && !submission.screenshotKey)) {
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
    if (!file) throw new NotFoundException('Screenshot file is no longer available');
    return { stream: file.stream, mime };
  }

  async assertOwnsSubmission(submissionId: string, companyId: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.companyId !== companyId) {
      throw new ForbiddenException('You do not have access to this submission.');
    }
  }

  // ── Super-admin: list + approve + reject ──────────────────────────────────

  async listSubmissions(status?: 'submitted' | 'approved' | 'rejected') {
    const qb = this.submissionRepo
      .createQueryBuilder('s')
      .leftJoin(Company, 'c', 'c.id = s.companyId')
      .addSelect('c.name', 'c_name')
      .addSelect('c.email', 'c_email')
      .orderBy('s.createdAt', 'DESC');
    if (status) qb.where('s.status = :st', { st: status });

    const { entities, raw } = await qb.getRawAndEntities();
    return entities.map((s, i) =>
      this.toSubmissionView(s, raw[i]?.c_name ?? null, raw[i]?.c_email ?? null),
    );
  }

  /**
   * Approve a submission — the single activation path used by ALL three flows.
   * Idempotent: re-approving an already-approved submission returns the same
   * result and records revenue only once (unique submission_id).
   */
  async approveSubmission(submissionId: string, reviewerId: string) {
    return this.dataSource.transaction(async (em) => {
      const submissionRepo = em.getRepository(PaymentSubmission);
      const companyRepo = em.getRepository(Company);
      const revenueRepo = em.getRepository(PlatformRevenue);

      const submission = await submissionRepo.findOne({ where: { id: submissionId } });
      if (!submission) throw new NotFoundException('Submission not found');

      const company = await companyRepo.findOne({ where: { id: submission.companyId } });
      if (!company) throw new NotFoundException('Company not found');

      // Idempotency: already approved → ensure revenue exists, return as-is.
      if (submission.status === 'approved') {
        await this.ensureRevenue(revenueRepo, submission);
        return this.toSubmissionView(submission, company.name);
      }
      if (submission.status === 'rejected') {
        throw new BadRequestException('This submission was already rejected.');
      }

      const plan = normalizePlan(submission.plan);
      const config = getPlanConfig(plan);
      const now = new Date();

      // Extend from the later of (now, current expiry) so early action loses no
      // paid days — applies to RENEWAL/UPGRADE of an already-paid plan.
      const hadPaidPlan =
        company.paymentStatus === 'paid' || company.subscriptionExpiryDate != null;
      const currentExpiry = company.subscriptionExpiryDate
        ? new Date(company.subscriptionExpiryDate)
        : null;
      const base =
        hadPaidPlan && currentExpiry && currentExpiry > now ? currentExpiry : now;
      const expiry =
        config.durationMonths === null ? null : addMonths(base, config.durationMonths);

      // Activate plan + account. NEVER touches business data.
      company.subscriptionPlan = plan;
      company.subscriptionStartDate = now;
      company.subscriptionExpiryDate = expiry;
      company.subscriptionStatus = 'active';
      company.paymentStatus = 'paid';
      company.status = 'active'; // accountStatus → active (restores login)
      company.subscriptionReminderOn = null; // reset reminder dedupe
      company.rejectionReason = null;
      await companyRepo.save(company);

      submission.status = 'approved';
      submission.reviewedBy = reviewerId;
      submission.reviewedAt = now;
      submission.rejectionReason = null;
      await submissionRepo.save(submission);

      // Record ONE platform_revenue row (idempotent via unique submission_id).
      await this.ensureRevenue(revenueRepo, submission);

      this.logger.log(
        `Approved submission ${submission.id} → company ${company.id} plan=${plan} ` +
          `expiry=${expiry ? expiry.toISOString() : 'never'} by ${reviewerId}`,
      );

      // Notify the company's admins (best-effort, in-app).
      await this.notifyCompanyAdmins(company.id, {
        type: 'subscription_activated',
        title: 'Subscription activated',
        message:
          `Your ${config.label} plan is now active` +
          (expiry ? ` until ${expiry.toDateString()}.` : '.'),
        data: { plan, expiryDate: expiry, route: 'billing' },
      });

      return this.toSubmissionView(submission, company.name);
    });
  }

  async rejectSubmission(submissionId: string, reviewerId: string, reason: string) {
    const submission = await this.submissionRepo.findOne({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status === 'approved') {
      throw new BadRequestException('This submission was already approved.');
    }
    submission.status = 'rejected';
    submission.reviewedBy = reviewerId;
    submission.reviewedAt = new Date();
    submission.rejectionReason = reason;
    await this.submissionRepo.save(submission);

    const company = await this.companyRepo.findOne({ where: { id: submission.companyId } });
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
   * Super-admin revenue dashboard: every approved payment (platform_revenue
   * rows — written exactly once per approved submission) with all-time /
   * this-month totals, per-plan breakdown, a 6-month trend, and per-company
   * totals. This is PLATFORM money, unrelated to any company's books.
   */
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
    const byPlanMap = new Map<string, { plan: string; planLabel: string; payments: number; totalMinorUnits: number }>();
    const byCompanyMap = new Map<string, { companyId: string; companyName: string; payments: number; totalMinorUnits: number; lastPlan: string }>();

    for (const e of entries) {
      totalMinorUnits += e.amountMinorUnits;
      const recorded = new Date(e.recordedAt);
      if (monthKey(recorded) === thisMonthKey) thisMonthMinorUnits += e.amountMinorUnits;

      const p = byPlanMap.get(e.plan) ?? { plan: e.plan, planLabel: e.planLabel, payments: 0, totalMinorUnits: 0 };
      p.payments += 1;
      p.totalMinorUnits += e.amountMinorUnits;
      byPlanMap.set(e.plan, p);

      const co = byCompanyMap.get(e.companyId) ?? {
        companyId: e.companyId, companyName: e.companyName, payments: 0, totalMinorUnits: 0, lastPlan: e.planLabel,
      };
      co.payments += 1;
      co.totalMinorUnits += e.amountMinorUnits;
      byCompanyMap.set(e.companyId, co);
    }

    // Last 6 calendar months (oldest → newest), collected revenue per month.
    const monthly: { year: number; month: number; totalMinorUnits: number }[] = [];
    for (let back = 5; back >= 0; back--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      monthly.push({ year: d.getUTCFullYear(), month: d.getUTCMonth(), totalMinorUnits: 0 });
    }
    for (const e of entries) {
      const d = new Date(e.recordedAt);
      const slot = monthly.find((m) => m.year === d.getUTCFullYear() && m.month === d.getUTCMonth());
      if (slot) slot.totalMinorUnits += e.amountMinorUnits;
    }

    const pendingCount = await this.submissionRepo.count({ where: { status: 'submitted' } });

    return {
      totalMinorUnits,
      totalLabel: formatMinorUnits(totalMinorUnits),
      thisMonthMinorUnits,
      thisMonthLabel: formatMinorUnits(thisMonthMinorUnits),
      paymentsCount: entries.length,
      pendingSubmissions: pendingCount,
      byPlan: [...byPlanMap.values()].sort((a, b) => b.totalMinorUnits - a.totalMinorUnits),
      byCompany: [...byCompanyMap.values()].sort((a, b) => b.totalMinorUnits - a.totalMinorUnits),
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
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
    let remindersSent = 0;
    let expiringMarked = 0;
    let deactivated = 0;

    // Only paid plans with an expiry date participate.
    const companies = await this.companyRepo
      .createQueryBuilder('c')
      .where(`c.subscriptionPlan <> 'free'`)
      .andWhere('c.subscriptionExpiryDate IS NOT NULL')
      .getMany();

    for (const company of companies) {
      const expiry = new Date(company.subscriptionExpiryDate as unknown as Date);
      const accountStatus = normalizeCompanyStatus(company.status);

      if (expiry.getTime() > now.getTime()) {
        // Still active — reminder window?
        const days = daysBetween(now, expiry);
        if (days <= 10) {
          if (company.subscriptionStatus !== 'expiring') {
            company.subscriptionStatus = 'expiring';
            expiringMarked += 1;
          }
          if (company.subscriptionReminderOn !== today) {
            company.subscriptionReminderOn = today;
            await this.notifyCompanyAdmins(company.id, {
              type: 'subscription_expiring',
              title: 'Subscription expiring soon',
              message:
                `Your ${getPlanConfig(company.subscriptionPlan).label} plan expires in ` +
                `${days} day${days === 1 ? '' : 's'}. Renew now to avoid interruption.`,
              data: { daysRemaining: days, expiryDate: expiry, route: 'billing' },
            });
            remindersSent += 1;
          }
          await this.companyRepo.save(company);
        } else if (company.subscriptionStatus !== 'active') {
          // Moved back outside the window (e.g. after renewal) — normalize.
          company.subscriptionStatus = 'active';
          await this.companyRepo.save(company);
        }
      } else {
        // Expired. Deactivate the account ONCE — never delete data.
        const alreadyHandled =
          company.subscriptionStatus === 'expired' && accountStatus === 'inactive';
        if (!alreadyHandled) {
          company.subscriptionStatus = 'expired';
          company.status = 'inactive';
          await this.companyRepo.save(company);
          deactivated += 1;
          await this.notifyCompanyAdmins(company.id, {
            type: 'subscription_expired',
            title: 'Account deactivated — renew to restore',
            message:
              'Your subscription has expired and your account is now inactive. ' +
              'Your data is safe. Renew your plan to restore full access.',
            data: { route: 'billing' },
          });
        }
      }
    }

    this.logger.log(
      `Expiry scan: ${expiringMarked} expiring, ${remindersSent} reminders, ${deactivated} deactivated`,
    );
    return { remindersSent, expiringMarked, deactivated, scanned: companies.length };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getCompanyOrFail(companyId: string): Promise<Company> {
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private determineKind(company: Company, plan: PlanKey): SubmissionKind {
    const accountStatus = normalizeCompanyStatus(company.status);
    const currentPlan = normalizePlan(company.subscriptionPlan);
    // An expired/deactivated account restoring access = RENEWAL.
    if (accountStatus === 'inactive' || company.subscriptionStatus === 'expired') {
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
      const again = await revenueRepo.findOne({ where: { submissionId: submission.id } });
      if (again) return again;
      throw err;
    }
  }

  private async notifyCompanyAdmins(
    companyId: string,
    payload: { type: string; title: string; message: string; data?: Record<string, unknown> },
  ) {
    const admins = await this.userCompanyRepo.find({
      where: { companyId, role: 'admin' },
    });
    for (const a of admins) {
      await this.notifications.create({ companyId, userId: a.userId, ...payload });
    }
  }

  private toSubmissionView(
    s: PaymentSubmission,
    companyName?: string | null,
    companyEmail?: string | null,
  ) {
    return {
      id: s.id,
      companyId: s.companyId,
      companyName: companyName ?? undefined,
      companyEmail: companyEmail ?? undefined,
      plan: s.plan,
      planLabel: getPlanConfig(s.plan).label,
      kind: s.kind,
      status: s.status,
      amountMinorUnits: s.amountMinorUnits,
      amountLabel: formatMinorUnits(s.amountMinorUnits, s.currency),
      currency: s.currency,
      hasScreenshot: !!s.screenshotKey,
      rejectionReason: s.rejectionReason,
      reviewedAt: s.reviewedAt,
      createdAt: s.createdAt,
    };
  }
}
