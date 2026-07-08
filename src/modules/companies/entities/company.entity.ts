import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';
import { UserCompany } from './user-company.entity';

export interface CompanyAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

@Entity('companies')
export class Company extends BaseEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  industry!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  address!: CompanyAddress | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'tax_id' })
  taxId!: string | null;

  // ── QuickBooks-style onboarding fields (Stage 1) ──────────────────────────
  @Column({
    type: 'varchar',
    length: 32,
    nullable: true,
    name: 'legal_structure',
  })
  legalStructure!: string | null; // sole_proprietor | llc | partnership | corporation

  @Column({ type: 'varchar', length: 255, nullable: true })
  website!: string | null;

  @Column({
    type: 'smallint',
    nullable: true,
    name: 'fiscal_year_start_month',
  })
  fiscalYearStartMonth!: number | null; // 1-12 (1 = January)

  @Column({
    type: 'varchar',
    length: 16,
    nullable: true,
    name: 'accounting_method',
  })
  accountingMethod!: string | null; // cash | accrual

  @Column({
    type: 'varchar',
    length: 8,
    nullable: true,
    name: 'home_currency',
  })
  homeCurrency!: string | null; // ISO 4217, e.g. PKR, USD

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 16, name: 'invite_code' })
  inviteCode!: string;

  @Column({ type: 'text', nullable: true })
  logo!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'varchar', length: 20, default: 'active', nullable: true })
  status!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'submitted_at' })
  submittedAt!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'rejection_reason' })
  rejectionReason!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reviewed_at' })
  reviewedAt!: Date | null;

  @Column({ type: 'boolean', default: false, name: 'setup_completed' })
  setupCompleted!: boolean;

  // ── Three-tier model (FinMatrix.md) ───────────────────────────────────────
  // small_business | large_org | warehouse. Chosen at registration; existing
  // pre-tiering companies were defaulted to 'warehouse' by the migration (they
  // already had full access — nothing may be taken away). NULL is treated as
  // fully unlocked by computeFeatures for the same reason.
  @Column({ type: 'varchar', length: 20, nullable: true, name: 'company_type' })
  companyType!: string | null;

  // Large-organization per-company inventory toggle (basic stock + COGS only).
  // Ignored for the other types: small_business is always off, warehouse
  // always on.
  @Column({ type: 'boolean', default: false, name: 'inventory_enabled' })
  inventoryEnabled!: boolean;

  // KILL SWITCH (FinMatrix.md SAFETY §4): checked FIRST in computeFeatures —
  // when true every feature gate passes regardless of type/plan. Flippable by
  // a super-admin endpoint or a one-line DB update; no deploy needed.
  @Column({ type: 'boolean', default: false, name: 'all_features_unlocked' })
  allFeaturesUnlocked!: boolean;

  // Chosen plan. Legacy keys free | standard | pro (pre-tiering) plus the six
  // tier plans (small_business|large_org|warehouse × 3mo|6mo) — see
  // billing/plan-config.ts, the single source of truth.
  @Column({ type: 'varchar', length: 32, default: 'free', name: 'subscription_plan' })
  subscriptionPlan!: string;

  // ── Subscription lifecycle (phase2.md) ────────────────────────────────────
  // subscriptionStatus is SEPARATE from `status` (the account status). It tracks
  // whether the plan is current: active | expiring | expired. Free stays active
  // with a null expiry. Expiry NEVER deletes data — it only flips the account to
  // inactive (login → renew-only) until renewed.
  @Column({ type: 'varchar', length: 16, default: 'active', name: 'subscription_status' })
  subscriptionStatus!: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'subscription_start_date' })
  subscriptionStartDate!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'subscription_expiry_date' })
  subscriptionExpiryDate!: Date | null;

  // none | submitted | paid | rejected
  @Column({ type: 'varchar', length: 16, default: 'none', name: 'payment_status' })
  paymentStatus!: string;

  @Column({ type: 'uuid', nullable: true, name: 'last_submission_id' })
  lastSubmissionId!: string | null;

  // The date of the most recent expiry-reminder notification, used to guarantee
  // at most ONE reminder per day (cron idempotency).
  @Column({ type: 'date', nullable: true, name: 'subscription_reminder_on' })
  subscriptionReminderOn!: string | null;

  // GST/Sales-tax registered: when true, input tax on bills is posted to a
  // recoverable asset (Sales Tax Recoverable 1300) instead of being rolled into
  // the expense/inventory line, so remittance = output tax − input tax
  // (FinMatrix.md §21).
  @Column({ type: 'boolean', default: false, name: 'sales_tax_registered' })
  salesTaxRegistered!: boolean;

  // Period lock: postings dated on/before this are rejected (FinMatrixGuide §6.4).
  @Column({ type: 'date', nullable: true, name: 'books_locked_until' })
  booksLockedUntil!: string | null;

  @OneToMany(() => UserCompany, (uc) => uc.company)
  memberships!: UserCompany[];
}
