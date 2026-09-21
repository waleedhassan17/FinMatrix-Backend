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
  // Always 'accrual' — the only basis reports.service.ts implements (G8).
  accountingMethod!: string | null;

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

  /**
   * The first date from which this company's per-item inventory VALUE can be
   * trusted. NULL means never — no movement carries a value yet.
   *
   * Value history is reconstructed by anchoring on today (quantity_on_hand ×
   * unit_cost, which invariant I13 already ties to GL 1200) and walking
   * BACKWARDS through inventory_movements.value_change. That is exact for every
   * date at or after this horizon and undefined before it, which is the honest
   * shape: the uncertainty is pushed to the old end of the series rather than
   * contaminating recent months with a made-up opening balance.
   *
   * Set by the cost backfill migration to the day after the last movement that
   * carries no value. Invariants I23 and I24 are scoped by it, so drift below
   * the horizon is expected and is not a defect to "correct" with a journal
   * entry.
   */
  @Column({
    type: 'date',
    nullable: true,
    name: 'inventory_cost_history_from',
  })
  inventoryCostHistoryFrom!: string | null;

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

  // ── Free trial (admin-approved, 30 days) ──────────────────────────────────
  // An APPROVED trial is an ordinary subscription: subscriptionPlan is the
  // trial plan key, subscriptionExpiryDate is the end of the trial, and
  // CompanyGuard / effectiveCompanyStatus / runExpiryScan treat it like any
  // other plan. These columns only record trial HISTORY — they are what tells
  // "never paid" apart from "paid".
  //
  //   currently trialing = isTrial && trialConvertedAt IS NULL && not expired
  //   ever trialed       = isTrial
  //
  // A REQUESTED trial is not a trial yet: requesting sets only
  // trialRequestedAt (plus paymentStatus='submitted', like a payment awaiting
  // review). Nothing below is set until a super-admin approves.

  // True from APPROVAL onward and NEVER reset — not on expiry, not after a
  // real payment converts the company. It is permanent trial history, and it
  // is what stops a company trialing twice.
  @Column({ type: 'boolean', default: false, name: 'is_trial' })
  isTrial!: boolean;

  // When the owner asked for the trial. Kept after a rejection; a new request
  // after a released rejection overwrites it.
  @Column({ type: 'timestamptz', nullable: true, name: 'trial_requested_at' })
  trialRequestedAt!: Date | null;

  // When the super-admin approved it. The 30 days run from HERE, not from the
  // request, so time spent waiting for review costs the owner nothing.
  @Column({ type: 'timestamptz', nullable: true, name: 'trial_started_at' })
  trialStartedAt!: Date | null;

  // When a real payment was approved for this company after its trial.
  @Column({ type: 'timestamptz', nullable: true, name: 'trial_converted_at' })
  trialConvertedAt!: Date | null;

  // The last trial-ending EMAIL milestone sent (7, 3 or 1 days left). In-app
  // reminders stay daily via subscriptionReminderOn; emails go out only when a
  // smaller milestone is crossed, so a missed cron run still sends the next one.
  @Column({ type: 'smallint', nullable: true, name: 'trial_reminder_milestone' })
  trialReminderMilestone!: number | null;

  // GST/Sales-tax registered: when true, input tax on bills is posted to a
  // recoverable asset (Sales Tax Recoverable 1300) instead of being rolled into
  // the expense/inventory line, so remittance = output tax − input tax
  // (FinMatrix.md §21).
  @Column({ type: 'boolean', default: false, name: 'sales_tax_registered' })
  salesTaxRegistered!: boolean;

  // Period lock: postings dated on/before this are rejected (FinMatrixGuide §6.4).
  @Column({ type: 'date', nullable: true, name: 'books_locked_until' })
  booksLockedUntil!: string | null;

  /**
   * When that lock was applied. Distinguishes an entry legitimately posted
   * before the close from one BACK-DATED into a shut period afterwards —
   * without it, invariant I12 flags every historical entry the moment a
   * period is closed (audit gap G4).
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'books_locked_at' })
  booksLockedAt!: Date | null;

  @OneToMany(() => UserCompany, (uc) => uc.company)
  memberships!: UserCompany[];
}
