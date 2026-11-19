import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { AccountType } from '../../../types';
import type { SystemRole } from '../accounts.constants';

@Entity('accounts')
@Index(['companyId', 'accountNumber'], { unique: true })
@Index(['companyId', 'type'])
@Index(['companyId', 'isActive'])
// One account per role per company (see accounts.constants SYS).
@Index('UQ_accounts_company_system_role', ['companyId', 'systemRole'], {
  unique: true,
  where: '"system_role" IS NOT NULL',
})
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

  /**
   * What automatic posting uses this account for (Receivables, Inventory,
   * Sales Tax Payable…), or null for an ordinary account. Fixed for the
   * account's life; its number and name may change.
   */
  @Column({ type: 'varchar', length: 40, nullable: true, name: 'system_role' })
  systemRole!: SystemRole | null;
}
