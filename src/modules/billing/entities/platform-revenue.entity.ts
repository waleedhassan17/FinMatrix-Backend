import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

/**
 * phase2.md — PLATFORM revenue ledger (the SaaS operator's income from
 * subscription fees). This is deliberately SEPARATE from every company's own
 * accounting books: no journal entry is posted, the accounting engine is never
 * touched. Exactly ONE row per approved submission — `submission_id` is unique,
 * which makes approval idempotent (re-approving records revenue only once).
 */
@Entity('platform_revenue')
@Index(['companyId'])
export class PlatformRevenue extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid', name: 'submission_id' })
  submissionId!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 32 })
  plan!: string;

  @Column({ type: 'integer', name: 'amount_minor_units' })
  amountMinorUnits!: number;

  @Column({ type: 'varchar', length: 8, default: 'PKR' })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'recorded_at' })
  recordedAt!: Date;
}
