import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { User } from '../users/entities/user.entity';
import { SubscriptionPlan } from './entities/subscription-plan.entity';
import { CompanySubscription } from './entities/company-subscription.entity';
import { CreateSubscriptionPlanDto } from './dto/create-subscription-plan.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';
import { AssignSubscriptionDto } from './dto/assign-subscription.dto';

@Injectable()
export class SuperAdminService {
  constructor(
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    @InjectRepository(UserCompany) private readonly userCompanyRepo: Repository<UserCompany>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(SubscriptionPlan) private readonly planRepo: Repository<SubscriptionPlan>,
    @InjectRepository(CompanySubscription) private readonly subRepo: Repository<CompanySubscription>,
    private readonly dataSource: DataSource,
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
      this.companyRepo.count({ where: { status: 'pending' } }),
      this.companyRepo.count({ where: { status: 'active' } }),
      this.companyRepo.count({ where: { status: 'suspended' } }),
      this.companyRepo.count({ where: { status: 'rejected' } }),
      this.planRepo.count({ where: { isActive: true } }),
      this.subRepo.count(),
      this.subRepo.count({ where: { status: 'active' } }),
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
      if (status === 'active') {
        qb.where('(c.status = :s OR c.status IS NULL)', { s: status });
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
      data: enriched,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
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

  async updateCompanyStatus(
    companyId: string,
    dto: UpdateCompanyStatusDto,
    reviewerId: string,
  ) {
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');

    if (dto.status === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException('Rejection reason is required');
    }

    company.status = dto.status;
    company.rejectionReason = dto.rejectionReason ?? null;
    company.reviewedBy = reviewerId;
    company.reviewedAt = new Date();
    await this.companyRepo.save(company);

    return {
      id: company.id,
      name: company.name,
      status: company.status,
      rejectionReason: company.rejectionReason,
      reviewedAt: company.reviewedAt,
    };
  }

  // ─── Subscription Plans ─────────────────────────────────────────────────────

  async getSubscriptionPlans() {
    return this.planRepo.find({ order: { sortOrder: 'ASC', createdAt: 'ASC' } });
  }

  async createSubscriptionPlan(dto: CreateSubscriptionPlanDto) {
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
    const [data, total] = await this.subRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const enriched = await Promise.all(
      data.map(async s => {
        const company = await this.companyRepo.findOne({ where: { id: s.companyId } });
        return {
          ...s,
          companyName: company?.name ?? 'Unknown',
          companyEmail: company?.email ?? null,
        };
      }),
    );

    return {
      data: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
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
