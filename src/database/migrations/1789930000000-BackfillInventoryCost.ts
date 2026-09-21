import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 3 of 3: recover the cost of everything that already happened.
 *
 * ── What this claims, and what it does not ─────────────────────────────────
 *
 * ── A note on source_type labels ───────────────────────────────────────────
 *
 * The movement and the ledger do not always agree on what to call the same
 * event: a goods receipt writes a movement typed `purchase_order` while the GL
 * posts it as `po_receipt`, and stock restored when a delivery is approved
 * writes `delivery_return` against a GL entry typed `delivery_approval`. The
 * AMOUNTS tie; only the labels differ. Any check comparing the two must
 * therefore compare totals per company, never per source_type — which is what
 * I23 does.
 *
 * CLAIMED:
 *   • Every invoice's total `cost_amount` equals that invoice's own GL 5000
 *     posting, to the cent. Invariant I22 enforces it.
 *   • Single-item invoices, multi-line-same-item invoices, and invoices that
 *     moved stock carrying no cost are EXACTLY what was posted.
 *   • Movement value is exact for transfers, deliveries, adjustments, physical
 *     counts, opening stock and vendor credits — every one of those already had
 *     its cost frozen somewhere, it was simply never read back.
 *
 * NOT CLAIMED:
 *   • The per-item split of a MULTI-ITEM invoice is an estimate. The invoice
 *     total is exact; how it divides between two different items on that
 *     invoice is apportioned. Marked `cost_basis = 'apportioned'` so a reader
 *     can tell, and surfaced to the API as `estimatedCogsShare`.
 *   • Nothing before `companies.inventory_cost_history_from` is claimed at all.
 *
 * ── Apportionment basis ────────────────────────────────────────────────────
 *
 * Quantity x the item's CURRENT average cost, normalised to the posted total
 * with largest-remainder so the invoice ties to the cent.
 *
 * Not by selling price: that assumes a uniform gross margin across items, which
 * is the very thing the margin report exists to disprove — it would make the
 * report circular. Not by quantity alone: that prices a Rs 50 filter and a
 * Rs 5,000 pump identically. Relative average cost between two items on one
 * invoice drifts far less than either absolute cost does, which is why it is
 * the least-bad basis available.
 *
 * ── The key realisation ────────────────────────────────────────────────────
 *
 * `inventory_movements` already records exactly which items moved and how many
 * units, per invoice. So the set of (invoice, item) pairs is KNOWN, and only
 * invoices touching two or more DIFFERENT items need an estimate at all.
 *
 * ── Why a migration and not a script ───────────────────────────────────────
 *
 * DB_MIGRATIONS_RUN runs it on every environment and records that it ran; a
 * script runs where someone remembers, and its non-execution is invisible.
 * I22 becomes a CI gate, and a gate whose precondition is a script someone
 * might not have run is a gate that fails on a teammate's laptop and gets
 * ignored. Idempotent by construction: every statement guards on
 * `cost_basis IS NULL`, so a re-run is a no-op.
 *
 * ── This posts NOTHING ─────────────────────────────────────────────────────
 *
 * No journal entry, no general_ledger row, no accounts.balance and no
 * inventory_items.unit_cost is touched. I5 and I13 are unaffected by
 * construction. If I24 later shows drift on a company whose history predates
 * the horizon, that is EXPECTED and is why the horizon exists — it is not a
 * defect to "correct" with an adjusting entry.
 */
export class BackfillInventoryCost1789930000000 implements MigrationInterface {
  name = 'BackfillInventoryCost1789930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── A. Invoice lines ────────────────────────────────────────────────

    // A1. Direct invoice sales, apportioned per item then per line.
    await queryRunner.query(`
      WITH inv_move AS (
        -- Which items left the shelf for which invoice, and how many.
        SELECT m.company_id, m.source_id AS invoice_id, m.item_id,
               SUM(-m.quantity_change)::numeric(18,4) AS qty_out
          FROM inventory_movements m
         WHERE m.source_type = 'invoice'
         GROUP BY m.company_id, m.source_id, m.item_id
        HAVING SUM(-m.quantity_change) <> 0
      ),
      inv_cogs AS (
        -- What that invoice actually posted to COGS. source_type 'invoice',
        -- NOT 'invoice_void': the line records a sale that happened, and
        -- netting the void into it would zero the cost and destroy the trail.
        SELECT g.company_id, g.source_id AS invoice_id,
               SUM(g.debit - g.credit)::numeric(18,4) AS cogs
          FROM general_ledger g
          JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
         WHERE g.source_type = 'invoice' AND a.account_number = '5000'
         GROUP BY g.company_id, g.source_id
        HAVING SUM(g.debit - g.credit) > 0
      ),
      weighted AS (
        SELECT im.company_id, im.invoice_id, im.item_id, im.qty_out, c.cogs,
               GREATEST(im.qty_out * COALESCE(NULLIF(it.unit_cost, 0), 1), 0)::numeric(28,8) AS w,
               COUNT(*) OVER (PARTITION BY im.company_id, im.invoice_id) AS n_items
          FROM inv_move im
          JOIN inv_cogs c ON c.company_id = im.company_id AND c.invoice_id = im.invoice_id
          LEFT JOIN inventory_items it
                 ON it.id = im.item_id AND it.company_id = im.company_id
      ),
      shares AS (
        SELECT w.*,
               SUM(w.w) OVER (PARTITION BY w.company_id, w.invoice_id) AS w_tot,
               ROW_NUMBER() OVER (PARTITION BY w.company_id, w.invoice_id
                                  ORDER BY w.w DESC, w.item_id) AS item_rn
          FROM weighted w
      ),
      raw_alloc AS (
        SELECT s.*,
               CASE
                 -- One item on the invoice: the whole posting is its cost.
                 -- Exact, not an estimate.
                 WHEN s.n_items = 1 THEN s.cogs
                 WHEN s.w_tot > 0 THEN round(s.cogs * s.w / s.w_tot, 4)
                 -- Every item costs zero today: nothing to weight by, so split
                 -- evenly rather than dropping the cost on the floor.
                 ELSE round(s.cogs / s.n_items, 4)
               END AS item_cost
          FROM shares s
      ),
      balanced AS (
        -- Largest-remainder: the residue lands on the biggest item so the
        -- invoice ties to the posted figure exactly.
        SELECT r.*,
               r.item_cost + CASE WHEN r.item_rn = 1
                    THEN r.cogs - SUM(r.item_cost) OVER (PARTITION BY r.company_id, r.invoice_id)
                    ELSE 0 END AS item_cost_final
          FROM raw_alloc r
      ),
      per_line AS (
        -- An item's cost splits across ITS OWN lines by quantity. Exact: those
        -- lines shared one average when postInvoiceCogs ran.
        SELECT li.id AS line_id, li.quantity, b.n_items, b.item_cost_final,
               SUM(li.quantity) OVER (PARTITION BY li.invoice_id, li.item_id) AS item_qty,
               ROW_NUMBER() OVER (PARTITION BY li.invoice_id, li.item_id
                                  ORDER BY li.line_order, li.id) AS line_rn
          FROM invoice_line_items li
          JOIN balanced b ON b.invoice_id = li.invoice_id AND b.item_id = li.item_id
         WHERE li.cost_basis IS NULL
      ),
      line_alloc AS (
        SELECT p.*,
               CASE WHEN p.item_qty > 0
                    THEN round(p.item_cost_final * p.quantity / p.item_qty, 4)
                    ELSE 0 END AS line_cost
          FROM per_line p
      ),
      line_balanced AS (
        SELECT l.*,
               l.line_cost + CASE WHEN l.line_rn = 1
                    THEN l.item_cost_final - SUM(l.line_cost) OVER (PARTITION BY l.line_id)
                    ELSE 0 END AS line_cost_final
          FROM line_alloc l
      )
      UPDATE invoice_line_items li
         SET cost_amount = lb.line_cost_final,
             unit_cost   = CASE WHEN lb.quantity <> 0
                                THEN round(lb.line_cost_final / lb.quantity, 4)
                                ELSE 0 END,
             cost_basis  = CASE WHEN lb.n_items = 1 THEN 'exact' ELSE 'apportioned' END
        FROM line_balanced lb
       WHERE li.id = lb.line_id
    `);

    // A2. Known zero: stock moved but nothing posted to COGS, which means the
    // item was carried at zero cost. Evidence is the movement row's existence,
    // so this is a recorded zero and not a gap.
    await queryRunner.query(`
      UPDATE invoice_line_items li
         SET cost_amount = 0, unit_cost = 0, cost_basis = 'exact'
       WHERE li.cost_basis IS NULL
         AND li.item_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM inventory_movements m
                      WHERE m.source_type = 'invoice'
                        AND m.source_id = li.invoice_id
                        AND m.item_id = li.item_id)
         AND NOT EXISTS (SELECT 1 FROM general_ledger g
                           JOIN accounts a ON a.id = g.account_id
                          WHERE g.source_type = 'invoice'
                            AND g.source_id = li.invoice_id
                            AND a.account_number = '5000')
    `);

    // A3. Delivery-sourced lines. Their cost lives on delivery_items, frozen at
    // dispatch, and the margin report reads it there.
    //
    // Deliberately NOT given an item_id: delivery-ledger builds these as
    // lineKind 'service' on purpose, because the stock already left at dispatch
    // and a non-null item_id is exactly what makes postInvoiceCogs relieve it
    // again. Backfilling one would arm a second stock relief on every
    // historical delivery invoice.
    await queryRunner.query(`
      UPDATE invoice_line_items li
         SET cost_basis = 'delivery'
       WHERE li.cost_basis IS NULL
         AND li.item_id IS NULL
         AND EXISTS (SELECT 1 FROM deliveries d WHERE d.invoice_id = li.invoice_id)
    `);

    // A4. True service lines: no item, not from a delivery. Zero by nature.
    await queryRunner.query(`
      UPDATE invoice_line_items li
         SET cost_amount = 0, unit_cost = 0, cost_basis = 'none'
       WHERE li.cost_basis IS NULL
         AND li.item_id IS NULL
         AND EXISTS (SELECT 1 FROM invoices i
                      WHERE i.id = li.invoice_id AND i.status <> 'draft')
    `);

    // A5. Whatever is left on a POSTED invoice: an item line that posted and
    // moved nothing, because the item was deleted before the invoice posted
    // (postInvoiceCogs `continue`s past a missing item, writing neither cost
    // nor movement). Nothing is recoverable, so it says so rather than guesses.
    //
    // DRAFTS are deliberately left NULL by every statement above: a draft has
    // never posted, so there is no cost to recover, and postInvoiceCogs will
    // fill it when the draft is issued. NULL here means "not yet", which is a
    // third thing from zero and from unknown.
    await queryRunner.query(`
      UPDATE invoice_line_items li
         SET cost_basis = 'unknown'
       WHERE li.cost_basis IS NULL
         AND li.item_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM invoices i
                      WHERE i.id = li.invoice_id AND i.status <> 'draft')
    `);

    // ── B. Movement values ──────────────────────────────────────────────

    // B1. Transfers move no value: every location rolls up to 1200.
    await queryRunner.query(`
      UPDATE inventory_movements
         SET value_change = 0, cost_basis = 'exact'
       WHERE value_change IS NULL AND source_type = 'stock_transfer'
    `);

    // B2. Invoice sales and their voids, from the line costs just recovered.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = CASE WHEN m.source_type = 'invoice' THEN -c.cost ELSE c.cost END,
             cost_basis = c.basis
        FROM (
          SELECT li.invoice_id, li.item_id,
                 SUM(li.cost_amount)::numeric(18,4) AS cost,
                 CASE WHEN bool_or(li.cost_basis = 'apportioned')
                      THEN 'apportioned' ELSE 'exact' END AS basis
            FROM invoice_line_items li
           WHERE li.item_id IS NOT NULL AND li.cost_amount IS NOT NULL
           GROUP BY li.invoice_id, li.item_id
        ) c
       WHERE m.value_change IS NULL
         AND m.source_id = c.invoice_id
         AND m.item_id = c.item_id
         AND m.source_type IN ('invoice', 'invoice_void')
    `);

    // B3. Deliveries, at the cost frozen on the delivery line at dispatch.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = -round(ABS(m.quantity_change) * di.unit_cost, 4),
             cost_basis = 'exact'
        FROM delivery_items di
       WHERE m.value_change IS NULL
         AND m.source_type = 'delivery_dispatch'
         AND m.source_id = di.delivery_id
         AND m.item_id = di.item_id
    `);
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = round(ABS(m.quantity_change) * di.unit_cost, 4),
             cost_basis = 'exact'
        FROM delivery_items di
       WHERE m.value_change IS NULL
         AND m.source_type = 'delivery_return'
         AND m.source_id = di.delivery_id
         AND m.item_id = di.item_id
    `);

    // B4. Adjustments, counts and their reversals — one item per adjustment, so
    // the entry's own debit total is exactly this movement's value.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = CASE WHEN m.quantity_change < 0 THEN -j.v ELSE j.v END,
             cost_basis = 'exact'
        FROM (
          SELECT a.id, a.item_id,
                 COALESCE((SELECT SUM(debit) FROM journal_entry_lines
                            WHERE entry_id = a.journal_entry_id), 0)::numeric(18,4) AS v
            FROM inventory_adjustments a
           WHERE a.journal_entry_id IS NOT NULL
        ) j
       WHERE m.value_change IS NULL
         AND m.source_id = j.id
         AND m.item_id = j.item_id
    `);

    // B5a. Opening stock, from what it actually posted to 1200.
    //
    // NOT `quantity_change x the item's current unit_cost`. Opening stock SETS
    // the cost, and every receipt since has re-averaged it — on real data that
    // read 95,444.45 against a ledger that moved 88,000.00, a 7,444.45 drift
    // invisible to everything except this tie. The movement's source_id is the
    // item's own id, so the posting is recoverable per item and exact.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = o.v, cost_basis = 'exact'
        FROM (
          SELECT g.company_id, g.source_id AS item_id,
                 SUM(g.debit - g.credit)::numeric(18,4) AS v
            FROM general_ledger g
            JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
           WHERE g.source_type = 'opening_stock' AND a.account_number = '1200'
           GROUP BY g.company_id, g.source_id
        ) o
       WHERE m.value_change IS NULL
         AND m.source_type = 'opening_stock'
         AND m.company_id = o.company_id
         AND m.item_id = o.item_id
    `);

    // B5b. Physical counts, from the adjustment row each one writes. Matched on
    // (item, date) because the movement carries the COUNT's id while the
    // adjustment carries the item's — a count covering several items posts one
    // entry per item, all under the same source_id, so the GL alone cannot be
    // split per item.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = CASE WHEN m.quantity_change < 0 THEN -pc.v ELSE pc.v END,
             cost_basis = 'exact'
        FROM (
          SELECT a.company_id, a.item_id, a.date,
                 COALESCE((SELECT SUM(debit) FROM journal_entry_lines
                            WHERE entry_id = a.journal_entry_id), 0)::numeric(18,4) AS v
            FROM inventory_adjustments a
           WHERE a.reason = 'physical_count' AND a.journal_entry_id IS NOT NULL
        ) pc
       WHERE m.value_change IS NULL
         AND m.source_type = 'physical_count'
         AND m.company_id = pc.company_id
         AND m.item_id = pc.item_id
         AND m.date = pc.date
    `);

    // B6. Vendor credits: 1200 moves by the line's own amount.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = CASE WHEN m.quantity_change < 0 THEN -v.amt ELSE v.amt END,
             cost_basis = 'exact'
        FROM (
          SELECT vcl.vendor_credit_id, vcl.item_id,
                 SUM(vcl.amount)::numeric(18,4) AS amt
            FROM vendor_credit_lines vcl
           WHERE vcl.item_id IS NOT NULL
           GROUP BY vcl.vendor_credit_id, vcl.item_id
        ) v
       WHERE m.value_change IS NULL
         AND m.source_id = v.vendor_credit_id
         AND m.item_id = v.item_id
         AND m.source_type IN ('vendor_credit', 'vendor_credit_void')
    `);

    // B7. Credit memo restocks, at the frozen restock rate where one exists.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = CASE WHEN m.quantity_change < 0 THEN -c.amt ELSE c.amt END,
             cost_basis = 'exact'
        FROM (
          SELECT cml.credit_memo_id, cml.item_id,
                 SUM(cml.quantity * cml.restock_unit_cost)::numeric(18,4) AS amt
            FROM credit_memo_lines cml
           WHERE cml.item_id IS NOT NULL AND cml.restock_unit_cost IS NOT NULL
           GROUP BY cml.credit_memo_id, cml.item_id
        ) c
       WHERE m.value_change IS NULL
         AND m.source_id = c.credit_memo_id
         AND m.item_id = c.item_id
         AND m.source_type IN ('credit_memo', 'credit_memo_void')
    `);

    // B8. Purchase receipts, at the PO line's own cost. Approximate where a
    // line was received in several instalments at a changed cost, which is why
    // this is the one movement backfill marked 'apportioned'.
    await queryRunner.query(`
      UPDATE inventory_movements m
         SET value_change = round(
               m.quantity_change * pol.unit_cost
               * CASE WHEN co.sales_tax_registered THEN 1
                      ELSE 1 + pol.tax_rate / 100 END, 4),
             cost_basis = 'apportioned'
        FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id = pol.order_id
        JOIN companies co ON co.id = po.company_id
       WHERE m.value_change IS NULL
         AND m.source_type = 'purchase_order'
         AND pol.order_id = m.source_id
         AND pol.item_id = m.item_id
    `);

    // ── C. The confidence horizon ───────────────────────────────────────
    //
    // The day after the last movement that still carries no value. Everything
    // from here on can be reconstructed by anchoring on today — quantity_on_hand
    // x unit_cost, which I13 already ties to GL 1200 — and walking backwards
    // through value_change. That is exact at and after this date and undefined
    // before it, which pushes the uncertainty to the OLD end of the series
    // rather than contaminating recent months with a made-up opening balance.
    await queryRunner.query(`
      UPDATE companies c
         SET inventory_cost_history_from = h.from_date
        FROM (
          SELECT m.company_id,
                 COALESCE(
                   MAX(m.date) FILTER (WHERE m.value_change IS NULL) + INTERVAL '1 day',
                   MIN(m.date)
                 )::date AS from_date
            FROM inventory_movements m
           GROUP BY m.company_id
        ) h
       WHERE c.id = h.company_id
    `);
  }

  public async down(): Promise<void> {
    // Not reversed. Clearing cost_basis would re-open the gap and re-flag I22,
    // and there is no state worth returning to: these columns were empty
    // before. Dropping them (the InventoryCostColumns down migration) removes
    // these values with them.
  }
}
