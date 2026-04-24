import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DeliveryIssueType } from '../../../types';

@Entity('delivery_issues')
@Index(['deliveryId'])
export class DeliveryIssue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'delivery_id' })
  deliveryId!: string;

  @Column({ type: 'varchar', length: 32, name: 'issue_type' })
  issueType!: DeliveryIssueType;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  photos!: string[];

  @Column({ type: 'boolean', default: false })
  rescheduled!: boolean;

  @Column({ type: 'date', nullable: true, name: 'new_date' })
  newDate!: string | null;

  @Column({ type: 'timestamptz', name: 'reported_at' })
  reportedAt!: Date;

  @Column({ type: 'uuid', name: 'reported_by' })
  reportedBy!: string;
}
