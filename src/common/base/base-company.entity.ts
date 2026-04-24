import { Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * Base class for every multi-tenant business entity.
 * Enforces a non-null companyId column at the entity level.
 * The composite (companyId, createdAt DESC) index should be added
 * on each concrete subclass via @Index decorators.
 */
export abstract class BaseCompanyEntity extends BaseEntity {
  @Index()
  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;
}
