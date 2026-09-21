import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Invoice } from './invoice.entity';

@Entity('invoice_line_items')
@Index(['invoiceId'])
export class InvoiceLineItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'invoice_id' })
  invoiceId!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 1 })
  quantity!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'unit_price' })
  unitPrice!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0, name: 'tax_rate' })
  taxRate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'line_total' })
  lineTotal!: string;

  @Column({ type: 'uuid', nullable: true, name: 'account_id' })
  accountId!: string | null;

  // Optional link to an inventory item. When set, posting the invoice records a
  // COGS/Inventory cost entry and reduces quantity on hand (FinMatrixGuide §3.1).
  @Column({ type: 'uuid', nullable: true, name: 'item_id' })
  itemId!: string | null;

  // ── Cost of this line, frozen at posting ────────────────────────────────
  //
  // `select: false` on BOTH, and that is not a style choice.
  //
  // There is no ClassSerializerInterceptor and no @Exclude() anywhere in this
  // codebase, and six read paths in InvoicesService load `relations: { lines:
  // true }` and hand the entity straight out — the same object
  // InvoicePdfService renders from. A plain column here would publish the
  // company's cost of goods on every invoice response, and possibly on the
  // customer's own PDF. Excluded by default, the failure mode of forgetting an
  // addSelect is `undefined`, which is loud; the failure mode of the
  // alternative is a silent leak.
  //
  // Read them with an explicit .addSelect() — postInvoiceCogs and the margin
  // report do exactly that.

  /**
   * Weighted-average cost per unit at the moment the stock left the shelf.
   *
   * The rate, not the amount, because returns are partial: a credit memo for 3
   * of the 10 units sold needs the original per-unit cost, which `cost_amount`
   * cannot give without re-dividing by a quantity that may since have changed.
   *
   * This is the same pattern `delivery_items.unit_cost` and
   * `credit_memo_lines.restock_unit_cost` already use, and for the same reason:
   * the item's running average drifts, so a cost read back later is not the
   * cost that was posted.
   */
  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    nullable: true,
    select: false,
    name: 'unit_cost',
  })
  unitCost!: string | null;

  /**
   * What this line contributed to the invoice's COGS posting.
   *
   * Authoritative — invariant I22 ties the sum of these to the invoice's own
   * GL 5000 debit, so any rounding residue from apportionment lives here rather
   * than in `unit_cost`.
   *
   * NULL means no cost is recorded for this line; `cost_basis` says why.
   */
  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    nullable: true,
    select: false,
    name: 'cost_amount',
  })
  costAmount!: string | null;

  /**
   * How `cost_amount` was arrived at.
   *
   * `posted` — written when the invoice was posted. `exact` — backfilled and
   * provably what was posted (a single-item invoice, or a known zero).
   * `apportioned` — backfilled; the invoice total is exact, the split between
   * items on it is an estimate. `delivery` — the cost lives on
   * `delivery_items`, not here. `none` — a service line, zero by nature.
   * `unknown` — nothing recoverable. NULL — a draft, not yet posted, which is a
   * third thing from zero and from unknown.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, select: false, name: 'cost_basis' })
  costBasis!: string | null;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => Invoice, (i) => i.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoice_id' })
  invoice!: Invoice;
}
