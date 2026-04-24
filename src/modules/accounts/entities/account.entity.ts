import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { AccountType } from '../../../types';

@Entity('accounts')
@Index(['companyId', 'accountNumber'], { unique: true })
@Index(['companyId', 'type'])
@Index(['companyId', 'isActive'])
export class Account extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 20, name: 'account_number' })
  accountNumber!: string;

  @Column({ type: 'varchar', length: 150 })
  name!: string;

  @Column({ type: 'varchar', length: 20 })
  type!: AccountType;

  @Column({ type: 'varchar', length: 64, name: 'sub_type' })
  subType!: string;

  @Column({ type: 'uuid', nullable: true, name: 'parent_id' })
  parentId!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'opening_balance',
  })
  openingBalance!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;
}
