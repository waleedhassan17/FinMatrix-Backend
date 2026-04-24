import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { AgencyType } from '../../../types';

@Entity('agencies')
@Index(['companyId', 'createdAt'])
export class Agency extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: AgencyType;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  address!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  contact!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false, name: 'is_connected' })
  isConnected!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_sync_at' })
  lastSyncAt!: Date | null;
}
