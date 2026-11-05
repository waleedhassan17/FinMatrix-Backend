import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Sends per company, month ('YYYY-MM') and category (Meta's pricing category). */
@Entity('messaging_usage')
export class MessagingUsage {
  @PrimaryColumn({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @PrimaryColumn({ type: 'varchar', length: 7 })
  period!: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  category!: string;

  @Column({ type: 'integer', default: 0 })
  count!: number;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
