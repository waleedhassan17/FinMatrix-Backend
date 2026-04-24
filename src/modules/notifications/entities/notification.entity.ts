import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

@Entity('notifications')
@Index(['companyId', 'userId', 'isRead'])
@Index(['companyId', 'createdAt'])
export class Notification extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false, name: 'is_read' })
  isRead!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'read_at' })
  readAt!: Date | null;
}
