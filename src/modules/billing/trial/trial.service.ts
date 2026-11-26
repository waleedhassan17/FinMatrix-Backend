import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { normalizeCompanyStatus } from '../../../common/utils/company-status.util';
import {
  normalizePhone,
  normalizeTaxId,
  trialEmailKey,
} from '../../../common/validation/contact-normalize';
import { isBlockedEmailDomain } from '../../../common/validation/disposable-email';
import {
  signupMode,
  trialAutoApprove,
  trialDays,
  trialRiskMaxIpAttempts,
} from '../../../config/launch.settings';
import { Company } from '../../companies/entities/company.entity';
import { UserCompany } from '../../companies/entities/user-company.entity';
import { MailService } from '../../mail/mail.service';
import { User } from '../../users/entities/user.entity';
import { BillingService, companySuspendedError } from '../billing.service';
import { PaymentSubmission } from '../entities/payment-submission.entity';
import { TrialAttempt } from '../entities/trial-attempt.entity';
import {
  TrialClaim,
  type TrialClaimSource,
  type TrialClaimStatus,
} from '../entities/trial-claim.entity';
import { getPlanConfig, plansForType, TRIAL_PLAN_KEY } from '../plan-config';
import {
  assertActivePlanTerms,
  requestedPlanLabel,
  UNSURE_PLAN,
} from '../plan-terms';
import {
  TRIAL_CLAIM_CONSTRAINT_REASONS,
  TRIAL_HELD_MESSAGE,
  TRIAL_INELIGIBLE_MESSAGES,
  trialNotEligibleBody,
  type TrialIneligibleReason,
} from './trial-messages';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hours the owner is told a HELD trial usually takes ("a few hours"). */
export const TRIAL_REVIEW_HOURS = 4;

/** Every identity of an account, as the one-trial rule compares them. */
export interface TrialIdentities {
  companyId: string;
  userId: string;
  emailKey: string;
  phone: string;
  taxId: string | null;
}

type Evaluation =
  | { eligible: true; identities: TrialIdentities }
  | { eligible: false; reason: TrialIneligibleReason };

/** Statuses that mean "this identity has had (or is having) its trial". */
const USED_STATUSES: TrialClaimStatus[] = [
  'pending',
  'approved',
  'blocked',
  'granted',
];

export interface StartTrialResult {
  status: 'active' | 'pending_approval';
  autoApproved: boolean;
  held: boolean;
  submissionId: string;
  trial: { endsAt: Date; days: number } | null;
  message: string | null;
  requestedPlanKey: string;
  estimatedActivationHours: number | null;
  billing: Awaited<ReturnType<BillingService['getStatus']>>;
}

/**
 * The free-trial lifecycle: who may start one, starting it (instantly when
 * eligible), holding risky requests for a person, admin overrides, extension,
 * ending early, and asking for activation once it is over.
 *
 * One rule set (evaluate) serves the setup screen's eligibility check, the
 * start itself and an admin "approve as trial", so a button is never shown
 * that the server will refuse — barring a race, which the unique indexes on
 * trial_claims settle.
 */
@Injectable()
export class TrialService {
  private readonly logger = new Logger(TrialService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(UserCompany)
    private readonly memberRepo: Repository<UserCompany>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TrialAttempt)
    private readonly attemptRepo: Repository<TrialAttempt>,
    private readonly billing: BillingService,
    private readonly mail: MailService,
    private readonly audit: PlatformAuditService,
  ) {}

  // ── Eligibility ─────────────────────────────────────────────────────────

  /** GET /companies/:id/trial-eligibility — for the setup screen. */
  async eligibilityFor(userId: string, companyId: string) {
    const company = await this.companyOrFail(companyId);
    await this.assertMember(userId, companyId);
    const result: Evaluation =
      company.createdBy !== userId
        ? { eligible: false, reason: 'TRIAL_NOT_OWNER' }
        : await this.evaluate(this.dataSource.manager, company, 'owner');
    const reason = result.eligible ? null : result.reason;
    return {
      eligible: result.eligible,
      reason,
      message: reason ? TRIAL_INELIGIBLE_MESSAGES[reason] : null,
      signupMode: signupMode(),
      trialDays: trialDays(),
      trialAutoApprove: trialAutoApprove(),
    };
  }

  /**
   * Every rule, in order, against one company row (locked by the caller when
   * it is about to act on the answer).
   *
   *   owner — the owner pressing "Start my free trial": trials must be on, and
   *           the company a draft that was never submitted, trialed or
   *           activated.
   *   admin — a super-admin approving a path-B request as a trial: the
   *           company may also be pending or rejected.
   */
  private async evaluate(
    em: EntityManager,
    company: Company,
    mode: 'owner' | 'admin',
  ): Promise<Evaluation> {
    const no = (reason: TrialIneligibleReason): Evaluation => ({
      eligible: false,
      reason,
    });
    if (mode === 'owner' && signupMode() === 'approval')
      return no('TRIAL_DISABLED');

    if (company.isTrial) return no('TRIAL_ALREADY_USED');
    const state = normalizeCompanyStatus(company.status);
    const allowed =
      mode === 'owner' ? ['draft'] : ['draft', 'pending', 'rejected'];
    if (
      !allowed.includes(state) ||
      company.paymentStatus === 'paid' ||
      !!company.suspendedAt
    ) {
      return no('COMPANY_NOT_DRAFT');
    }
    if (
      await em.getRepository(PaymentSubmission).exist({
        where: { companyId: company.id, status: 'submitted' },
      })
    ) {
      return no('REQUEST_PENDING_REVIEW');
    }
    if (plansForType(company.companyType).length === 0)
      return no('NO_PLANS_FOR_COMPANY_TYPE');

    const owner = await em
      .getRepository(User)
      .findOne({ where: { id: company.createdBy } });
    const emailKey = trialEmailKey(owner?.email);
    if (!owner || !emailKey || !owner.isEmailVerified)
      return no('EMAIL_NOT_VERIFIED');
    const phone = normalizePhone(company.phone);
    if (!phone) return no('TRIAL_PHONE_REQUIRED');
    if (isBlockedEmailDomain(owner.email))
      return no('TRIAL_EMAIL_DOMAIN_BLOCKED');
    const taxId = normalizeTaxId(company.taxId);

    // Friendly pre-check: it chooses the MESSAGE. Under concurrency the
    // partial unique indexes decide (see start()). Never names the other side.
    const qb = em
      .getRepository(TrialClaim)
      .createQueryBuilder('t')
      .where('t.status IN (:...used)', { used: USED_STATUSES })
      .andWhere(
        `(t.companyId = :companyId OR t.userId = :userId
          OR t.emailNormalized = :emailKey OR t.phoneNormalized = :phone
          ${taxId ? 'OR t.taxIdNormalized = :taxId' : ''})`,
        { companyId: company.id, userId: owner.id, emailKey, phone, taxId },
      );
    const claims = await qb.getMany();
    if (claims.some((c) => c.companyId === company.id))
      return no('TRIAL_ALREADY_USED');
    if (claims.some((c) => c.userId === owner.id)) return no('TRIAL_USER_USED');
    if (claims.some((c) => c.emailNormalized === emailKey))
      return no('TRIAL_EMAIL_USED');
    if (claims.some((c) => c.phoneNormalized === phone))
      return no('TRIAL_PHONE_USED');
    if (taxId && claims.some((c) => c.taxIdNormalized === taxId))
      return no('TRIAL_TAX_ID_USED');

    return {
      eligible: true,
      identities: {
        companyId: company.id,
        userId: owner.id,
        emailKey,
        phone,
        taxId,
      },
    };
  }

  /**
   * For the admin console: would "approve as a trial" work for this company?
   * The same rules as the owner's path, in admin mode (pending and rejected
   * companies qualify; SIGNUP_MODE does not apply to an admin's decision).
   */
  async adminEligibility(companyId: string) {
    const company = await this.companyOrFail(companyId);
    const result = await this.evaluate(
      this.dataSource.manager,
      company,
      'admin',
    );
    const reason = result.eligible ? null : result.reason;
    return {
      eligible: result.eligible,
      reason,
      message: reason ? TRIAL_INELIGIBLE_MESSAGES[reason] : null,
    };
  }

  // ── Start (owner) ───────────────────────────────────────────────────────

  /**
   * POST /companies/start-trial. Eligible + no risk signal + auto-approve on
   * → the trial starts NOW, in the same transaction that claims every
   * identity. A risk signal (or auto-approve off) → held for a person.
   * Ineligible → 409 TRIAL_NOT_ELIGIBLE and nothing changes.
   */
  async start(
    userId: string,
    companyId: string,
    ip: string | null,
  ): Promise<StartTrialResult> {
    const ipHash = hashIp(ip);
    let outcome = 'error';
    try {
      const company = await this.companyOrFail(companyId);
      await this.assertMember(userId, companyId);
      if (company.createdBy !== userId) {
        throw new ConflictException(trialNotEligibleBody('TRIAL_NOT_OWNER'));
      }

      const now = new Date();
      const tx = await this.dataSource.transaction(async (em) => {
        const locked = await em.getRepository(Company).findOne({
          where: { id: companyId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw this.companyNotFound();
        const ev = await this.evaluate(em, locked, 'owner');
        if (!ev.eligible) {
          throw new ConflictException(trialNotEligibleBody(ev.reason));
        }
        const holdReason = await this.riskSignal(em, ev.identities, ipHash);
        const auto = trialAutoApprove() && !holdReason;

        const { submission } = await this.fileTrialRequest(em, locked, {
          identities: ev.identities,
          claimStatus: 'pending',
          claimSource: auto ? 'auto' : 'request',
          submittedBy: userId,
          holdReason,
          now,
        });

        if (!auto) {
          return { submission, holdReason, approved: null };
        }
        const approved = await this.billing.approveTrialInTransaction(
          em,
          submission,
          locked,
          { userId: null, source: 'system:auto' },
        );
        return { submission, holdReason: null, approved };
      });

      const owner = await this.userRepo.findOne({ where: { id: userId } });
      if (tx.approved) {
        outcome = 'auto_approved';
        await this.billing.runAfterCommit(tx.approved.afterCommit);
        const endsAt = tx.approved.trialEndsAt as Date;
        await this.billing.runAfterCommit(async () => {
          await this.mail.sendTrialAutoApprovedAdminNotice(
            company.name,
            owner?.email ?? 'unknown',
            normalizePhone(company.phone),
            endsAt,
          );
          await this.audit.record({
            actorLabel: 'system:auto',
            action: 'trial_auto_approved',
            targetType: 'company',
            targetId: companyId,
            companyId,
            companyName: company.name,
            details: {
              submissionId: tx.submission.id,
              endsAt: endsAt.toISOString(),
              ownerUserId: userId,
            },
          });
        });
        this.logger.log(
          `Trial auto-approved: company ${companyId} by ${userId} until ${endsAt.toISOString()}`,
        );
        return {
          status: 'active',
          autoApproved: true,
          held: false,
          submissionId: tx.submission.id,
          trial: { endsAt, days: trialDays() },
          message: null,
          requestedPlanKey: TRIAL_PLAN_KEY,
          estimatedActivationHours: null,
          billing: await this.billing.getStatus(companyId),
        };
      }

      outcome = tx.holdReason ? 'held' : 'queued';
      await this.billing.runAfterCommit(async () => {
        if (owner?.email) {
          await this.mail.sendTrialRequestedEmail(
            owner.email,
            owner.displayName,
            company.name,
          );
        }
        await this.mail.sendTrialRequestedAdminNotice(
          company.name,
          owner?.email ?? 'unknown',
          normalizePhone(company.phone),
          tx.holdReason,
        );
        await this.audit.record({
          actorLabel: 'system:auto',
          action: tx.holdReason ? 'trial_held' : 'trial_queued',
          targetType: 'company',
          targetId: companyId,
          companyId,
          companyName: company.name,
          reason: tx.holdReason,
          details: { submissionId: tx.submission.id, ownerUserId: userId },
        });
      });
      return {
        status: 'pending_approval',
        autoApproved: false,
        held: true,
        submissionId: tx.submission.id,
        trial: null,
        message: TRIAL_HELD_MESSAGE,
        requestedPlanKey: TRIAL_PLAN_KEY,
        estimatedActivationHours: TRIAL_REVIEW_HOURS,
        billing: await this.billing.getStatus(companyId),
      };
    } catch (err) {
      const mapped = mapClaimViolation(err);
      const reason = reasonOf(mapped ?? err);
      if (reason) outcome = `ineligible:${reason}`;
      throw mapped ?? err;
    } finally {
      await this.recordAttempt(ipHash, userId, companyId, outcome);
    }
  }

  // ── Admin: approve a request as a trial, or grant one ────────────────────

  /**
   * A super-admin starts a trial for a company.
   *
   *   approve — a path-B request approved "as a trial": the full one-trial
   *             rule applies (claims inserted, unique indexes enforced).
   *   grant   — the override for an otherwise ineligible company: recorded
   *             as a `granted` claim, outside the unique indexes. Audited.
   */
  async startForAdmin(
    companyId: string,
    adminUserId: string,
    mode: 'approve' | 'grant',
    reason: string | null,
  ) {
    try {
      const now = new Date();
      const tx = await this.dataSource.transaction(async (em) => {
        const locked = await em.getRepository(Company).findOne({
          where: { id: companyId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw this.companyNotFound();
        if (locked.suspendedAt) throw companySuspendedError();

        let identities: TrialIdentities;
        if (mode === 'approve') {
          const ev = await this.evaluate(em, locked, 'admin');
          if (!ev.eligible) {
            throw new ConflictException(trialNotEligibleBody(ev.reason));
          }
          identities = ev.identities;
        } else {
          if (locked.isTrial) {
            throw new ConflictException({
              code: 'TRIAL_ALREADY_USED',
              message:
                'This company has already had a free trial. Use "Extend trial" instead.',
            });
          }
          const state = normalizeCompanyStatus(locked.status);
          if (state === 'active' || locked.paymentStatus === 'paid') {
            throw new ConflictException({
              code: 'COMPANY_ALREADY_ACTIVE',
              message: 'This company is already active.',
            });
          }
          if (
            await em.getRepository(PaymentSubmission).exist({
              where: { companyId, status: 'submitted' },
            })
          ) {
            throw new ConflictException({
              code: 'REQUEST_PENDING_REVIEW',
              message:
                'This company has a request waiting for review. Approve or reject that request instead.',
            });
          }
          const owner = await em
            .getRepository(User)
            .findOne({ where: { id: locked.createdBy } });
          identities = {
            companyId,
            userId: locked.createdBy,
            emailKey: trialEmailKey(owner?.email) ?? '',
            phone: normalizePhone(locked.phone) ?? '',
            taxId: normalizeTaxId(locked.taxId),
          };
        }

        const { submission } = await this.fileTrialRequest(em, locked, {
          identities,
          claimStatus: mode === 'grant' ? 'granted' : 'pending',
          claimSource: mode === 'grant' ? 'admin_grant' : 'request',
          submittedBy: adminUserId,
          holdReason: null,
          now,
        });
        const approved = await this.billing.approveTrialInTransaction(
          em,
          submission,
          locked,
          { userId: adminUserId, source: 'admin' },
        );
        return { approved, companyName: locked.name, submission };
      });

      await this.billing.runAfterCommit(tx.approved.afterCommit);
      await this.audit.record({
        actorUserId: adminUserId,
        action: mode === 'grant' ? 'trial_granted' : 'trial_approved',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: tx.companyName,
        reason,
        details: {
          submissionId: tx.submission.id,
          endsAt: tx.approved.trialEndsAt?.toISOString() ?? null,
          override: mode === 'grant',
        },
      });
      return {
        companyId,
        status: 'active' as const,
        trialEndsAt: tx.approved.trialEndsAt,
        submission: tx.approved.view,
      };
    } catch (err) {
      throw mapClaimViolation(err) ?? err;
    }
  }

  // ── Admin: extend, end early ────────────────────────────────────────────

  async extend(
    companyId: string,
    adminUserId: string,
    days: number,
    reason: string,
  ) {
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      throw new BadRequestException({
        code: 'INVALID_EXTENSION',
        message: 'A trial can be extended by 1 to 30 days at a time.',
      });
    }
    const now = new Date();
    const tx = await this.dataSource.transaction(async (em) => {
      const c = await this.lockTrialing(em, companyId);
      if (c.suspendedAt) throw companySuspendedError();
      const previousEnd = c.subscriptionExpiryDate
        ? new Date(c.subscriptionExpiryDate)
        : now;
      const base = previousEnd.getTime() > now.getTime() ? previousEnd : now;
      const newEnd = new Date(base.getTime() + days * DAY_MS);
      c.subscriptionExpiryDate = newEnd;
      c.subscriptionStatus = 'active';
      // An ended trial comes back to life; reminders run again before the
      // new end date.
      if (normalizeCompanyStatus(c.status) !== 'active') c.status = 'active';
      c.trialReminderMilestone = null;
      c.subscriptionReminderOn = null;
      assertActivePlanTerms(c);
      await em.getRepository(Company).save(c);
      return { company: c, previousEnd, newEnd };
    });

    await this.billing.runAfterCommit(async () => {
      await this.billing.notifyCompanyAdmins(companyId, {
        type: 'subscription_activated',
        title: 'Your free trial has been extended',
        message: `Your free trial now ends on ${tx.newEnd.toDateString()}.`,
        data: { expiryDate: tx.newEnd, route: 'billing' },
      });
      for (const a of await this.billing.adminRecipients(companyId)) {
        if (a.email) {
          await this.mail.sendTrialExtendedEmail(
            a.email,
            a.displayName,
            tx.company.name,
            tx.newEnd,
            days,
          );
        }
      }
      await this.audit.record({
        actorUserId: adminUserId,
        action: 'trial_extended',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: tx.company.name,
        reason,
        details: {
          days,
          previousEnd: tx.previousEnd.toISOString(),
          newEnd: tx.newEnd.toISOString(),
        },
      });
    });
    return { companyId, trialEndsAt: tx.newEnd, days };
  }

  async endEarly(companyId: string, adminUserId: string, reason: string) {
    const now = new Date();
    const tx = await this.dataSource.transaction(async (em) => {
      const c = await this.lockTrialing(em, companyId);
      if (c.suspendedAt) throw companySuspendedError();
      const expiry = c.subscriptionExpiryDate
        ? new Date(c.subscriptionExpiryDate)
        : null;
      if (!expiry || expiry.getTime() <= now.getTime()) {
        throw new ConflictException({
          code: 'TRIAL_ALREADY_ENDED',
          message: 'This trial has already ended.',
        });
      }
      c.subscriptionExpiryDate = now;
      c.subscriptionStatus = 'expired';
      c.status = 'inactive';
      await em.getRepository(Company).save(c);
      return { company: c };
    });

    await this.billing.runAfterCommit(async () => {
      await this.billing.notifyCompanyAdmins(companyId, {
        type: 'subscription_expired',
        title: 'Your free trial has been ended',
        message: `The FinMatrix team ended your free trial: ${reason}. Your data is safe.`,
        data: { route: 'billing' },
      });
      for (const a of await this.billing.adminRecipients(companyId)) {
        if (a.email) {
          await this.mail.sendTrialEndedEarlyEmail(
            a.email,
            a.displayName,
            tx.company.name,
            reason,
          );
        }
      }
      await this.audit.record({
        actorUserId: adminUserId,
        action: 'trial_ended_early',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: tx.company.name,
        reason,
      });
    });
    return { companyId, endedAt: now };
  }

  // ── Activation request (owner, no payment gateway) ──────────────────────

  /**
   * The owner asks FinMatrix to switch a plan on — during a trial (it ends
   * early, converted, on approval), after it ended, or after a plan expired.
   * Files a kind='ACTIVATION' row in the review queue: no amount, no
   * screenshot. Nothing changes until a super-admin approves it with a plan,
   * a start and an end date.
   */
  async requestActivation(
    userId: string,
    companyId: string,
    input: { requestedPlan?: string | null; note?: string | null },
  ) {
    const company = await this.companyOrFail(companyId);
    const member = await this.assertMember(userId, companyId);
    if (member.role !== 'admin') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the company owner can request activation.',
      });
    }
    const requestedPlan = (input.requestedPlan ?? UNSURE_PLAN).trim();
    const offered = plansForType(company.companyType).map((p) => p.key);
    if (
      requestedPlan !== UNSURE_PLAN &&
      !offered.includes(requestedPlan as (typeof offered)[number])
    ) {
      throw new BadRequestException({
        code: 'INVALID_PLAN',
        message: 'Choose one of the plans on offer, or "Not sure".',
      });
    }
    const note = (input.note ?? '').trim().slice(0, 1000) || null;

    const tx = await this.dataSource.transaction(async (em) => {
      const c = await em.getRepository(Company).findOne({
        where: { id: companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!c) throw this.companyNotFound();
      if (c.suspendedAt) throw companySuspendedError();
      const hadPlan = c.isTrial || c.subscriptionStartDate != null;
      const state = normalizeCompanyStatus(c.status);
      if (!hadPlan || (state !== 'active' && state !== 'inactive')) {
        throw new ConflictException({
          code: 'ACTIVATION_NOT_AVAILABLE',
          message:
            'Activation can be requested during or after a free trial, or after a plan has ended.',
        });
      }
      if (
        await em.getRepository(PaymentSubmission).exist({
          where: { companyId, status: 'submitted' },
        })
      ) {
        throw new ConflictException({
          code: 'REQUEST_PENDING_REVIEW',
          message: 'You already have a request awaiting review.',
        });
      }
      const repo = em.getRepository(PaymentSubmission);
      const submission = await repo.save(
        repo.create({
          companyId,
          plan: requestedPlan,
          kind: 'ACTIVATION',
          status: 'submitted',
          amountMinorUnits: 0,
          currency: 'PKR',
          screenshotKey: null,
          screenshotMime: null,
          submittedBy: userId,
          note,
        }),
      );
      c.paymentStatus = 'submitted';
      c.lastSubmissionId = submission.id;
      await em.getRepository(Company).save(c);
      return { submission, companyName: c.name };
    });

    const owner = await this.userRepo.findOne({ where: { id: userId } });
    await this.billing.runAfterCommit(async () => {
      if (owner?.email) {
        await this.mail.sendActivationRequestedEmail(
          owner.email,
          owner.displayName,
          tx.companyName,
        );
      }
      await this.mail.sendActivationRequestedAdminNotice(
        tx.companyName,
        owner?.email ?? owner?.username ?? 'unknown',
        requestedPlanLabel(requestedPlan),
        note,
      );
      await this.audit.record({
        actorUserId: userId,
        action: 'activation_requested',
        targetType: 'company',
        targetId: companyId,
        companyId,
        companyName: tx.companyName,
        details: { submissionId: tx.submission.id, requestedPlan, note },
      });
    });
    return {
      submissionId: tx.submission.id,
      requestedPlan,
      requestedPlanLabel: requestedPlanLabel(requestedPlan),
      billing: await this.billing.getStatus(companyId),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * The claim + the kind='TRIAL' review-queue row + the company's "awaiting
   * review" marker, inside the caller's transaction. A unique violation on any
   * identity aborts it (mapped by the caller).
   */
  private async fileTrialRequest(
    em: EntityManager,
    company: Company,
    opts: {
      identities: TrialIdentities;
      claimStatus: TrialClaimStatus;
      claimSource: TrialClaimSource;
      submittedBy: string;
      holdReason: string | null;
      now: Date;
    },
  ) {
    const claimRepo = em.getRepository(TrialClaim);
    const claim = await claimRepo.save(
      claimRepo.create({
        emailNormalized: opts.identities.emailKey || null,
        phoneNormalized: opts.identities.phone || null,
        taxIdNormalized: opts.identities.taxId,
        companyId: opts.identities.companyId,
        userId: opts.identities.userId,
        status: opts.claimStatus,
        source: opts.claimSource,
        submissionId: null,
        decidedAt: opts.claimStatus === 'granted' ? opts.now : null,
        releaseReason: null,
      }),
    );
    const trialConfig = getPlanConfig(TRIAL_PLAN_KEY);
    const submissionRepo = em.getRepository(PaymentSubmission);
    const submission = await submissionRepo.save(
      submissionRepo.create({
        companyId: company.id,
        plan: TRIAL_PLAN_KEY,
        kind: 'TRIAL',
        status: 'submitted',
        amountMinorUnits: 0,
        currency: trialConfig.currency,
        screenshotKey: null,
        screenshotMime: null,
        submittedBy: opts.submittedBy,
        holdReason: opts.holdReason,
      }),
    );
    await claimRepo.update({ id: claim.id }, { submissionId: submission.id });

    // Status stays as it is (draft/pending); nothing that grants or times
    // access is set here — approval does that.
    company.paymentStatus = 'submitted';
    company.lastSubmissionId = submission.id;
    company.trialRequestedAt = opts.now;
    await em.getRepository(Company).save(company);
    return { claim, submission };
  }

  /**
   * Why an otherwise eligible request should wait for a person, or null.
   * Never shown to the owner.
   */
  private async riskSignal(
    em: EntityManager,
    ids: TrialIdentities,
    ipHash: string | null,
  ): Promise<string | null> {
    if (ipHash) {
      const max = trialRiskMaxIpAttempts();
      const recent = await em
        .getRepository(TrialAttempt)
        .createQueryBuilder('a')
        .where('a.ipHash = :ipHash', { ipHash })
        .andWhere(`a.createdAt > now() - interval '24 hours'`)
        .getCount();
      if (recent >= max) {
        return `more than ${max} trial attempts from the same network in 24 hours`;
      }
    }
    const digits = ids.phone.replace(/\D/g, ''); // 923001234567
    const local = `0${digits.slice(2)}`; // 03001234567
    const flagged: Array<{ kind: string }> = await em.query(
      `SELECT 'company' AS kind FROM companies
        WHERE id <> $1
          AND (status = 'rejected' OR suspended_at IS NOT NULL)
          AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') IN ($2, $3, $4)
       UNION ALL
       SELECT 'user' AS kind FROM users
        WHERE suspended_at IS NOT NULL
          AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') IN ($2, $3, $4)
       LIMIT 1`,
      [ids.companyId, digits, local, `00${digits}`],
    );
    if (flagged.length > 0) {
      return flagged[0].kind === 'user'
        ? 'the phone number belongs to a suspended user'
        : 'the phone number was used on a rejected or suspended account';
    }
    return null;
  }

  private async recordAttempt(
    ipHash: string | null,
    userId: string,
    companyId: string,
    outcome: string,
  ): Promise<void> {
    try {
      await this.attemptRepo.save(
        this.attemptRepo.create({
          ipHash,
          userId,
          companyId: isUuid(companyId) ? companyId : null,
          outcome: outcome.slice(0, 64),
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Could not record trial attempt: ${(err as Error).message}`,
      );
    }
  }

  private async lockTrialing(em: EntityManager, companyId: string) {
    const c = await em.getRepository(Company).findOne({
      where: { id: companyId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!c) throw this.companyNotFound();
    if (!c.isTrial || c.trialConvertedAt) {
      throw new ConflictException({
        code: 'NOT_A_TRIAL',
        message: 'This company is not on a free trial.',
      });
    }
    return c;
  }

  private async companyOrFail(companyId: string): Promise<Company> {
    const company = isUuid(companyId)
      ? await this.companyRepo.findOne({ where: { id: companyId } })
      : null;
    if (!company) throw this.companyNotFound();
    return company;
  }

  private companyNotFound() {
    return new NotFoundException({
      code: 'COMPANY_NOT_FOUND',
      message: 'Company not found',
    });
  }

  private async assertMember(userId: string, companyId: string) {
    const member = await this.memberRepo.findOne({
      where: { userId, companyId },
    });
    if (!member) {
      throw new ForbiddenException({
        code: 'NOT_COMPANY_MEMBER',
        message: 'You are not a member of this company',
      });
    }
    return member;
  }
}

/** Unique violation on a trial_claims identity → the 409 the pre-check gives. */
function mapClaimViolation(err: unknown): HttpException | null {
  if (
    err instanceof QueryFailedError &&
    (err as unknown as { driverError?: { code?: string } }).driverError
      ?.code === '23505'
  ) {
    const constraint = String(
      (err as unknown as { driverError?: { constraint?: string } }).driverError
        ?.constraint ?? '',
    );
    const reason = TRIAL_CLAIM_CONSTRAINT_REASONS[constraint];
    if (reason) return new ConflictException(trialNotEligibleBody(reason));
  }
  return null;
}

function reasonOf(err: unknown): string | null {
  if (err instanceof HttpException) {
    const body = err.getResponse() as { details?: { reason?: string } };
    if (body && typeof body === 'object' && body.details?.reason)
      return body.details.reason;
  }
  return null;
}

/** A keyed hash of the client IP: equality is all the risk check needs. */
export function hashIp(ip: string | null | undefined): string | null {
  const value = (ip ?? '').trim();
  if (!value) return null;
  const key = `${process.env.JWT_SECRET ?? 'finmatrix'}:trial-ip`;
  return createHmac('sha256', key).update(value).digest('hex');
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v,
  );
}
