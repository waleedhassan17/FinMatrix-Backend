import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { User } from '../users/entities/user.entity';
import { SubscriptionPlan } from './entities/subscription-plan.entity';
import { PLAN_CONFIG, TIER_PLAN_KEYS, formatMinorUnits } from '../billing/plan-config';
import { CompanySubscription } from './entities/company-subscription.entity';
import { CreateSubscriptionPlanDto } from './dto/create-subscription-plan.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';
import { AssignSubscriptionDto } from './dto/assign-subscription.dto';
import { MailService } from '../mail/mail.service';
import { COMPANY_STATUS, isCompanyApproved } from '../../types';

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    @InjectRepository(UserCompany) private readonly userCompanyRepo: Repository<UserCompany>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(SubscriptionPlan) private readonly planRepo: Repository<SubscriptionPlan>,
    @InjectRepository(CompanySubscription) private readonly subRepo: Repository<CompanySubscription>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
  ) {}

  // ─── Seed Super Admin ───────────────────────────────────────────────────────

  async seedSuperAdmin(email: string, password: string, displayName: string) {
    const existing = await this.userRepo.findOne({ where: { email: email.toLowerCase() } });
    if (existing) {
      if (existing.role === 'super_admin') {
        return { message: 'Super admin already exists', id: existing.id };
      }
      throw new ConflictException('Email already in use by a different account');
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
      countByStatuses(['pending', 'pending_approval', 'email_verified', 'unverified']),
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

    // Recent registrations (last 6)
    const recentRegistrations = await this.companyRepo
      .createQueryBuilder('c')
      .orderBy('c.createdAt', 'DESC')
      .limit(6)
      .getMany();

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
      recentRegistrations: recentRegistrations.map(c => ({
        id: c.id,
        name: c.name,
        industry: c.industry,
        email: c.email,
        status: c.status ?? 'active',
        createdAt: c.createdAt,
      })),
    };
  }

  // ─── Company Management ─────────────────────────────────────────────────────

  async getAllCompanies(page = 1, limit = 20, status?: string) {
    const qb = this.companyRepo.createQueryBuilder('c').orderBy('c.createdAt', 'DESC');

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
      } else if (status === 'inactive' || status === 'suspended') {
        qb.where('c.status IN (:...s)', { s: ['inactive', 'suspended'] });
      } else {
        qb.where('c.status = :s', { s: status });
      }
    }

    const total = await qb.getCount();
    const companies = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    const enriched = await Promise.all(
      companies.map(async c => {
        const memberCount = await this.userCompanyRepo.count({
          where: { companyId: c.id },
        });
        const subscription = await this.subRepo.findOne({
          where: { companyId: c.id, status: 'active' },
          relations: { plan: true },
        });
        return {
          id: c.id,
          name: c.name,
          industry: c.industry,
          email: c.email,
          phone: c.phone,
          status: c.status ?? 'active',
          rejectionReason: c.rejectionReason,
          memberCount,
          planName: subscription?.plan?.name ?? null,
          createdAt: c.createdAt,
          reviewedAt: c.reviewedAt,
        };
      }),
    );

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
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
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

    return {
      ...company,
      status: company.status ?? 'active',
      members: members.map(m => ({
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
    dto: { allFeaturesUnlocked?: boolean; companyType?: string; inventoryEnabled?: boolean },
    reviewerId: string,
  ) {
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');

    if (dto.allFeaturesUnlocked !== undefined) company.allFeaturesUnlocked = dto.allFeaturesUnlocked;
    if (dto.companyType !== undefined) company.companyType = dto.companyType;
    if (dto.inventoryEnabled !== undefined) company.inventoryEnabled = dto.inventoryEnabled;
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

  async updateCompanyStatus(
    companyId: string,
    dto: UpdateCompanyStatusDto,
    reviewerId: string,
  ) {
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');

    // Normalise onto stored values: "active" == approved (reads as active);
    // "suspended" (legacy) == "inactive" (deactivated).
    const newStatus =
      dto.status === 'active'
        ? COMPANY_STATUS.APPROVED
        : dto.status === 'suspended'
          ? 'inactive'
          : dto.status;

    if (newStatus === COMPANY_STATUS.REJECTED && !dto.rejectionReason) {
      throw new BadRequestException('Rejection reason is required');
    }

    const wasApproved = isCompanyApproved(company.status);

    company.status = newStatus;
    company.rejectionReason =
      newStatus === COMPANY_STATUS.REJECTED ? dto.rejectionReason ?? null : null;
    company.reviewedBy = reviewerId;
    company.reviewedAt = new Date();
    await this.companyRepo.save(company);

    // Security/audit log.
    this.logger.log(
      `Company ${company.id} (${company.name}) -> ${newStatus} by reviewer ${reviewerId}`,
    );

    // Notify the company owner (best-effort).
    const owner = await this.userRepo.findOneBy({ id: company.createdBy });
    if (owner) {
      if (isCompanyApproved(newStatus) && !wasApproved) {
        await this.mail.sendApprovalEmail(owner.email, owner.displayName, company.name);
      } else if (newStatus === COMPANY_STATUS.REJECTED) {
        await this.mail.sendRejectionEmail(
          owner.email,
          owner.displayName,
          company.name,
          company.rejectionReason ?? 'No reason provided',
        );
      }
    }

    return {
      id: company.id,
      name: company.name,
      status: company.status,
      rejectionReason: company.rejectionReason,
      reviewedAt: company.reviewedAt,
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
    const tierNames: Record<string, string> = {
      small_business: 'Small Business',
      large_org: 'Large Organization',
      warehouse: 'Warehouse',
    };
    const tierFeatures: Record<string, string[]> = {
      small_business: [
        'Invoices, bills, payments & estimates',
        'Customers, vendors & chart of accounts',
        'Tax tracking + core reports (P&L, BS, TB, aging)',
      ],
      large_org: [
        'Everything in Small Business',
        'Payroll, employees & payslips',
        'Budgets vs actual, team roles & bank reconciliation',
        'Optional inventory (per-company toggle)',
      ],
      warehouse: [
        'Everything in Large Organization',
        'Full inventory + purchase orders (GRNI 3-way match)',
        'Deliveries with rider app & admin approval',
        'Goods-in-Transit accounting built in',
      ],
    };
    return TIER_PLAN_KEYS.map((key, i) => {
      const p = PLAN_CONFIG[key];
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
      };
    });
  }

  async createSubscriptionPlan(dto: CreateSubscriptionPlanDto) {
    void dto;
    throw new BadRequestException({
      code: 'PLANS_CONFIG_DEFINED',
      message:
        'Subscription plans are defined in the server configuration (billing/plan-config.ts), not in the database. Change the config and redeploy to adjust pricing.',
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

  async updateSubscriptionPlan(planId: string, dto: Partial<CreateSubscriptionPlanDto>) {
    void planId;
    void dto;
    throw new BadRequestException({
      code: 'PLANS_CONFIG_DEFINED',
      message:
        'Subscription plans are defined in the server configuration (billing/plan-config.ts), not in the database. Change the config and redeploy to adjust pricing.',
    });
  }

  private async legacyUpdateSubscriptionPlan(planId: string, dto: Partial<CreateSubscriptionPlanDto>) {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined) plan.description = dto.description ?? null;
    if (dto.priceMonthly !== undefined) plan.priceMonthly = String(dto.priceMonthly);
    if (dto.priceYearly !== undefined) plan.priceYearly = String(dto.priceYearly);
    if (dto.maxUsers !== undefined) plan.maxUsers = dto.maxUsers;
    if (dto.maxInvoices !== undefined) plan.maxInvoices = dto.maxInvoices ?? null;
    if (dto.features !== undefined) plan.features = dto.features ?? null;
    if (dto.isActive !== undefined) plan.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) plan.sortOrder = dto.sortOrder ?? 0;

    return this.planRepo.save(plan);
  }

  async deleteSubscriptionPlan(planId: string) {
    void planId;
    throw new BadRequestException({
      code: 'PLANS_CONFIG_DEFINED',
      message:
        'Subscription plans are defined in the server configuration (billing/plan-config.ts) and cannot be deleted.',
    });
  }

  private async legacyDeleteSubscriptionPlan(planId: string) {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const activeSubCount = await this.subRepo.count({
      where: { planId, status: 'active' },
    });
    if (activeSubCount > 0) {
      throw new BadRequestException('Cannot delete a plan with active subscriptions');
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
    const company = await this.companyRepo.findOne({ where: { id: dto.companyId } });
    if (!company) throw new NotFoundException('Company not found');

    const plan = await this.planRepo.findOne({ where: { id: dto.planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    // Cancel existing active subscriptions for this company
    await this.subRepo
      .createQueryBuilder()
      .update(CompanySubscription)
      .set({ status: 'cancelled' })
      .where('companyId = :cid AND status = :s', { cid: dto.companyId, s: 'active' })
      .execute();

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
