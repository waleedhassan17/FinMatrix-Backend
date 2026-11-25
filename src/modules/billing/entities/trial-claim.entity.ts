import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';
import { Company } from '../../companies/entities/company.entity';
import { User } from '../../users/entities/user.entity';
import { PaymentSubmission } from './payment-submission.entity';

/**
 * pending  — a trial request is with a super-admin (held for review).
 * approved — the trial was granted. Stays forever: every identity on it has
 *            used its free trial.
 * released — the identities are free again: the request was rejected without
 *            blocking, or the account was deleted with "allow a new trial".
 * blocked  — the request was rejected and future trials refused for good.
 * granted  — a super-admin override (grant-trial). Recorded for history and
 *            for the friendly pre-check, but outside the unique indexes: it
 *            exists precisely because an identity on it was already claimed.
 */
export type TrialClaimStatus =
  | 'pending'
  | 'approved'
  | 'released'
  | 'blocked'
  | 'granted';

/** Statuses that hold an identity under the partial unique indexes. */
export const TRIAL_CLAIM_HOLDING_STATUSES: readonly TrialClaimStatus[] = [
  'pending',
  'approved',
  'blocked',
];

/** request = owner asked · auto = instant approval · admin_grant · backfill. */
export type TrialClaimSource = 'request' | 'auto' | 'admin_grant' | 'backfill';

const HOLDING = `"status" IN ('pending', 'approved', 'blocked')`;

/**
 * One free trial per ACCOUNT — the hard guarantee.
 *
 * A trial may be used once, ever, and "account" is every one of: the owner's
 * user, the email (trialEmailKey — Gmail dots and +tags folded), the phone
 * (E.164), the company, and the NTN when one was given. Each identity has a
 * partial unique index over the holding statuses, so ANY one match refuses a
 * second claim. Service-level lookups exist only to produce a friendly
 * message; under concurrency it is the INDEX that decides, which is why the
 * request path maps a unique violation (23505) to the same answer.
 *
 * Deleting a company or user nulls company_id / user_id (ON DELETE SET NULL)
 * and KEEPS the email, phone and NTN keys, so a deleted-and-re-registered
 * account cannot farm trials — unless the admin chose "allow a new free trial",
 * which releases the claims.
 *
 * Every index, check and foreign key the migrations create is ALSO declared
 * here, with the same names. Environments that run with DB_SYNCHRONIZE=true
 * (local dev, the conformance suite) drop whatever the entity does not declare
 * — including the unique indexes this table exists for.
 */
@Entity('trial_claims')
@Index('ux_trial_claims_email', ['emailNormalized'], {
  unique: true,
  where: `${HOLDING} AND "email_normalized" IS NOT NULL`,
})
@Index('ux_trial_claims_phone', ['phoneNormalized'], {
  unique: true,
  where: `${HOLDING} AND "phone_normalized" IS NOT NULL`,
})
@Index('ux_trial_claims_user', ['userId'], {
  unique: true,
  where: `${HOLDING} AND "user_id" IS NOT NULL`,
})
@Index('ux_trial_claims_company', ['companyId'], {
  unique: true,
  where: `${HOLDING} AND "company_id" IS NOT NULL`,
})
@Index('ux_trial_claims_tax_id', ['taxIdNormalized'], {
  unique: true,
  where: `${HOLDING} AND "tax_id_normalized" IS NOT NULL`,
})
@Index('idx_trial_claims_submission', ['submissionId'])
@Check(
  'CHK_trial_claims_status',
  `"status" IN ('pending', 'approved', 'released', 'blocked', 'granted')`,
)
export class TrialClaim extends BaseEntity {
  /** trialEmailKey() of the owner's email. Null only on a legacy row. */
  @Column({ type: 'text', name: 'email_normalized', nullable: true })
  emailNormalized!: string | null;

  /** normalizePhone() of the company phone — canonical +92…, or null. */
  @Column({ type: 'text', name: 'phone_normalized', nullable: true })
  phoneNormalized!: string | null;

  /** normalizeTaxId() of the company NTN — digits only — when one was given. */
  @Column({ type: 'text', name: 'tax_id_normalized', nullable: true })
  taxIdNormalized!: string | null;

  /** The company that claimed. Nulled if the company is deleted. */
  @Column({ type: 'uuid', name: 'company_id', nullable: true })
  companyId!: string | null;

  @ManyToOne(() => Company, {
    createForeignKeyConstraints: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'company_id',
    foreignKeyConstraintName: 'fk_trial_claims_company',
  })
  company?: Company;

  /** The owner who claimed. Nulled if the user is deleted. */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, {
    createForeignKeyConstraints: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_trial_claims_user',
  })
  user?: User;

  /** The kind='TRIAL' payment submission this claim belongs to. */
  @Column({ type: 'uuid', name: 'submission_id', nullable: true })
  submissionId!: string | null;

  @ManyToOne(() => PaymentSubmission, {
    createForeignKeyConstraints: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'submission_id',
    foreignKeyConstraintName: 'fk_trial_claims_submission',
  })
  submission?: PaymentSubmission;

  @Column({ type: 'text', default: 'pending' })
  status!: TrialClaimStatus;

  @Column({ type: 'text', default: 'request' })
  source!: TrialClaimSource;

  /** Why a claim was released (e.g. 'rejected', 'account_deleted'). */
  @Column({ type: 'text', name: 'release_reason', nullable: true })
  releaseReason!: string | null;

  @Column({ type: 'timestamptz', name: 'decided_at', nullable: true })
  decidedAt!: Date | null;
}
