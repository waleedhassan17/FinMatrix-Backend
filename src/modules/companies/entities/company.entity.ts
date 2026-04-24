import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';
import { UserCompany } from './user-company.entity';

export interface CompanyAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

@Entity('companies')
export class Company extends BaseEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  industry!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  address!: CompanyAddress | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'tax_id' })
  taxId!: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 16, name: 'invite_code' })
  inviteCode!: string;

  @Column({ type: 'text', nullable: true })
  logo!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => UserCompany, (uc) => uc.company)
  memberships!: UserCompany[];
}
