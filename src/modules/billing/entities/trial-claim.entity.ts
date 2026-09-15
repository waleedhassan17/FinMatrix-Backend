import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';
import { Company } from '../../companies/entities/company.entity';
import { User } from '../../users/entities/user.entity';
import { PaymentSubmission } from './payment-submission.entity';

/**
 * pending  — a trial request is with a super-admin.
 * approved — the trial was granted. Stays forever: that email/phone has used it.
 * released — the request was rejected WITHOUT blocking; the email/phone is free
 *            to request again.
 * blocked  — the request was rejected and future trials refused for good.
 */
export type TrialClaimStatus = 'pending' | 'approved' | 'released' | 'blocked';

/**
 * One free trial per person — the hard guarantee.
 *
 * `trial_claims` records the normalized email and phone behind every trial
 * request. The partial unique indexes refuse a second claim on the same email
 * or phone while any earlier claim is not `released`. Service-level lookups
 * exist only to produce a friendly message; under concurrency it is the INDEX
 * that decides, which is why the request path also maps a unique violation
 * (23505) to the same answer.
 *
 * Every index, check and foreign key the FreeTrial migration creates is ALSO
 * declared here, with the same names. That is not decoration: environments that
 * run with DB_SYNCHRONIZE=true (local dev, the conformance suite) drop whatever
 * the entity does not declare — including the unique indexes this table exists
 * for — and the guarantee would disappear without an error.
 */
@Entity('trial_claims')
@Index('ux_trial_claims_email', ['emailNormalized'], {
  unique: true,
  where: `"status" <> 'released'`,
})
@Index('ux_trial_claims_phone', ['phoneNormalized'], {
  unique: true,
  where: `"status" <> 'released' AND "phone_normalized" IS NOT NULL`,
})
@Index('idx_trial_claims_submission', ['submissionId'])
@Check('CHK_trial_claims_status', `"status" IN ('pending', 'approved', 'released', 'blocked')`)
export class TrialClaim extends BaseEntity {
  /** normalizeEmail() of the requesting admin's email. */
  @Column({ type: 'text', name: 'email_normalized' })
  emailNormalized!: string;

  /** normalizePhone() of the company phone — canonical +92…, or null. */
  @Column({ type: 'text', name: 'phone_normalized', nullable: true })
  phoneNormalized!: string | null;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @ManyToOne(() => Company, { createForeignKeyConstraints: true })
  @JoinColumn({ name: 'company_id', foreignKeyConstraintName: 'fk_trial_claims_company' })
  company?: Company;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { createForeignKeyConstraints: true })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_trial_claims_user' })
  user?: User;

  /** The kind='TRIAL' payment submission this claim belongs to. */
  @Column({ type: 'uuid', name: 'submission_id', nullable: true })
  submissionId!: string | null;

  @ManyToOne(() => PaymentSubmission, { createForeignKeyConstraints: true })
  @JoinColumn({
    name: 'submission_id',
    foreignKeyConstraintName: 'fk_trial_claims_submission',
  })
  submission?: PaymentSubmission;

  @Column({ type: 'text', default: 'pending' })
  status!: TrialClaimStatus;

  @Column({ type: 'timestamptz', name: 'decided_at', nullable: true })
  decidedAt!: Date | null;
}
