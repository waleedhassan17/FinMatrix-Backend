import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 1 of 3: the columns that let inventory value and gross margin be
 * reported per item. Metadata only — nothing is written and nothing is
 * enforced yet.
 *
 * ── Why these columns ──────────────────────────────────────────────────────
 *
 * `inventory_movements.value_change` — the signed change to the item's carrying
 * value, in the same amount and sign the journal entry moves account 1200.
 * NOT a `unit_cost` column: under weighted average a receipt adds `landed` to
 * 1200 and THEN re-averages the pile, and `landed` capitalises tax when the
 * company is not sales-tax registered, so neither the pre- nor the
 * post-average rate reproduces the ledger. The value is the ledger movement.
 *
 * `invoice_line_items.unit_cost` / `.cost_amount` — what each line contributed
 * to the invoice's COGS posting. `postInvoiceCogs` already computes this per
 * line and throws it away, keeping only the sum; this is where it lands.
 * Both are `select: false` on the entity, because six read paths return invoice
 * lines to the client and one of them feeds the customer's PDF.
 *
 * `companies.inventory_cost_history_from` — the date from which the value
 * series can be trusted. Without somewhere to record "we do not know", the
 * reports will invent zeroes.
 *
 * ── Why nullable, and why no DEFAULT ───────────────────────────────────────
 *
 * NULL means "no value recorded"; 0.0000 means "the value was zero", which is
 * true of a location transfer. Those must stay distinguishable. A DEFAULT 0
 * would make every historical row look like a known zero and destroy the
 * confidence horizon before it has been measured.
 *
 * ── Deploy order ───────────────────────────────────────────────────────────
 *
 * This lands ALONE, before the code that writes these columns. The CHECK
 * constraint that makes omission impossible is a separate migration, which must
 * not ship in the same deploy as the write path: if one of the ~15 movement
 * call sites were missed, landing them together would turn every stock movement
 * in the system into a 500 — invoicing, receiving and deliveries all down at
 * once. Staged, a missed site degrades to a NULL that the constraint then
 * catches loudly, with only one deploy's data affected.
 *
 * Posts nothing. No journal entry, no general_ledger row, no accounts.balance
 * and no unit_cost is touched, so I5 and I13 are unaffected by construction.
 */
export class InventoryCostColumns1789910000000 implements MigrationInterface {
  name = 'InventoryCostColumns1789910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS throughout, so a re-run — or a dev database built by
    // synchronize — is a no-op rather than a failure.
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
        ADD COLUMN IF NOT EXISTS "value_change" numeric(18,4) NULL,
        ADD COLUMN IF NOT EXISTS "cost_basis"   varchar(16)   NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "invoice_line_items"
        ADD COLUMN IF NOT EXISTS "unit_cost"   numeric(18,4) NULL,
        ADD COLUMN IF NOT EXISTS "cost_amount" numeric(18,4) NULL,
        ADD COLUMN IF NOT EXISTS "cost_basis"  varchar(16)   NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "inventory_cost_history_from" date NULL
    `);

    // The margin report groups invoice lines by item within a period. Without
    // this it is a sequential scan of every line the company has ever issued.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_invoice_line_items_item"
        ON "invoice_line_items" ("item_id")
        WHERE "item_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversible: these columns are additive and nothing reads them until the
    // later migrations land. Dropping them takes the recorded costs with them,
    // which is the point of reversing.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoice_line_items_item"`);
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "inventory_cost_history_from"
    `);
    await queryRunner.query(`
      ALTER TABLE "invoice_line_items"
        DROP COLUMN IF EXISTS "unit_cost",
        DROP COLUMN IF EXISTS "cost_amount",
        DROP COLUMN IF EXISTS "cost_basis"
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
        DROP COLUMN IF EXISTS "value_change",
        DROP COLUMN IF EXISTS "cost_basis"
    `);
  }
}
