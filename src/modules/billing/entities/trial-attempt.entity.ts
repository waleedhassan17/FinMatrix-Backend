import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per "Start my free trial" press, whatever the outcome — the input
 * to the "too many attempts from one IP" risk signal. The IP is stored only as
 * a keyed hash (equality is all the check needs). Rows older than 30 days are
 * swept by the billing cron.
 */
@Entity('trial_attempts')
@Index('idx_trial_attempts_ip', ['ipHash', 'createdAt'])
export class TrialAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, name: 'ip_hash', nullable: true })
  ipHash!: string | null;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @Column({ type: 'uuid', name: 'company_id', nullable: true })
  companyId!: string | null;

  /** auto_approved | held | queued | ineligible:<REASON> | error */
  @Column({ type: 'varchar', length: 64 })
  outcome!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
