import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreditMemo } from './credit-memo.entity';

@Entity('credit_memo_lines')
@Index(['creditMemoId'])
export class CreditMemoLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'credit_memo_id' })
  creditMemoId!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 1 })
  quantity!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'unit_price' })
  unitPrice!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0, name: 'tax_rate' })
  taxRate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'line_total' })
  lineTotal!: string;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => CreditMemo, (m) => m.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'credit_memo_id' })
  creditMemo!: CreditMemo;
}
