import { Column, Entity, Unique } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { MigrationSourceSystem } from './migration-batch.entity';

export interface ProfileMappings {
  /** target sheet key → { normalised source header → target field } */
  columns: Record<string, Record<string, string>>;
  /** `field::normalised source value` → target value */
  values: Record<string, string>;
  /** source account number → FinMatrix account number */
  accounts: Record<string, string>;
}

/** Confirmed mappings, saved per company and source and reused next time. */
@Entity('migration_profiles')
@Unique('UQ_migration_profiles_company_source_name', [
  'companyId',
  'sourceSystem',
  'name',
])
export class MigrationProfile extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 32, name: 'source_system' })
  sourceSystem!: MigrationSourceSystem;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'jsonb' })
  mappings!: ProfileMappings;

  @Column({ type: 'int', default: 0, name: 'used_count' })
  usedCount!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_used_at' })
  lastUsedAt!: Date | null;
}
