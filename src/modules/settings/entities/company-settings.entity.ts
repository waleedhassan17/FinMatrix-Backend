import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('company_settings')
export class CompanySettings {
  @PrimaryColumn({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: '01-01',
    name: 'fiscal_year_start',
  })
  fiscalYearStart!: string;

  @Column({
    type: 'varchar',
    length: 8,
    default: 'PKR',
    name: 'default_currency',
  })
  defaultCurrency!: string;

  @Column({ type: 'varchar', length: 32, default: 'NTN', name: 'tax_id_label' })
  taxIdLabel!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'INV',
    name: 'invoice_prefix',
  })
  invoicePrefix!: string;

  @Column({ type: 'int', default: 1, name: 'invoice_start_number' })
  invoiceStartNumber!: number;

  @Column({
    type: 'varchar',
    length: 32,
    default: 'YYYY-MM-DD',
    name: 'date_format',
  })
  dateFormat!: string;

  @Column({ type: 'varchar', length: 64, default: 'Asia/Karachi' })
  timezone!: string;

  @Column({ type: 'jsonb', nullable: true })
  features!: Record<string, unknown> | null;

  /**
   * Per-company report defaults. Today: `{ aging: { preset, buckets } }`.
   *
   * jsonb rather than a column per preference, because these are presentation
   * choices with no referential meaning — nothing joins on them and no invariant
   * reads them. ReportsService resolves the aging entry itself (by raw query, to
   * avoid a module dependency) so that a saved default also governs the CSV
   * export and every other consumer, not just the screen that set it.
   */
  @Column({ type: 'jsonb', nullable: true, name: 'report_preferences' })
  reportPreferences!: Record<string, unknown> | null;

  /**
   * The end-of-day digest (reports/day-summary): off until the owner turns it
   * on; then at `daySummaryHour` company time an in-app notification goes to
   * every owner, and an email too when `daySummaryEmail`. `daySummaryLastSent`
   * is the last local day sent — the hourly job claims a day by moving it, so
   * a day is never sent twice.
   */
  @Column({ type: 'boolean', default: false, name: 'day_summary_enabled' })
  daySummaryEnabled!: boolean;

  @Column({ type: 'smallint', default: 21, name: 'day_summary_hour' })
  daySummaryHour!: number;

  @Column({ type: 'boolean', default: true, name: 'day_summary_email' })
  daySummaryEmail!: boolean;

  @Column({ type: 'date', nullable: true, name: 'day_summary_last_sent' })
  daySummaryLastSent!: string | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
