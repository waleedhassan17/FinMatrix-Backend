import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Company } from './entities/company.entity';
import { UserCompany } from './entities/user-company.entity';
import { User } from '../users/entities/user.entity';
import {
  CreateCompanyDto,
  JoinCompanyDto,
  UpdateCompanyDto,
} from './dto/create-company.dto';
import { generateInviteCode } from '../../common/utils/reference-generator.util';
import { Account } from '../accounts/entities/account.entity';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../accounts/accounts.constants';
import { SubscriptionPlan } from '../super-admin/entities/subscription-plan.entity';
import { CompanySubscription } from '../super-admin/entities/company-subscription.entity';

@Injectable()
export class CompaniesService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(UserCompany)
    private readonly userCompanyRepo: Repository<UserCompany>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(SubscriptionPlan)
    private readonly planRepo: Repository<SubscriptionPlan>,
    @InjectRepository(CompanySubscription)
    private readonly subRepo: Repository<CompanySubscription>,
    private readonly dataSource: DataSource,
  ) {}

  async create(userId: string, dto: CreateCompanyDto): Promise<Company> {
    return this.dataSource.transaction(async (manager) => {
      const inviteCode = await this.generateUniqueInviteCode(manager);
      const company = manager.create(Company, {
        name: dto.name,
        industry: dto.industry ?? null,
        address: dto.address ?? null,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        taxId: dto.taxId ?? null,
        logo: dto.logo ?? null,
        inviteCode,
        createdBy: userId,
      });
      await manager.save(company);

      await manager.save(
        manager.create(UserCompany, {
          userId,
          companyId: company.id,
          role: 'admin',
        }),
      );

      const user = await manager.findOneBy(User, { id: userId });
      if (user && !user.defaultCompanyId) {
        user.defaultCompanyId = company.id;
        await manager.save(user);
      }

      await this.seedDefaultChartOfAccounts(manager, company.id);
      return company;
    });
  }

  async join(userId: string, dto: JoinCompanyDto): Promise<Company> {
    const company = await this.companyRepo.findOne({
      where: { inviteCode: dto.code.toUpperCase() },
    });
    if (!company) {
      throw new BadRequestException({
        code: 'INVALID_CODE',
        message: 'Invalid company invite code',
      });
    }
    const existing = await this.userCompanyRepo.findOne({
      where: { userId, companyId: company.id },
    });
    if (existing) return company;

    await this.userCompanyRepo.save(
      this.userCompanyRepo.create({
        userId,
        companyId: company.id,
        role: 'delivery',
      }),
    );
    const user = await this.userRepo.findOneBy({ id: userId });
    if (user && !user.defaultCompanyId) {
      user.defaultCompanyId = company.id;
      await this.userRepo.save(user);
    }
    return company;
  }

  async getById(userId: string, companyId: string): Promise<Company> {
    await this.assertMember(userId, companyId);
    const company = await this.companyRepo.findOneBy({ id: companyId });
    if (!company) {
      throw new NotFoundException({
        code: 'COMPANY_NOT_FOUND',
        message: 'Company not found',
      });
    }
    return company;
  }

  async update(
    userId: string,
    companyId: string,
    dto: UpdateCompanyDto,
  ): Promise<Company> {
    await this.assertAdmin(userId, companyId);
    const company = await this.getById(userId, companyId);
    Object.assign(company, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.industry !== undefined ? { industry: dto.industry } : {}),
      ...(dto.address !== undefined ? { address: dto.address } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.taxId !== undefined ? { taxId: dto.taxId } : {}),
      ...(dto.logo !== undefined ? { logo: dto.logo } : {}),
    });
    return this.companyRepo.save(company);
  }

  async listMembers(userId: string, companyId: string) {
    await this.assertAdmin(userId, companyId);
    const memberships = await this.userCompanyRepo.find({
      where: { companyId },
      relations: { user: true },
      order: { joinedAt: 'ASC' },
    });
    return memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  async removeMember(userId: string, companyId: string, targetUserId: string) {
    await this.assertAdmin(userId, companyId);
    if (userId === targetUserId) {
      throw new BadRequestException({
        code: 'CANNOT_REMOVE_SELF',
        message: 'You cannot remove yourself from the company',
      });
    }
    const membership = await this.userCompanyRepo.findOne({
      where: { companyId, userId: targetUserId },
    });
    if (!membership) {
      throw new NotFoundException({
        code: 'NOT_COMPANY_MEMBER',
        message: 'User is not a member of this company',
      });
    }
    await this.userCompanyRepo.remove(membership);
    return { removed: true };
  }

  async regenerateCode(userId: string, companyId: string): Promise<Company> {
    await this.assertAdmin(userId, companyId);
    const company = await this.getById(userId, companyId);
    company.inviteCode = await this.generateUniqueInviteCode();
    return this.companyRepo.save(company);
  }

  // ------- Helpers -------

  async assertMember(userId: string, companyId: string): Promise<UserCompany> {
    const membership = await this.userCompanyRepo.findOne({
      where: { userId, companyId },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: 'NOT_COMPANY_MEMBER',
        message: 'You are not a member of this company',
      });
    }
    return membership;
  }

  async assertAdmin(userId: string, companyId: string): Promise<UserCompany> {
    const membership = await this.assertMember(userId, companyId);
    if (membership.role !== 'admin') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Admin role required',
      });
    }
    return membership;
  }

  private async generateUniqueInviteCode(
    manager?: EntityManager,
  ): Promise<string> {
    const repo = manager ? manager.getRepository(Company) : this.companyRepo;
    for (let i = 0; i < 10; i++) {
      const candidate = generateInviteCode(6);
      const exists = await repo.findOne({ where: { inviteCode: candidate } });
      if (!exists) return candidate;
    }
    throw new ConflictException({
      code: 'INTERNAL_ERROR',
      message: 'Unable to generate a unique invite code',
    });
  }

  // ── Self-Subscribe (company admin picks own plan) ──────────────────────────
  async selfSubscribe(companyId: string, planId: string, userId: string) {
    if (!companyId) throw new BadRequestException('No company associated with your account');

    const plan = await this.planRepo.findOne({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Subscription plan not found');

    const membership = await this.userCompanyRepo.findOne({
      where: { userId, companyId },
    });
    if (!membership) throw new ForbiddenException('You are not a member of this company');

    // Cancel existing active/trial subscriptions
    await this.dataSource
      .createQueryBuilder()
      .update(CompanySubscription)
      .set({ status: 'cancelled' })
      .where('company_id = :cid AND status IN (:...s)', {
        cid: companyId,
        s: ['active', 'trial'],
      })
      .execute();

    const isFree = parseFloat(plan.priceMonthly) === 0;
    const sub = this.subRepo.create({
      companyId,
      planId: plan.id,
      status: isFree ? 'trial' : 'active',
      startDate: new Date().toISOString().split('T')[0],
      endDate: isFree ? null : new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
      notes: isFree ? 'Free plan — self-selected during onboarding' : null,
      assignedBy: userId,
    });
    const saved = await this.subRepo.save(sub);
    return { ...saved, plan };
  }

  private async seedDefaultChartOfAccounts(
    manager: EntityManager,
    companyId: string,
  ): Promise<void> {
    const rows = DEFAULT_CHART_OF_ACCOUNTS.map((a) =>
      manager.create(Account, {
        companyId,
        accountNumber: a.accountNumber,
        name: a.name,
        type: a.type,
        subType: a.subType,
        parentId: null,
        description: null,
        openingBalance: '0',
        balance: '0',
        isActive: true,
      }),
    );
    await manager.save(rows);
  }
}
