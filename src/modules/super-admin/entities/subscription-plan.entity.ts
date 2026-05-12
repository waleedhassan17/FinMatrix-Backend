import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

@Entity('subscription_plans')
export class SubscriptionPlan extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  priceMonthly!: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  priceYearly!: string;

  @Column({ type: 'int', default: 5 })
  maxUsers!: number;

  @Column({ type: 'int', nullable: true })
  maxInvoices!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  features!: string[] | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;
}
