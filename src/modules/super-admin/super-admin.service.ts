import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, DataSource } from 'typeorm';
import { likeContains } from '../../common/utils/like.util';
import * as bcrypt from 'bcryptjs';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { User } from '../users/entities/user.entity';
import { SubscriptionPlan } from './entities/subscription-plan.entity';
import {
  TIER_PLAN_KEYS,
  formatMinorUnits,
  getPlanConfig,
  getPlanOverride,
  isPlanKey,
  isPlanOffered,
  whatsappAllowance,
  type PlanKey,
} from '../billing/plan-config';
import { PlanOverrideService } from './plan-override.service';

/** What the console may change on a plan. See PlanOverride for why this is narrow. */
export interface UpdatePlanDto {
  label?: string;
  monthlyMinorUnits?: number;
  priceMinorUnits?: number;
  deliveryPersonnelLimit?: number;
  whatsappMonthlyMessages?: number;
  isOffered?: boolean;
  updatedBy?: string | null;
}
import { CompanySubscription } from './entities/company-subscription.entity';
import { CreateSubscriptionPlanDto } from './dto/create-subscription-plan.dto';
import {
  PlanTermsDto,
  UpdateCompanyStatusDto,
} from './dto/update-company-status.dto';
import { PlatformAuditService } from '../../common/audit/platform-audit.service';
import {
  effectiveCompanyStatus,
  isSubscriptionExpired,
  normalizeCompanyStatus,
} from '../../common/utils/company-status.util';
import { TrialService } from '../billing/trial/trial.service';
import { companySuspendedError } from '../billing/billing.service';
import {
  assertActivePlanTerms,
  parseAdminPlanTerms,
} from '../billing/plan-terms';
import { reconcileRiderSeats } from '../delivery-personnel/rider-seats';
import { AssignSubscriptionDto } from './dto/assign-subscription.dto';
import { MailService } from '../mail/mail.service';
import { COMPANY_STATUS } from '../../types';

const PLAN_TIER_FEATURES: Record<string, string[]> = {
  small_business: [
    'Invoices, bills, payments & estimates',
    'Customers, vendors & chart of accounts',
    'Tax tracking + core reports (P&L, BS, TB, aging)',
  ],
  // Each list stands on its own. "Everything in <tier>" pointed buyers at a
  // tier that is not on sale, so they were told a plan includes something
  // they could not see. Four lines at most — the app's plan card shows four.
  large_org: [
    'Invoices, bills, payments, tax & core reports',
    'Payroll, employees & payslips',
    'Budgets vs actual, team roles & bank reconciliation',
    'Optional inventory (per-company toggle)',
  ],
  warehouse: [
    'Complete accounting: invoices, bills, payments, tax & reports',
    'Payroll, budgets, bank reconciliation & team roles',
    'Full inventory + purchase orders (GRNI 3-way match)',
    'Deliveries with rider app, admin approval & Goods-in-Transit accounting',
  ],
};

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(UserCompany)
    private readonly userCompanyRepo: Repository<UserCompany>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(SubscriptionPlan)
    private readonly planRepo: Repository<SubscriptionPlan>,
    @InjectRepository(CompanySubscription)
    private readonly subRepo: Repository<CompanySubscription>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly planOverrides: PlanOverrideService,
    private readonly trials: TrialService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  // ─── Seed Super Admin ───────────────────────────────────────────────────────

  /**
   * Is the platform already bootstrapped? Once true, the public seed route is
   * closed permanently — see SuperAdminController.seedAdmin.
   */
  async superAdminExists(): Promise<boolean> {
    return (await this.userRepo.count({ where: { role: 'super_admin' } })) > 0;
  }

  async seedSuperAdmin(email: string, password: string, displayName: string) {
    const existing = await this.userRepo.findOne({
      where: { email: email.toLowerCase() },
    });
    if (existing) {
      if (existing.role === 'super_admin') {
        return { message: 'Super admin already exists', id: existing.id };
      }
      throw new ConflictException(
        'Email already in use by a different account',
      );
    }

    const cost = 12;
    const passwordHash = await bcrypt.hash(password, cost);
    const user = this.userRepo.create({
      email: email.toLowerCase(),
      passwordHash,
      displayName,
      role: 'super_admin',
      isActive: true,
      defaultCompanyId: null,
    });
    await this.userRepo.save(user);
    return { message: 'Super admin created', id: user.id, email: user.email };
  }

  // ─── Platform Stats ─────────────────────────────────────────────────────────

  async getPlatformStats() {
    const countByStatuses = (statuses: string[]) =>
      this.companyRepo
        .createQueryBuilder('c')
        .where('c.status IN (:...s)', { s: statuses })
        .getCount();

    // Only count subscriptions that still belong to an existing company.
    // Orphaned rows (company deleted) must never inflate platform stats.
    const subCount = (activeOnly: boolean) => {
      const qb = this.subRepo
        .createQueryBuilder('s')
        .innerJoin(Company, 'co', 'co.id = s.companyId');
      if (activeOnly) qb.where('s.status = :st', { st: 'active' });
      return qb.getCount();
    };

    const [
      totalCompanies,
      pendingCompanies,
      activeCompanies,
      suspendedCompanies,
      rejectedCompanies,
      totalPlans,
      totalSubscriptions,
      activeSubscriptions,
    ] = await Promise.all([
      this.companyRepo.count(),
      countByStatuses([
        'pending',
        'pending_approval',
        'email_verified',
        'unverified',
      ]),
      countByStatuses(['active', 'approved']),
      countByStatuses(['inactive', 'suspended']),
      this.companyRepo.count({ where: { status: 'rejected' } }),
      this.planRepo.count({ where: { isActive: true } }),
      subCount(false),
      subCount(true),
    ]);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentCompanies = await this.companyRepo
      .createQueryBuilder('c')
      .where('c.createdAt >= :since', { since: sevenDaysAgo })
      .getCount();

    // Recent registrations (last 6), with who registered them.
    const recentRegistrations = await this.companyRepo
      .createQueryBuilder('c')
      .orderBy('c.createdAt', 'DESC')
      .limit(6)
      .getMany();
    const recentOwnerIds = [
      ...new Set(recentRegistrations.map((c) => c.createdBy).filter(Boolean)),
    ];
    const recentOwners = new Map(
      (recentOwnerIds.length
        ? await this.userRepo.findBy({ id: In(recentOwnerIds) })
        : []
      ).map((u) => [u.id, u]),
    );

    return {
      companies: {
        total: totalCompanies,
        pending: pendingCompanies,
        active: activeCompanies,
        suspended: suspendedCompanies,
        inactive: suspendedCompanies,
        rejected: rejectedCompanies,
        recentWeek: recentCompanies,
      },
      subscriptions: {
        totalPlans,
        totalSubscriptions,
        activeSubscriptions,
      },
      recentRegistrations: recentRegistrations.map((c) => ({
        id: c.id,
        name: c.name,
        industry: c.industry,
        email: c.email,
        status: c.status ?? 'active',
        createdAt: c.createdAt,
        ownerName: recentOwners.get(c.createdBy)?.displayName ?? null,
        ownerEmail: recentOwners.get(c.createdBy)?.email ?? null,
      })),
    };
  }

  // ─── Company Management ─────────────────────────────────────────────────────

  /** `?isTrial=true|false` → boolean; anything else (or absent) → no filter. */
  static parseTrialFilter(raw: string | undefined): boolean | undefined {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }

  async getAllCompanies(
    page = 1,
    limit = 20,
    status?: string,
    isTrial?: boolean,
    search?: string,
    isDemo?: boolean,
  ) {
    const qb = this.companyRepo
      .createQueryBuilder('c')
      .orderBy('c.createdAt', 'DESC');

    if (status && status !== 'all') {
      if (status === 'active' || status === 'approved') {
        // Treat legacy `active` and new `approved` (and NULL) as approved.
        qb.where('(c.status IN (:...s) OR c.status IS NULL)', {
          s: ['active', 'approved'],
        });
      } else if (status === 'pending' || status === 'pending_approval') {
        qb.where('c.status IN (:...s)', {
          s: ['pending', 'pending_approval', 'email_verified', 'unverified'],
        });
      } else if (status === 'suspended') {
        qb.where('c.suspendedAt IS NOT NULL');
      } else if (status === 'inactive') {
        qb.where('c.status IN (:...s)', { s: ['inactive', 'suspended'] });
      } else {
        qb.where('c.status = :s', { s: status });
      }
    }
    // Trial history filter: true = every company that has ever had a trial
    // (isTrial is never cleared), false = companies that never trialed.
    if (isTrial !== undefined) {
      qb.andWhere('c.isTrial = :isTrial', { isTrial });
    }
    if (isDemo !== undefined) {
      qb.andWhere('c.isDemo = :isDemo', { isDemo });
    }
    // Finding one company among many is most of what an administrator does
    // before deciding on it, and they know it by whatever they were told: the
    // business name, its email, or the owner's name or address. Escaped, so a
    // "%" or "_" someone types is searched for rather than matching everything.
    const term = search?.trim();
    if (term) {
      qb.andWhere(
        `(c.name ILIKE :q OR c.email ILIKE :q OR EXISTS (
            SELECT 1 FROM users o
             WHERE o.id = c.created_by
               AND (o.email ILIKE :q OR o.display_name ILIKE :q)
          ))`,
        { q: likeContains(term) },
      );
    }

    const total = await qb.getCount();
    const companies = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    // Three batched look-ups for the whole page. This used to run two queries
    // per company (member count, active subscription) — forty round-trips to
    // draw one page of twenty.
    const ids = companies.map((c) => c.id);
    const ownerIds = [
      ...new Set(companies.map((c) => c.createdBy).filter(Boolean)),
    ];
    const [memberRows, subscriptions, owners] = ids.length
      ? await Promise.all([
          this.userCompanyRepo
            .createQueryBuilder('uc')
            .select('uc.companyId', 'companyId')
            .addSelect('COUNT(*)', 'count')
            .where('uc.companyId IN (:...ids)', { ids })
            .groupBy('uc.companyId')
            .getRawMany<{ companyId: string; count: string }>(),
          this.subRepo.find({
            where: { companyId: In(ids), status: 'active' },
            relations: { plan: true },
          }),
          ownerIds.length
            ? this.userRepo.findBy({ id: In(ownerIds) })
            : Promise.resolve([]),
        ])
      : [[], [], []];
    const memberCount = new Map(
      memberRows.map((r) => [r.companyId, Number(r.count)]),
    );
    const planName = new Map(
      subscriptions.map((s) => [s.companyId, s.plan?.name ?? null]),
    );
    const ownerById = new Map(owners.map((o) => [o.id, o]));

    const enriched = companies.map((c) => {
      const owner = ownerById.get(c.createdBy);
      return {
        id: c.id,
        name: c.name,
        industry: c.industry,
        email: c.email,
        phone: c.phone,
        status: c.status ?? 'active',
        rejectionReason: c.rejectionReason,
        memberCount: memberCount.get(c.id) ?? 0,
        planName: planName.get(c.id) ?? null,
        createdAt: c.createdAt,
        reviewedAt: c.reviewedAt,
        isTrial: c.isTrial,
        trialStartedAt: c.trialStartedAt,
        trialConvertedAt: c.trialConvertedAt,
        accountStatus: effectiveCompanyStatus(c),
        subscriptionPlan: c.subscriptionPlan,
        subscriptionPlanLabel: getPlanConfig(c.subscriptionPlan).label,
        subscriptionExpiryDate: c.subscriptionExpiryDate,
        requestedPlan: c.requestedPlan,
        isDemo: c.isDemo,
        suspendedAt: c.suspendedAt,
        suspensionReason: c.suspensionReason,
        // Who to call about it. The company's own email is often blank; the
        // owner's is the address every approval email goes to.
        ownerName: owner?.displayName ?? null,
        ownerEmail: owner?.email ?? null,
        ownerPhone: owner?.phone ?? null,
        ownerEmailVerified: owner ? owner.isEmailVerified : null,
      };
    });

    return {
      data: {
        data: enriched,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getCompanyDetail(companyId: string) {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');

    const members = await this.userCompanyRepo
      .createQueryBuilder('uc')
      .leftJoinAndSelect('uc.user', 'u')
      .where('uc.companyId = :cid', { cid: companyId })
      .getMany();

    const subscriptions = await this.subRepo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });

    // The person the decision is about. `createdBy` is the owner's user id; the
    // member list has them too, but without a phone or whether they ever
    // confirmed their address.
    const owner = company.createdBy
      ? await this.userRepo.findOneBy({ id: company.createdBy })
      : null;

    return {
      ...company,
      status: company.status ?? 'active',
      accountStatus: effectiveCompanyStatus(company),
      subscriptionPlanLabel: getPlanConfig(company.subscriptionPlan).label,
      owner: owner
        ? {
            id: owner.id,
            displayName: owner.displayName,
            email: owner.email,
            phone: owner.phone,
            isEmailVerified: owner.isEmailVerified,
          }
        : null,
      members: members.map((m) => ({
        id: m.user?.id,
        email: m.user?.email,
        displayName: m.user?.displayName,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      subscriptions,
    };
  }

  /**
   * KILL SWITCH + tier override (FinMatrix.md SAFETY §4). Super-admin only.
   * allFeaturesUnlocked=true short-circuits FeatureGuard before any type/plan
   * check — instant full access, no deploy.
   */
  async updateFeatureOverride(
    companyId: string,
    dto: {
      allFeaturesUnlocked?: boolean;
      companyType?: string;
      inventoryEnabled?: boolean;
    },
    reviewerId: string,
  ) {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');

    if (dto.allFeaturesUnlocked !== undefined)
      company.allFeaturesUnlocked = dto.allFeaturesUnlocked;
    if (dto.companyType !== undefined) company.companyType = dto.companyType;
    if (dto.inventoryEnabled !== undefined)
      company.inventoryEnabled = dto.inventoryEnabled;
    company.reviewedBy = reviewerId;
    company.reviewedAt = new Date();
    await this.companyRepo.save(company);

    return {
      id: company.id,
      name: company.name,
      companyType: company.companyType,
      inventoryEnabled: company.inventoryEnabled,
      allFeaturesUnlocked: company.allFeaturesUnlocked,
    };
  }

  /**
   * Every company decision the consoles make — approve, reject, activate,
   * deactivate — behind PATCH /super-admin/companies/:id/status and the
   * granular /admin/companies/:id/* routes.
   *
   *   active    — on a SUSPENDED company: reinstate (restores what it was).
   *               On a pending/draft/rejected company: APPROVE, which needs a
   *               plan + end date, or asTrial (eligibility rules apply).
   *               On a lapsed (inactive) company: "Activate plan" — plan + end
   *               date needed unless its old plan is still valid (a legacy
   *               deactivation), which is then simply reactivated.
   *               On an active company with plan terms: change its plan terms.
   *   inactive / suspended — SUSPEND (reversible; reason recorded).
   *   rejected  — reject with a reason.
   *
   * No path leaves a company active without a plan and an end date unless it
   * already was (legacy rows are restored, never created).
   */
  async updateCompanyStatus(
    companyId: string,
    dto: UpdateCompanyStatusDto,
    reviewerId: string,
  ) {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');

    if (dto.status === 'inactive' || dto.status === 'suspended') {
      return this.suspendCompany(
        companyId,
        reviewerId,
        dto.reason ??
          dto.rejectionReason ??
          'Deactivated by a FinMatrix administrator',
      );
    }

    if (dto.status === 'active') {
      if (company.suspendedAt) {
        return this.reinstateCompany(companyId, reviewerId);
      }
      const state = normalizeCompanyStatus(company.status);
      const hasTerms = !!(dto.plan || dto.endDate);

      if (state === 'draft' || state === 'pending' || state === 'rejected') {
        if (dto.asTrial) {
          const result = await this.trials.startForAdmin(
            companyId,
            reviewerId,
            'approve',
            null,
          );
          return this.statusResult(
            await this.companyRepo.findOneOrFail({ where: { id: companyId } }),
            { trialEndsAt: result.trialEndsAt },
          );
        }
        return this.activateWithTerms(company, dto, reviewerId, 'approved');
      }

      if (state === 'inactive') {
        if (hasTerms || isSubscriptionExpired(company)) {
          return this.activateWithTerms(company, dto, reviewerId, 'activated');
        }
        // A legacy deactivation whose plan is still valid: restore it.
        company.status = COMPANY_STATUS.APPROVED;
        company.rejectionReason = null;
        company.reviewedBy = reviewerId;
        company.reviewedAt = new Date();
        await this.companyRepo.save(company);
        await this.notifyOwner(company, 'reactivated');
        await this.platformAudit.record({
          actorUserId: reviewerId,
          action: 'company_reactivated',
          targetType: 'company',
          targetId: companyId,
          companyId,
          companyName: company.name,
        });
        return this.statusResult(company);
      }

      // Already active.
      if (hasTerms) {
        return this.activateWithTerms(company, dto, reviewerId, 'activated');
      }
      return this.statusResult(company);
    }

    if (dto.status === 'rejected') {
      if (!dto.rejectionReason) {
        throw new BadRequestException('Rejection reason is required');
      }
      company.status = COMPANY_STATUS.REJECTED;
      company.rejectionReason = dto.rejectionReason;
      company.reviewedBy = reviewerId;
      company.reviewedAt = new Date();
      await this.companyRepo.save(company);
      await this.notifyOwner(company, 'rejected');
      await this.platformAudit.record({
        actorUserId: reviewerId,
        action: 'company_rejected',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: company.name,
        reason: dto.rejectionReason,
      });
      return this.statusResult(company);
    }

    // 'pending' — a raw status some old scripts set.
    company.status = dto.status;
    company.reviewedBy = reviewerId;
    company.reviewedAt = new Date();
    await this.companyRepo.save(company);
    return this.statusResult(company);
  }

  /**
   * Switch a plan on with admin-chosen terms (approval of path B, or
   * "Activate plan" on a lapsed/active company). A running trial converts.
   * No money is recorded anywhere.
   */
  private async activateWithTerms(
    company: Company,
    dto: PlanTermsDto,
    reviewerId: string,
    kind: 'approved' | 'activated',
  ) {
    const terms = parseAdminPlanTerms({
      plan: dto.plan ?? company.requestedPlan,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });
    const now = new Date();
    const saved = await this.dataSource.transaction(async (em) => {
      const c = await em.getRepository(Company).findOne({
        where: { id: company.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!c) throw new NotFoundException('Company not found');
      if (c.suspendedAt) throw companySuspendedError();
      const converting = c.isTrial && !c.trialConvertedAt;
      c.subscriptionPlan = terms.plan;
      c.subscriptionStartDate = terms.start;
      c.subscriptionExpiryDate = terms.end;
      c.subscriptionStatus = 'active';
      c.subscriptionReminderOn = null;
      if (c.paymentStatus === 'submitted') c.paymentStatus = 'none';
      c.status = kind === 'approved' ? COMPANY_STATUS.APPROVED : 'active';
      c.rejectionReason = null;
      c.reviewedBy = reviewerId;
      c.reviewedAt = now;
      if (converting) c.trialConvertedAt = now;
      assertActivePlanTerms(c);
      await em.getRepository(Company).save(c);
      await reconcileRiderSeats(
        em,
        c.id,
        getPlanConfig(terms.plan).deliveryPersonnelLimit,
      );
      return { company: c, converting };
    });

    const owner = await this.userRepo.findOneBy({
      id: saved.company.createdBy,
    });
    if (owner?.email) {
      await this.mail.sendPlanActivatedEmail(
        owner.email,
        owner.displayName,
        saved.company.name,
        terms.planLabel,
        terms.end,
      );
    }
    await this.platformAudit.record({
      actorUserId: reviewerId,
      action: kind === 'approved' ? 'company_approved' : 'plan_activated',
      targetType: 'company',
      targetId: saved.company.id,
      companyId: saved.company.id,
      companyName: saved.company.name,
      details: {
        plan: terms.plan,
        start: terms.start.toISOString(),
        end: terms.end.toISOString(),
        trialConverted: saved.converting,
        requestedPlan: saved.company.requestedPlan,
      },
    });
    this.logger.log(
      `Company ${saved.company.id} ${kind} on ${terms.plan} until ${terms.end.toISOString()} by ${reviewerId}`,
    );
    return this.statusResult(saved.company);
  }

  /** Reversible platform block: every member is refused until reinstated. */
  async suspendCompany(companyId: string, reviewerId: string, reason: string) {
    const trimmed = (reason ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Give a reason for suspending this company.',
      });
    }
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (!company.suspendedAt) {
      company.statusBeforeSuspension = company.status ?? null;
      company.status = 'suspended';
      company.suspendedAt = new Date();
      company.suspendedBy = reviewerId;
      company.suspensionReason = trimmed.slice(0, 500);
      company.reviewedBy = reviewerId;
      company.reviewedAt = new Date();
      await this.companyRepo.save(company);
      await this.notifyOwner(company, 'suspended');
      await this.platformAudit.record({
        actorUserId: reviewerId,
        action: 'company_suspended',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: company.name,
        reason: trimmed,
        details: { statusBefore: company.statusBeforeSuspension },
      });
    }
    return this.statusResult(company);
  }

  /** Undo a suspension: the company goes back to exactly what it was. */
  async reinstateCompany(companyId: string, reviewerId: string) {
    const company = await this.companyRepo.findOne({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.suspendedAt) {
      // Old releases wrote 'inactive' for a deactivation with no "before".
      const restored =
        company.statusBeforeSuspension || COMPANY_STATUS.APPROVED;
      company.status =
        restored === 'suspended' ? COMPANY_STATUS.APPROVED : restored;
      company.suspendedAt = null;
      company.suspendedBy = null;
      company.suspensionReason = null;
      company.statusBeforeSuspension = null;
      company.reviewedBy = reviewerId;
      company.reviewedAt = new Date();
      await this.companyRepo.save(company);
      await this.notifyOwner(company, 'reactivated');
      await this.platformAudit.record({
        actorUserId: reviewerId,
        action: 'company_reinstated',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: company.name,
        details: { restoredStatus: company.status },
      });
    }
    return this.statusResult(company);
  }

  /** The owner's email for each decision; username-only owners are skipped. */
  private async notifyOwner(
    company: Company,
    what: 'reactivated' | 'suspended' | 'rejected',
  ) {
    const owner = await this.userRepo.findOneBy({ id: company.createdBy });
    if (!owner?.email) return;
    if (what === 'reactivated') {
      await this.mail.sendReactivatedEmail(
        owner.email,
        owner.displayName,
        company.name,
      );
    } else if (what === 'suspended') {
      await this.mail.sendDeactivatedEmail(
        owner.email,
        owner.displayName,
        company.name,
      );
    } else {
      await this.mail.sendRejectionEmail(
        owner.email,
        owner.displayName,
        company.name,
        company.rejectionReason ?? 'No reason provided',
      );
    }
  }

  private statusResult(company: Company, extra: Record<string, unknown> = {}) {
    return {
      id: company.id,
      name: company.name,
      status: company.status,
      accountStatus: effectiveCompanyStatus(company),
      rejectionReason: company.rejectionReason,
      reviewedAt: company.reviewedAt,
      subscriptionPlan: company.subscriptionPlan,
      subscriptionExpiryDate: company.subscriptionExpiryDate,
      suspendedAt: company.suspendedAt,
      suspensionReason: company.suspensionReason,
      ...extra,
    };
  }

  // ─── Subscription Plans ─────────────────────────────────────────────────────

  /**
   * Three-tier model (FinMatrix.md): the subscription plans are defined in
   * ONE server-side config — billing/plan-config.ts — not in the database.
   * This returns the six tier plans in the legacy plan shape (so existing
   * clients keep rendering) PLUS the tier fields (companyType, duration,
   * PKR labels). The old subscription_plans table is retained read-only for
   * historical company_subscriptions rows; it is no longer served or
   * editable here.
   */
  async getSubscriptionPlans() {
    return TIER_PLAN_KEYS.map((key, i) => this.planToView(key, i));
  }

  /**
   * One plan in the shape the catalogue returns.
   *
   * Extracted so an edit can answer with exactly what the list would show for
   * that plan -- the console then renders what actually took effect rather
   * than echoing back the fields it asked to change.
   */
  planToView(rawKey: string, index?: number) {
    const tierNames: Record<string, string> = {
      small_business: 'Small Business',
      large_org: 'Large Organization',
      warehouse: 'Warehouse',
    };
    const tierFeatures = PLAN_TIER_FEATURES;
    {
      // Through getPlanConfig, so an admin's price or limit edit is reflected
      // here exactly as it is on the customer-facing quote.
      const p = getPlanConfig(rawKey);
      const key = p.key;
      const i = index ?? TIER_PLAN_KEYS.indexOf(key as never);
      const override = isPlanKey(key)
        ? getPlanOverride(key as PlanKey)
        : undefined;
      return {
        // Legacy shape (id/name/priceMonthly/priceYearly/features/…):
        id: p.key,
        name: p.label,
        description: `${tierNames[p.companyType ?? '']} · ${p.durationMonths} months, billed once`,
        priceMonthly: String(p.monthlyMinorUnits / 100),
        priceYearly: String(p.priceMinorUnits / 100), // legacy field = TOTAL for the period
        maxUsers: p.companyType === 'small_business' ? 3 : 25,
        maxInvoices: null,
        features: tierFeatures[p.companyType ?? ''] ?? [],
        isActive: true,
        sortOrder: i,
        // Tier fields:
        companyType: p.companyType,
        durationMonths: p.durationMonths,
        monthlyMinorUnits: p.monthlyMinorUnits,
        totalMinorUnits: p.priceMinorUnits,
        monthlyLabel: formatMinorUnits(p.monthlyMinorUnits, p.currency),
        totalLabel: formatMinorUnits(p.priceMinorUnits, p.currency),
        currency: p.currency,
        deliveryPersonnelLimit: p.deliveryPersonnelLimit,
        whatsappMonthlyMessages: whatsappAllowance(p),
        // Editing state, so the console can show what has been changed from
        // the configured default and offer to put it back.
        isOffered: isPlanKey(key) ? isPlanOffered(key as PlanKey) : true,
        isEdited: !!override && Object.keys(override).length > 0,
        editedFields: override ? Object.keys(override) : [],
      };
    }
  }

  /**
   * Plans are defined in code and cannot be created from the console.
   *
   * This is not a gap. A plan key is stored on every company row and is what
   * billing, the renewal cron and the rider limit all resolve against; minting
   * one at runtime means a key with no config behind it. Editing the existing
   * catalogue is supported -- see updateSubscriptionPlan.
   */
  async createSubscriptionPlan(dto: CreateSubscriptionPlanDto) {
    void dto;
    throw new BadRequestException({
      code: 'PLANS_CONFIG_DEFINED',
      message:
        'Plans are defined in the server configuration and cannot be created here. ' +
        'You can edit the price, rider limit and name of an existing plan.',
    });
  }

  private async legacyCreateSubscriptionPlan(dto: CreateSubscriptionPlanDto) {
    const plan = this.planRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      priceMonthly: String(dto.priceMonthly),
      priceYearly: String(dto.priceYearly),
      maxUsers: dto.maxUsers,
      maxInvoices: dto.maxInvoices ?? null,
      features: dto.features ?? null,
      isActive: dto.isActive !== false,
      sortOrder: dto.sortOrder ?? 0,
    });
    return this.planRepo.save(plan);
  }

  /**
   * Edit one plan.
   *
   * `planId` is the plan KEY ('warehouse_starter_6mo'), which is what the
   * catalogue returns as its id and what every company row stores -- not a
   * UUID from the subscription_plans table, which is a separate and unrelated
   * set of rows.
   *
   * The edit lands in plan_overrides and takes effect immediately, including
   * on the price a customer is quoted and charged. It does NOT change what
   * anyone already on the plan has been billed.
   */
  async updateSubscriptionPlan(planId: string, dto: UpdatePlanDto) {
    const updated = await this.planOverrides.apply(
      planId,
      {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.monthlyMinorUnits !== undefined
          ? { monthlyMinorUnits: dto.monthlyMinorUnits }
          : {}),
        ...(dto.priceMinorUnits !== undefined
          ? { priceMinorUnits: dto.priceMinorUnits }
          : {}),
        ...(dto.deliveryPersonnelLimit !== undefined
          ? { deliveryPersonnelLimit: dto.deliveryPersonnelLimit }
          : {}),
        ...(dto.whatsappMonthlyMessages !== undefined
          ? { whatsappMonthlyMessages: dto.whatsappMonthlyMessages }
          : {}),
        ...(dto.isOffered !== undefined ? { isOffered: dto.isOffered } : {}),
      },
      dto.updatedBy ?? null,
    );
    void updated;
    // The merged plan, so the caller renders what actually took effect rather
    // than echoing back what it asked for.
    return this.planToView(planId);
  }

  private async legacyUpdateSubscriptionPlan(
    planId: string,
    dto: Partial<CreateSubscriptionPlanDto>,
  ) {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined)
      plan.description = dto.description ?? null;
    if (dto.priceMonthly !== undefined)
      plan.priceMonthly = String(dto.priceMonthly);
    if (dto.priceYearly !== undefined)
      plan.priceYearly = String(dto.priceYearly);
    if (dto.maxUsers !== undefined) plan.maxUsers = dto.maxUsers;
    if (dto.maxInvoices !== undefined)
      plan.maxInvoices = dto.maxInvoices ?? null;
    if (dto.features !== undefined) plan.features = dto.features ?? null;
    if (dto.isActive !== undefined) plan.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) plan.sortOrder = dto.sortOrder ?? 0;

    return this.planRepo.save(plan);
  }

  /**
   * Revert a plan to exactly what the configuration declares.
   *
   * Deleting a plan outright is deliberately not offered: existing companies
   * store its key, and a key with nothing behind it breaks their renewal and
   * their rider limit. To stop selling one, set isOffered false -- it keeps
   * resolving for whoever is on it and is shown to nobody new.
   */
  async deleteSubscriptionPlan(planId: string) {
    await this.planOverrides.reset(planId);
    return this.planToView(planId);
  }

  private async legacyDeleteSubscriptionPlan(planId: string) {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const activeSubCount = await this.subRepo.count({
      where: { planId, status: 'active' },
    });
    if (activeSubCount > 0) {
      throw new BadRequestException(
        'Cannot delete a plan with active subscriptions',
      );
    }

    await this.planRepo.remove(plan);
    return { success: true };
  }

  // ─── Company Subscriptions ──────────────────────────────────────────────────

  async getAllSubscriptions(page = 1, limit = 20) {
    // Inner-join companies so subscriptions belonging to deleted companies
    // (orphans) are excluded entirely — they are stale data, not real revenue.
    const baseQb = () =>
      this.subRepo
        .createQueryBuilder('s')
        .innerJoin(Company, 'co', 'co.id = s.companyId');

    const total = await baseQb().getCount();

    // leftJoinAndSelect the plan: createQueryBuilder does not honour the
    // entity's eager relation, so the plan must be joined explicitly.
    const rows = await baseQb()
      .leftJoinAndSelect('s.plan', 'plan')
      .addSelect(['co.name AS co_name', 'co.email AS co_email'])
      .orderBy('s.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getRawAndEntities();

    const enriched = rows.entities.map((s, i) => ({
      ...s,
      companyName: rows.raw[i]?.co_name ?? 'Unknown',
      companyEmail: rows.raw[i]?.co_email ?? null,
    }));

    return {
      data: {
        data: enriched,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    };
  }

  async assignSubscription(dto: AssignSubscriptionDto, assignedBy: string) {
    const company = await this.companyRepo.findOne({
      where: { id: dto.companyId },
    });
    if (!company) throw new NotFoundException('Company not found');

    const plan = await this.planRepo.findOne({ where: { id: dto.planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    // Cancel existing active subscriptions for this company. Object criteria,
    // so TypeORM maps companyId to its company_id column (a raw
    // 'companyId = :cid' string named a column that does not exist).
    await this.subRepo.update(
      { companyId: dto.companyId, status: 'active' },
      { status: 'cancelled' },
    );

    const sub = this.subRepo.create({
      companyId: dto.companyId,
      planId: dto.planId,
      status: dto.status ?? 'active',
      startDate: dto.startDate,
      endDate: dto.endDate ?? null,
      notes: dto.notes ?? null,
      assignedBy,
    });
    return this.subRepo.save(sub);
  }
}
