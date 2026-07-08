import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

export type SubmissionKind = 'NEW' | 'RENEWAL' | 'UPGRADE';
export type SubmissionStatus = 'submitted' | 'approved' | 'rejected';

/**
 * phase2.md — a manual bank-transfer payment submission (bill + screenshot)
 * awaiting super-admin verification. One reusable record type across all three
 * flows (signup / renewal / upgrade); the `kind` labels which flow it came from.
 * The amount is always server-set from PLAN_CONFIG (never trusted from client).
 */
@Entity('platform_payment_submissions')
@Index(['companyId', 'createdAt'])
@Index(['status'])
export class PaymentSubmission extends BaseEntity {
  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 32 })
  plan!: string; // legacy standard|pro or a tier plan key (e.g. small_business_3mo)

  @Column({ type: 'varchar', length: 16 })
  kind!: SubmissionKind;

  @Column({ type: 'varchar', length: 16, default: 'submitted' })
  status!: SubmissionStatus;

  /** Amount due in minor units (paisa) — copied from PLAN_CONFIG at submit time. */
  @Column({ type: 'integer', name: 'amount_minor_units' })
  amountMinorUnits!: number;

  @Column({ type: 'varchar', length: 8, default: 'PKR' })
  currency!: string;

  /** StorageService key for the uploaded transfer screenshot (streamed on demand). */
  @Column({ type: 'text', name: 'screenshot_key', nullable: true })
  screenshotKey!: string | null;

  /**
   * Screenshot bytes stored in Postgres — the durable copy. Heroku's dyno
   * filesystem is ephemeral (wiped on every restart/deploy), so disk-only
   * storage loses the file before the super-admin reviews it. `select: false`
   * keeps list queries light; loaded explicitly only when streaming.
   */
  @Column({ type: 'bytea', name: 'screenshot_data', nullable: true, select: false })
  screenshotData!: Buffer | null;

  @Column({ type: 'varchar', length: 64, name: 'screenshot_mime', nullable: true })
  screenshotMime!: string | null;

  @Column({ type: 'uuid', name: 'submitted_by', nullable: true })
  submittedBy!: string | null;

  @Column({ type: 'uuid', name: 'reviewed_by', nullable: true })
  reviewedBy!: string | null;

  @Column({ type: 'timestamptz', name: 'reviewed_at', nullable: true })
  reviewedAt!: Date | null;

  @Column({ type: 'text', name: 'rejection_reason', nullable: true })
  rejectionReason!: string | null;
}
