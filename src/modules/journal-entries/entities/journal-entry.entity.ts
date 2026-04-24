import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { JournalEntryStatus } from '../../../types';
import { JournalEntryLine } from './journal-entry-line.entity';

@Entity('journal_entries')
@Index(['companyId', 'reference'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'createdAt'])
export class JournalEntry extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 32 })
  reference!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'text', nullable: true })
  memo!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: JournalEntryStatus;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_debits' })
  totalDebits!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_credits' })
  totalCredits!: string;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true, name: 'posted_by' })
  postedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'posted_at' })
  postedAt!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'void_reason' })
  voidReason!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'reversal_of_id' })
  reversalOfId!: string | null;

  @OneToMany(() => JournalEntryLine, (l) => l.entry, { cascade: true })
  lines!: JournalEntryLine[];
}
