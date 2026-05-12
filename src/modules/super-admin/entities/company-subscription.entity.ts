import { Column, Entity, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';
import { SubscriptionPlan } from './subscription-plan.entity';

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'trial';

@Entity('company_subscriptions')
export class CompanySubscription extends BaseEntity {
  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'uuid', name: 'plan_id' })
  planId!: string;

  @ManyToOne(() => SubscriptionPlan, { eager: true, nullable: true })
  @JoinColumn({ name: 'plan_id' })
  plan!: SubscriptionPlan | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: SubscriptionStatus;

  @Column({ type: 'date', name: 'start_date' })
  startDate!: string;

  @Column({ type: 'date', name: 'end_date', nullable: true })
  endDate!: string | null;

  @Column({ type: 'text', name: 'notes', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', name: 'assigned_by' })
  assignedBy!: string;
}
