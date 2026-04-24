import {
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('company_settings')
export class CompanySettings {
  @PrimaryColumn({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 16, default: '01-01', name: 'fiscal_year_start' })
  fiscalYearStart!: string;

  @Column({ type: 'varchar', length: 8, default: 'PKR', name: 'default_currency' })
  defaultCurrency!: string;

  @Column({ type: 'varchar', length: 32, default: 'NTN', name: 'tax_id_label' })
  taxIdLabel!: string;

  @Column({ type: 'varchar', length: 16, default: 'INV', name: 'invoice_prefix' })
  invoicePrefix!: string;

  @Column({ type: 'int', default: 1, name: 'invoice_start_number' })
  invoiceStartNumber!: number;

  @Column({ type: 'varchar', length: 32, default: 'YYYY-MM-DD', name: 'date_format' })
  dateFormat!: string;

  @Column({ type: 'varchar', length: 64, default: 'Asia/Karachi' })
  timezone!: string;

  @Column({ type: 'jsonb', nullable: true })
  features!: Record<string, unknown> | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
