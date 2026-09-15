import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { PaymentSubmission } from '../billing/entities/payment-submission.entity';
import { TrialClaim } from '../billing/entities/trial-claim.entity';
import {
  getPlanConfig,
  plansForType,
  TRIAL_PLAN_KEY,
} from '../billing/plan-config';
import { normalizeCompanyStatus } from '../../common/utils/company-status.util';
import {
  normalizeEmail,
  normalizePhone,
} from '../../common/validation/contact-normalize';
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

/** Hours the owner is told a trial request takes to review. */
export const TRIAL_ACTIVATION_HOURS = 24;

const TRIAL_EMAIL_USED_MESSAGE = 'A free trial has already been used with this email address.';
const TRIAL_PHONE_USED_MESSAGE = 'A free trial has already been used with this phone number.';

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
      ...(dto.legalStructure !== undefined ? { legalStructure: dto.legalStructure } : {}),
      ...(dto.address !== undefined ? { address: dto.address } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.website !== undefined ? { website: dto.website } : {}),
      ...(dto.taxId !== undefined ? { taxId: dto.taxId } : {}),
      ...(dto.fiscalYearStartMonth !== undefined
        ? { fiscalYearStartMonth: dto.fiscalYearStartMonth }
        : {}),
      ...(dto.accountingMethod !== undefined ? { accountingMethod: dto.accountingMethod } : {}),
      ...(dto.homeCurrency !== undefined ? { homeCurrency: dto.homeCurrency } : {}),
      ...(dto.logo !== undefined ? { logo: dto.logo } : {}),
      ...(dto.setupCompleted !== undefined ? { setupCompleted: dto.setupCompleted } : {}),
      ...(dto.salesTaxRegistered !== undefined ? { salesTaxRegistered: dto.salesTaxRegistered } : {}),
      // Large-org per-company inventory opt-in. Harmless for other types:
      // FEATURE_MAP only honors the toggle when companyType is large_org.
      // companyType itself is deliberately NOT updatable here.
      ...(dto.inventoryEnabled !== undefined ? { inventoryEnabled: dto.inventoryEnabled } : {}),
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

    const today = new Date().toISOString().slice(0, 10);
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
    await this.userCompanyRepo.remove(membership);
    return { removed: true };
  }

  async regenerateCode(userId: string, companyId: string): Promise<Company> {
    await this.assertAdmin(userId, companyId);
    const company = await this.getById(userId, companyId);
    company.inviteCode = await this.generateUniqueInviteCode();
    return this.companyRepo.save(company);
  }

  // ── Submit onboarding for platform-admin approval (Step C) ─────────────────
  async submitForApproval(userId: string, companyId: string) {
    await this.assertAdmin(userId, companyId);
    const company = await this.companyRepo.findOneBy({ id: companyId });
    if (!company) {
      throw new NotFoundException({
        code: 'COMPANY_NOT_FOUND',
        message: 'Company not found',
      });
    }

    if (company.status === COMPANY_STATUS.PENDING_APPROVAL) {
      return this.toStatusResult(company); // idempotent
    }
    if (company.status === COMPANY_STATUS.APPROVED || company.status === 'active') {
      throw new BadRequestException({
        code: 'ALREADY_APPROVED',
        message: 'This company has already been approved',
      });
    }

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

    company.status = COMPANY_STATUS.PENDING_APPROVAL;
    company.submittedAt = new Date();
    company.rejectionReason = null;
    await this.companyRepo.save(company);

    // Notify the platform admin (best-effort).
    const owner = await this.userRepo.findOneBy({ id: company.createdBy });
    await this.mail.sendCompanySubmittedNotice(company.name, owner?.email ?? 'unknown');

    return this.toStatusResult(company);
  }

  // ── Free trial REQUEST ──────────────────────────────────────────────────────
  /**
   * Ask for the 30-day free trial. This STARTS NOTHING — it files a
   * kind='TRIAL' request in the same review queue as bank-transfer payments,
   * and the company stays locked out (effectiveCompanyStatus reports
   * `pending`) until a super-admin approves it. The 30 days are counted from
   * that approval (BillingService.approveSubmission), never from here.
   *
   * The owner must already have done what every registration requires: a
   * verified email and a company set up with a valid phone number. Those are
   * checked here, server-side, so no client can skip them.
   */
  async requestTrial(userId: string, companyId: string) {
    // a. The company exists.
    const company = await this.companyRepo.findOneBy({ id: companyId });
    if (!company) {
      throw new NotFoundException({
        code: 'COMPANY_NOT_FOUND',
        message: 'Company not found',
      });
    }
    // b. Only the company's own admin may ask.
    await this.assertAdmin(userId, companyId);

    // c–e. The company is still an unsubmitted draft with nothing in review
    // and no trial in its history.
    this.assertTrialStillPossible(company);
    if (await this.submissionRepo.exist({ where: { companyId, status: 'submitted' } })) {
      throw new ConflictException({
        code: 'REQUEST_PENDING_REVIEW',
        message: 'You already have a request awaiting review.',
      });
    }

    // f. The company can buy a plan once the trial ends — otherwise a trial
    // would lead nowhere.
    if (plansForType(company.companyType).length === 0) {
      throw new BadRequestException({
        code: 'NO_PLANS_FOR_COMPANY_TYPE',
        message: 'Free trials are not available for this type of company.',
      });
    }

    // g. A verified email — the identity the trial is tied to.
    const user = await this.userRepo.findOneBy({ id: userId });
    const email = normalizeEmail(user?.email);
    if (!user || !email || !user.isEmailVerified) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address before requesting a free trial.',
      });
    }

    // h. A valid phone. REQUIRED, not "checked if present": skipping the check
    // for a missing phone would let anyone dodge the one-trial-per-number
    // rule by leaving the field blank.
    const phone = normalizePhone(company.phone);
    if (!phone) {
      throw new BadRequestException({
        code: 'TRIAL_PHONE_REQUIRED',
        message: 'A valid phone number is required to request a free trial.',
      });
    }

    const now = new Date();
    let submissionId: string;
    try {
      submissionId = await this.dataSource.transaction(async (em) => {
        // Lock the company row so two requests for the SAME company serialize,
        // then re-check what may have changed while we were validating.
        const locked = await em.getRepository(Company).findOne({
          where: { id: companyId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) {
          throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
        }
        this.assertTrialStillPossible(locked);
        if (
          await em
            .getRepository(PaymentSubmission)
            .exist({ where: { companyId, status: 'submitted' } })
        ) {
          throw new ConflictException({
            code: 'REQUEST_PENDING_REVIEW',
            message: 'You already have a request awaiting review.',
          });
        }

        // 1. Friendly pre-check. It only chooses the MESSAGE; the partial
        //    unique indexes on trial_claims are the guarantee (see catch).
        //    Never names the other company or user.
        const existing = await em
          .getRepository(TrialClaim)
          .createQueryBuilder('t')
          .where(`t.status <> 'released'`)
          .andWhere('(t.emailNormalized = :email OR t.phoneNormalized = :phone)', { email, phone })
          .getMany();
        if (existing.some((c) => c.emailNormalized === email)) {
          throw new ForbiddenException({ code: 'TRIAL_EMAIL_USED', message: TRIAL_EMAIL_USED_MESSAGE });
        }
        if (existing.length > 0) {
          throw new ForbiddenException({ code: 'TRIAL_PHONE_USED', message: TRIAL_PHONE_USED_MESSAGE });
        }

        // 2. The claim.
        const claimRepo = em.getRepository(TrialClaim);
        const claim = await claimRepo.save(
          claimRepo.create({
            emailNormalized: email,
            phoneNormalized: phone,
            companyId,
            userId,
            status: 'pending',
            submissionId: null,
            decidedAt: null,
          }),
        );

        // 3. The review-queue row, shaped like createSubmission's: server-set
        //    plan and amount, submitter recorded — minus the screenshot, since
        //    there is nothing to pay.
        const trialConfig = getPlanConfig(TRIAL_PLAN_KEY);
        const submissionRepo = em.getRepository(PaymentSubmission);
        const submission = await submissionRepo.save(
          submissionRepo.create({
            companyId,
            plan: TRIAL_PLAN_KEY,
            kind: 'TRIAL',
            status: 'submitted',
            amountMinorUnits: 0,
            currency: trialConfig.currency,
            screenshotKey: null,
            screenshotMime: null,
            submittedBy: userId,
          }),
        );

        // 4. Link them.
        await claimRepo.update({ id: claim.id }, { submissionId: submission.id });

        // 5. Mark the company as awaiting review — exactly what uploading a
        //    payment receipt does. Status stays draft; NOTHING that grants or
        //    times access is set here (no isTrial, no trialStartedAt, no
        //    expiry, no plan).
        locked.paymentStatus = 'submitted';
        locked.lastSubmissionId = submission.id;
        locked.trialRequestedAt = now;
        await em.getRepository(Company).save(locked);

        return submission.id;
      });
    } catch (err) {
      // Two requests with the same email/phone that both passed the pre-check
      // race to insert; the unique index lets exactly one through. Answer the
      // loser exactly as the pre-check would have — never with a driver error.
      if (err instanceof QueryFailedError && (err as any).driverError?.code === '23505') {
        const constraint = String((err as any).driverError?.constraint ?? '');
        throw new ForbiddenException(
          constraint === 'ux_trial_claims_phone'
            ? { code: 'TRIAL_PHONE_USED', message: TRIAL_PHONE_USED_MESSAGE }
            : { code: 'TRIAL_EMAIL_USED', message: TRIAL_EMAIL_USED_MESSAGE },
        );
      }
      throw err;
    }

    this.logger.log(`Trial requested: company ${companyId} by ${userId} (submission ${submissionId})`);

    // After commit, best-effort: mail must never undo or block the request.
    try {
      await this.mail.sendTrialRequestedEmail(user.email as string, user.displayName, company.name);
    } catch (err) {
      this.logger.error(`Trial requested email failed: ${(err as Error).message}`);
    }
    try {
      await this.mail.sendTrialRequestedAdminNotice(company.name, user.email as string, phone);
    } catch (err) {
      this.logger.error(`Trial request admin notice failed: ${(err as Error).message}`);
    }

    return {
      status: 'pending_approval' as const,
      submissionId,
      requestedPlanKey: TRIAL_PLAN_KEY,
      requestedPlanLabel: getPlanConfig(TRIAL_PLAN_KEY).label,
      requestedAt: now,
      estimatedActivationHours: TRIAL_ACTIVATION_HOURS,
      // The same shape GET /billing/status returns, so clients need one type.
      billing: await this.billing.getStatus(companyId),
    };
  }

  /** Preconditions c and e — shared by the pre-check and the locked re-check. */
  private assertTrialStillPossible(company: Company) {
    if (company.isTrial) {
      throw new ForbiddenException({
        code: 'TRIAL_ALREADY_USED',
        message: 'This company has already used its free trial.',
      });
    }
    if (normalizeCompanyStatus(company.status) !== 'draft') {
      throw new BadRequestException({
        code: 'COMPANY_ALREADY_ACTIVE',
        message: 'This company has already been activated.',
      });
    }
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
