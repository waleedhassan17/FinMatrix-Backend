import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { JournalEntry } from './journal-entry.entity';

/**
 * G1: the CHECKs are declared here as well as in the
 * LedgerIntegrityConstraints migration, so TypeORM's synchronize (on in local
 * dev) recognises them as ours and does not drop them.
 *
 * Entry-level balance spans rows and so cannot be a row CHECK — it lives in a
 * deferred constraint trigger installed by that same migration.
 */
@Entity('journal_entry_lines')
@Index(['entryId', 'lineOrder'])
@Check('chk_line_shape', '(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)')
@Check('chk_non_negative', 'debit >= 0 AND credit >= 0')
export class JournalEntryLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'entry_id' })
  entryId!: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  debit!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  credit!: string;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => JournalEntry, (e) => e.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entry_id' })
  entry!: JournalEntry;
}
