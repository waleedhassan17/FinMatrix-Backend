import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { DemoRequestsService } from '../demo-requests/demo-requests.service';
import { PaymentSubmission } from '../billing/entities/payment-submission.entity';
import { plansForType } from '../billing/plan-config';
import { requestedPlanLabel, UNSURE_PLAN } from '../billing/plan-terms';
import { SubmitForApprovalDto } from './dto/signup-paths.dto';
import { normalizeCompanyStatus } from '../../common/utils/company-status.util';
import { BILLING_DISABLED_BUILD } from '../../common/feature-flags';
import { Company } from './entities/company.entity';
import { UserCompany } from './entities/user-company.entity';
import { User } from '../users/entities/user.entity';
import {
  CreateCompanyDto,
  JoinCompanyDto,
  UpdateCompanyDto,
  WAREHOUSE_ONLY_COMPANY_TYPE,
} from './dto/create-company.dto';
import { generateInviteCode } from '../../common/utils/reference-generator.util';
import { Account } from '../accounts/entities/account.entity';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../accounts/accounts.constants';
import { SubscriptionPlan } from '../super-admin/entities/subscription-plan.entity';
import { CompanySubscription } from '../super-admin/entities/company-subscription.entity';
import { MailService } from '../mail/mail.service';
import { COMPANY_STATUS } from '../../types';
import { revokeRefreshTokens } from '../../common/utils/session-revocation.util';
import {
  addDaysIso,
  businessToday,
} from '../../common/utils/business-date.util';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

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
    private readonly mail: MailService,
    @InjectRepository(PaymentSubmission)
    private readonly submissionRepo: Repository<PaymentSubmission>,
    private readonly billing: BillingService,
    private readonly demos: DemoRequestsService,
  ) {}

  async create(userId: string, dto: CreateCompanyDto): Promise<Company> {
    return this.dataSource.transaction(async (manager) => {
      const inviteCode = await this.generateUniqueInviteCode(manager);
      const company = manager.create(Company, {
        name: dto.name,
        industry: dto.industry ?? null,
        legalStructure: dto.legalStructure ?? null,
        address: dto.address ?? null,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        website: dto.website ?? null,
        taxId: dto.taxId ?? null,
        fiscalYearStartMonth: dto.fiscalYearStartMonth ?? null,
        // Accrual is the only basis the reports implement (G8); record it
        // explicitly rather than leaving NULL to be interpreted.
        accountingMethod: 'accrual',
        homeCurrency: dto.homeCurrency ?? null,
        logo: dto.logo ?? null,
        // Three-tier model: chosen on the registration type step. Never
        // changeable via the normal update path (self-upgrade would bypass
        // the plans) — only super-admin can change it later.
        //
        // WAREHOUSE-ONLY BUILD: default to warehouse rather than null. The
        // DTO's @Transform only fires when the key is PRESENT, so a caller
        // that omits companyType entirely would otherwise land a null row.
        // Restore `?? null` alongside the DTO enum to bring back three tiers.
        companyType: dto.companyType ?? WAREHOUSE_ONLY_COMPANY_TYPE,
        inviteCode,
        createdBy: userId,
        // Onboarding draft — not yet submitted for approval.
        status: COMPANY_STATUS.EMAIL_VERIFIED,
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
      // An owner who signed up from a demo's trial invite: link the demo.
      if (user?.signupRef) {
        await this.demos.convertFromSignup(manager, user.signupRef, company.id);
      }
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
      ...(dto.legalStructure !== undefined
        ? { legalStructure: dto.legalStructure }
        : {}),
      ...(dto.address !== undefined ? { address: dto.address } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.website !== undefined ? { website: dto.website } : {}),
      ...(dto.taxId !== undefined ? { taxId: dto.taxId } : {}),
      ...(dto.fiscalYearStartMonth !== undefined
        ? { fiscalYearStartMonth: dto.fiscalYearStartMonth }
        : {}),
      ...(dto.accountingMethod !== undefined
        ? { accountingMethod: dto.accountingMethod }
        : {}),
      ...(dto.homeCurrency !== undefined
        ? { homeCurrency: dto.homeCurrency }
        : {}),
      ...(dto.logo !== undefined ? { logo: dto.logo } : {}),
      ...(dto.setupCompleted !== undefined
        ? { setupCompleted: dto.setupCompleted }
        : {}),
      ...(dto.salesTaxRegistered !== undefined
        ? { salesTaxRegistered: dto.salesTaxRegistered }
        : {}),
      // Large-org per-company inventory opt-in. Harmless for other types:
      // FEATURE_MAP only honors the toggle when companyType is large_org.
      // companyType itself is deliberately NOT updatable here.
      ...(dto.inventoryEnabled !== undefined
        ? { inventoryEnabled: dto.inventoryEnabled }
        : {}),
    });
    return this.companyRepo.save(company);
  }

  /**
   * Close the books through `lockDate` (audit gap G4).
   *
   * PostingService.assertPeriodOpen already rejects anything dated on or
   * before the lock, centrally, for every document type. What was missing was
   * a way to set the lock deliberately: books_locked_until was reachable only
   * through the generic company PATCH, and the `periodClose` tier feature was
   * declared but wired to nothing.
   *
   * Stamps books_locked_at so a later back-dated posting is distinguishable
   * from one legitimately made before the close — the distinction invariant
   * I12 depends on.
   */
  async closePeriod(
    userId: string,
    companyId: string,
    lockDate: string,
  ): Promise<Company> {
    await this.assertAdmin(userId, companyId);
    const company = await this.getById(userId, companyId);

    // The business day, as postings are dated: by the UTC date, an owner closing
    // "today" between 00:00 and 05:00 PKT was told the day had not finished.
    const today = businessToday();
    if (lockDate > today) {
      throw new BadRequestException({
        code: 'LOCK_DATE_IN_FUTURE',
        message: 'You cannot close a period that has not finished yet.',
      });
    }
    // Closing is one-way until an explicit reopen: moving the lock BACKWARDS
    // silently would reopen a period without anyone asking for it.
    if (company.booksLockedUntil && lockDate < company.booksLockedUntil) {
      throw new BadRequestException({
        code: 'PERIOD_ALREADY_CLOSED',
        message:
          `The books are already closed through ${company.booksLockedUntil}. ` +
          'Reopen them first to move the lock earlier.',
      });
    }

    company.booksLockedUntil = lockDate;
    company.booksLockedAt = new Date();
    return this.companyRepo.save(company);
  }

  /**
   * Reopen the books. Clears both the lock date and the stamp, so an entry
   * posted after a reopen is not judged against a lock that no longer applies.
   */
  async reopenPeriod(userId: string, companyId: string): Promise<Company> {
    await this.assertAdmin(userId, companyId);
    const company = await this.getById(userId, companyId);
    if (!company.booksLockedUntil) {
      throw new BadRequestException({
        code: 'PERIOD_NOT_CLOSED',
        message: 'The books are not closed.',
      });
    }
    company.booksLockedUntil = null;
    company.booksLockedAt = null;
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
    // Removing the membership and ending the member's sessions are one act:
    // a refresh token that outlived the membership used to keep the company.
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(UserCompany).remove(membership);
      await revokeRefreshTokens(em, targetUserId);
    });
    return { removed: true };
  }

  async regenerateCode(userId: string, companyId: string): Promise<Company> {
    await this.assertAdmin(userId, companyId);
    const company = await this.getById(userId, companyId);
    company.inviteCode = await this.generateUniqueInviteCode();
    return this.companyRepo.save(company);
  }

  // ── Submit onboarding for platform-admin approval (Step C) ─────────────────
  /**
   * Sign-up path B — "Request account approval". The company becomes
   * `pending_approval`; a super-admin approves it with a plan, a start and an
   * end date (or as a trial, if it is still eligible), or rejects it.
   *
   * Only a draft (never submitted) or a rejected company (resubmitting) may
   * be submitted. An expired or suspended company used to be able to call
   * this and lock itself into "pending"; it now asks for activation instead.
   */
  async submitForApproval(
    userId: string,
    companyId: string,
    input: SubmitForApprovalDto = {},
  ) {
    await this.assertAdmin(userId, companyId);
    const company = await this.companyRepo.findOneBy({ id: companyId });
    if (!company) {
      throw new NotFoundException({
        code: 'COMPANY_NOT_FOUND',
        message: 'Company not found',
      });
    }

    const requestedPlan = this.validRequestedPlan(company, input.requestedPlan);
    const note = (input.note ?? '').trim().slice(0, 1000) || null;

    if (company.status === COMPANY_STATUS.PENDING_APPROVAL) {
      // Idempotent; a resend may add the plan or note the first call lacked.
      if (input.requestedPlan !== undefined || input.note !== undefined) {
        company.requestedPlan = requestedPlan ?? company.requestedPlan;
        company.approvalNote = note ?? company.approvalNote;
        await this.companyRepo.save(company);
      }
      return this.toStatusResult(company);
    }
    if (
      company.status === COMPANY_STATUS.APPROVED ||
      company.status === 'active'
    ) {
      throw new BadRequestException({
        code: 'ALREADY_APPROVED',
        message: 'This company has already been approved',
      });
    }
    const state = normalizeCompanyStatus(company.status);
    if ((state !== 'draft' && state !== 'rejected') || company.suspendedAt) {
      throw new ConflictException({
        code: 'COMPANY_NOT_SUBMITTABLE',
        message:
          'This company cannot be submitted for approval now. If its trial or plan has ended, request activation instead.',
      });
    }
    if (
      await this.submissionRepo.exist({
        where: { companyId, status: 'submitted' },
      })
    ) {
      throw new ConflictException({
        code: 'REQUEST_PENDING_REVIEW',
        message: 'You already have a request awaiting review.',
      });
    }

    // BILLING-DISABLED BUILD: there is no plan step, so requiring a plan here
    // would strand every new company in `draft` — submitted by nobody, absent
    // from the admin queue, and 403ing on every business request. The clients
    // now call this straight off company creation instead. The check is kept
    // verbatim behind the flag; restoring it is flipping the flag back.
    if (!BILLING_DISABLED_BUILD) {
      // A subscription plan must be selected before submitting (Step B).
      const sub = await this.subRepo.findOne({
        where: [
          { companyId, status: 'active' },
          { companyId, status: 'trial' },
        ],
      });
      if (!sub) {
        throw new BadRequestException({
          code: 'PLAN_REQUIRED',
          message: 'Please select a subscription plan before submitting',
        });
      }
    }

    company.status = COMPANY_STATUS.PENDING_APPROVAL;
    company.submittedAt = new Date();
    company.rejectionReason = null;
    company.requestedPlan = requestedPlan;
    company.approvalNote = note;
    await this.companyRepo.save(company);

    // Notify the platform admin (best-effort).
    const owner = await this.userRepo.findOneBy({ id: company.createdBy });
    await this.mail.sendCompanySubmittedNotice(
      company.name,
      owner?.email ?? 'unknown',
      requestedPlanLabel(requestedPlan),
      note,
    );

    return this.toStatusResult(company);
  }

  /** 'unsure', an offered plan key, or null when none was given. */
  private validRequestedPlan(
    company: Company,
    raw: string | undefined,
  ): string | null {
    const value = (raw ?? '').trim();
    if (!value) return null;
    if (value === UNSURE_PLAN) return value;
    if (plansForType(company.companyType).some((p) => p.key === value)) {
      return value;
    }
    throw new BadRequestException({
      code: 'INVALID_PLAN',
      message: 'Choose one of the plans on offer, or "Not sure".',
    });
  }

  private toStatusResult(company: Company) {
    return {
      id: company.id,
      name: company.name,
      status: company.status,
      submittedAt: company.submittedAt,
    };
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
    if (!companyId)
      throw new BadRequestException('No company associated with your account');

    // The plan is the owner's decision. Any member — staff, a rider — could
    // make it before.
    await this.assertAdmin(userId, companyId);

    const plan = await this.planRepo.findOne({
      where: { id: planId, isActive: true },
    });
    if (!plan) throw new NotFoundException('Subscription plan not found');

    const isFree = parseFloat(plan.priceMonthly) === 0;
    // Cancelling the old subscription and recording the new one stand or fall
    // together: a failure between them used to leave the company with none.
    const saved = await this.dataSource.transaction(async (em) => {
      await em
        .createQueryBuilder()
        .update(CompanySubscription)
        .set({ status: 'cancelled' })
        .where('company_id = :cid AND status IN (:...s)', {
          cid: companyId,
          s: ['active', 'trial'],
        })
        .execute();

      const repo = em.getRepository(CompanySubscription);
      return repo.save(
        repo.create({
          companyId,
          planId: plan.id,
          status: isFree ? 'trial' : 'active',
          startDate: businessToday(),
          endDate: isFree ? null : addDaysIso(businessToday(), 365),
          notes: isFree ? 'Free plan — self-selected during onboarding' : null,
          assignedBy: userId,
        }),
      );
    });
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
        systemRole: a.systemRole ?? null,
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
