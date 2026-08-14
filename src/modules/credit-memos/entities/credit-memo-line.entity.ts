import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CreditMemo } from './credit-memo.entity';

@Entity('credit_memo_lines')
@Index(['creditMemoId'])
export class CreditMemoLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'credit_memo_id' })
  creditMemoId!: string;

  // Optional link to an inventory item — when set, the returned quantity is
  // restocked and the cost is reversed out of COGS (FinMatrix.md §11).
  @Column({ type: 'uuid', name: 'item_id', nullable: true })
  itemId!: string | null;

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

  /**
   * G3: the unit cost this restock was actually valued at, frozen when the memo
   * was issued. Voiding re-reads THIS rather than the item's current
   * weighted-average, so the reversal exactly cancels the original entry even
   * if a purchase has re-averaged the item since. Mirrors how delivery lines
   * freeze unit_cost at dispatch. NULL on memos issued before this change.
   */
  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    nullable: true,
    name: 'restock_unit_cost',
  })
  restockUnitCost!: string | null;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => CreditMemo, (c) => c.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'credit_memo_id' })
  creditMemo!: CreditMemo;
}
