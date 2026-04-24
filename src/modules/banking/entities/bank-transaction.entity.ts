import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { BankTransactionType } from '../../../types';

@Entity('bank_transactions')
@Index(['companyId', 'bankAccountId', 'date'])
@Index(['companyId', 'isCleared'])
export class BankTransaction extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'bank_account_id' })
  bankAccountId!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: BankTransactionType;

  @Column({ type: 'varchar', length: 200, nullable: true })
  payee!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'uuid', nullable: true, name: 'account_id' })
  accountId!: string | null;

  @Column({ type: 'text', nullable: true })
  memo!: string | null;

  @Column({ type: 'boolean', default: false, name: 'is_cleared' })
  isCleared!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'cleared_date' })
  clearedDate!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;
}
