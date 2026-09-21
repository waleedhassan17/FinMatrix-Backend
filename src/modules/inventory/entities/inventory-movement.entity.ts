import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { InventoryMovementType } from '../../../types';

@Entity('inventory_movements')
@Index(['companyId', 'itemId', 'date'])
@Index(['companyId', 'date'])
export class InventoryMovement extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: InventoryMovementType;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'quantity_change',
  })
  quantityChange!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'balance_after',
  })
  balanceAfter!: string;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'source_type' })
  sourceType!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'source_id' })
  sourceId!: string | null;

  /**
   * Signed change to this item's carrying value, in the SAME amount and sign
   * the journal entry moves account 1200 (or 1250 at dispatch).
   *
   * **Not `quantity_change × unit_cost`, and there is deliberately no
   * `unit_cost` column here.** Under weighted average a receipt adds `landed`
   * to 1200 and *then* re-averages the whole pile, and `landed` includes
   * capitalised tax when the company is not sales-tax registered — so neither
   * the pre- nor the post-average unit cost reproduces the ledger movement. The
   * value IS the ledger movement, stored once; a display rate is
   * `value_change / quantity_change` at read time.
   *
   * NULL means no value was recorded — a row written before this column
   * existed, or by a path that has not been converted. `0.0000` means the
   * movement genuinely moved no value, which is true of a location transfer.
   * Those two must stay distinguishable, which is why there is no DEFAULT:
   * a default would make every historical row look like a known zero and
   * destroy the confidence horizon before it was measured.
   */
  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    nullable: true,
    name: 'value_change',
  })
  valueChange!: string | null;

  /**
   * How `value_change` was arrived at.
   *
   * `posted` — written by application code at the moment of posting; the only
   * value new rows carry. `exact` — backfilled and provably equal to what was
   * posted. `apportioned` — backfilled; the document total is exact, the split
   * across items is an estimate. `unknown` — nothing was recoverable.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'cost_basis' })
  costBasis!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy!: string | null;
}
