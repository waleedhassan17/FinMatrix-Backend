import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill bills.purchase_order_id for conversions made before the link
 * existed.
 *
 * BillPurchaseOrderLink stops a PO being billed twice, but only for POs
 * converted after it shipped. Every PO billed before that has no link, so it
 * still looks unbilled and can be converted again — which posts DR GRNI /
 * CR AP a second time, overstating payables and driving GRNI negative.
 *
 * The conversion left a deterministic memo, which is the only evidence
 * available:
 *   - `Created from PO <poNumber>`      written by the server's create-bill
 *   - `Converted from <poNumber>.`      written by the old client-side path
 *     (that path is gone, but the bills it made are still here)
 *
 * Matching is by EXACT memo rather than a substring: PO numbers are
 * zero-padded, so 'PO-2026-0004' is a substring of 'PO-2026-0040' and a LIKE
 * '%…%' would link the wrong order.
 *
 * bills.purchase_order_id is UNIQUE, so at most one bill per PO can be linked.
 * Where a PO was billed several times, the earliest bill wins and the
 * duplicates stay unlinked — deliberately: they are the ones to void, and
 * leaving them unlinked keeps them visible rather than silently blessing one.
 *
 * Idempotent: only fills NULLs, and skips any PO that already has a link.
 */
export class BackfillBillPurchaseOrderLink1783860000000 implements MigrationInterface {
  name = 'BackfillBillPurchaseOrderLink1783860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH matched AS (
        SELECT b.id  AS bill_id,
               po.id AS po_id,
               ROW_NUMBER() OVER (
                 PARTITION BY po.id ORDER BY b.created_at ASC, b.id ASC
               ) AS rn
          FROM bills b
          JOIN purchase_orders po
            ON po.company_id = b.company_id
           AND (
                 b.memo = 'Created from PO ' || po.po_number
              OR b.memo LIKE 'Converted from ' || po.po_number || '.%'
               )
         WHERE b.purchase_order_id IS NULL
           AND b.memo IS NOT NULL
           AND NOT EXISTS (
                 SELECT 1 FROM bills linked
                  WHERE linked.purchase_order_id = po.id
               )
      )
      UPDATE bills
         SET purchase_order_id = matched.po_id
        FROM matched
       WHERE bills.id = matched.bill_id
         AND matched.rn = 1
    `);
  }

  public async down(): Promise<void> {
    // Not reversed: the column is nullable and clearing it would re-open the
    // double-billing hole this exists to close. Dropping the column (the
    // BillPurchaseOrderLink down migration) removes these values with it.
  }
}
