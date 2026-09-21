import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';

import { InventoryMovement } from '../../modules/inventory/entities/inventory-movement.entity';
import { InventoryItem } from '../../modules/inventory/entities/inventory-item.entity';
import { InventoryMovementType } from '../../types';
import { toDecimal } from './money.util';

/**
 * The one way to record a stock movement.
 *
 * Fifteen call sites across eight modules used to build these rows by hand, and
 * every one of them recorded a quantity and no value. That was fine while the
 * only question was "how much is on the shelf"; it is not fine now that the
 * reports answer "what was this item worth in March", because that answer is a
 * RUNNING SUM and a running sum is only as good as its weakest link. One writer
 * that forgets a value, and `SUM(value_change)` silently stops equalling GL
 * 1200 — a plausible wrong number that nobody finds for six months.
 *
 * So there is one function, every site goes through it, `valueChange` is a
 * required argument with no default, and a CHECK constraint on the column
 * refuses a NULL from any path that is added later. Between them, omitting the
 * value stops being something to remember and becomes something the database
 * will not accept.
 *
 * A free function rather than an injectable service, deliberately: six modules
 * already import the entity directly, and a provider would mean adding one to
 * eight modules and inviting an inventory ↔ deliveries ↔ invoices cycle. This
 * matches how `assertSufficientStock` and the money helpers are already used.
 */
export interface RecordMovementInput {
  companyId: string;
  itemId: string;
  /**
   * The SAME date string the journal entry uses.
   *
   * Two independent `new Date()` calls straddling midnight is a bug this
   * codebase has fixed once already — pass the posting date through rather
   * than re-deriving it here.
   */
  date: string;
  type: InventoryMovementType;
  /** Signed: negative is stock leaving. */
  quantityChange: Decimal | string;
  balanceAfter: Decimal | string;

  /**
   * Signed change to this item's carrying value, in the SAME amount and the
   * SAME sign the journal entry moves account 1200 (or 1250 at dispatch).
   *
   * **Not `quantityChange × the item's average.**` A receipt adds `landed` —
   * the purchase-order line's cost plus capitalised tax — and only THEN
   * re-averages, so the two differ by exactly the re-averaging. Passing the
   * product here is the single most likely way to make `SUM(value_change)` part
   * company with GL 1200, and it is invisible until an invariant catches it.
   * At that site, pass `landed`.
   *
   * Pass `'0'` for a movement that truly moves no value: a location transfer,
   * or an approval undo that only restores quantity. That is a KNOWN zero and
   * is a different statement from NULL, which means nothing was recorded.
   */
  valueChange: Decimal | string;

  reference?: string | null;
  description?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  createdBy?: string | null;
}

const money = (v: Decimal | string): string =>
  (v instanceof Decimal ? v : toDecimal(v)).toFixed(4);

export async function recordInventoryMovement(
  manager: EntityManager,
  input: RecordMovementInput,
): Promise<InventoryMovement> {
  const repo = manager.getRepository(InventoryMovement);
  return repo.save(
    repo.create({
      companyId: input.companyId,
      itemId: input.itemId,
      date: input.date,
      type: input.type,
      quantityChange: money(input.quantityChange),
      balanceAfter: money(input.balanceAfter),
      valueChange: money(input.valueChange),
      // Application code only ever writes 'posted'. The backfill migration
      // writes 'exact' / 'apportioned' / 'unknown' in raw SQL, so the
      // distinction between a recorded cost and a reconstructed one cannot be
      // forged from here.
      costBasis: 'posted',
      reference: input.reference ?? null,
      description: input.description ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      createdBy: input.createdBy ?? null,
    }),
  );
}

/**
 * The common case: stock leaving or returning at the item's current
 * weighted-average cost.
 *
 * Derives `valueChange` from `quantityChange × item.unitCost` so the caller
 * cannot get the sign wrong — the value follows the quantity.
 *
 * **Must not be used for a receipt.** A receipt changes the average it would be
 * multiplying by; see `recordInventoryMovement`'s note on `valueChange`.
 */
export async function recordMovementAtAverage(
  manager: EntityManager,
  item: Pick<InventoryItem, 'id' | 'companyId' | 'unitCost' | 'quantityOnHand'>,
  input: Omit<
    RecordMovementInput,
    'companyId' | 'itemId' | 'valueChange' | 'balanceAfter'
  > & {
    quantityChange: Decimal | string;
    /** Defaults to the item's current quantityOnHand, already updated. */
    balanceAfter?: Decimal | string;
  },
): Promise<InventoryMovement> {
  const qty =
    input.quantityChange instanceof Decimal
      ? input.quantityChange
      : toDecimal(input.quantityChange);
  return recordInventoryMovement(manager, {
    ...input,
    companyId: item.companyId,
    itemId: item.id,
    balanceAfter: input.balanceAfter ?? item.quantityOnHand,
    valueChange: qty.times(toDecimal(item.unitCost)),
  });
}
