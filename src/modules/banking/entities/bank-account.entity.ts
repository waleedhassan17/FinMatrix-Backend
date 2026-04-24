import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { BankAccountType } from '../../../types';

@Entity('bank_accounts')
@Index(['companyId', 'isActive'])
export class BankAccount extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'bank_name' })
  bankName!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true, name: 'account_number' })
  accountNumber!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'checking', name: 'account_type' })
  accountType!: BankAccountType;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'uuid', name: 'linked_account_id' })
  linkedAccountId!: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_reconciled' })
  lastReconciled!: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;
}
