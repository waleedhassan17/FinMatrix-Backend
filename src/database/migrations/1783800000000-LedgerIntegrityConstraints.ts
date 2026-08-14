import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G1 — Defence in depth for the ledger invariants (ACCOUNTING_QA_GUIDE §2).
 *
 * Until now every accounting rule was enforced only in application code
 * (PostingService). A raw query, a seed script or a future migration could
 * persist a broken ledger with nothing to stop it. This migration pushes the
 * rules that CAN live in the database down into it:
 *
 *   chk_line_shape        I4  — exactly one of debit/credit is positive
 *   chk_non_negative      I4  — neither side may be negative
 *   chk_invoice_math      I8  — total - amount_paid = balance
 *   chk_no_negative_stock I11 — stock may never go negative
 *   trg_*_balanced        I2  — every non-draft entry balances, checked at COMMIT
 *
 * Entry-level balance spans rows, so it cannot be a row CHECK. It is enforced
 * by two DEFERRABLE INITIALLY DEFERRED constraint triggers that run at COMMIT,
 * by which point PostingService has written the header AND its lines.
 *
 * Both triggers deliberately SKIP drafts: PostingService validates line shape
 * for every status but asserts balance only when posting, so an unbalanced
 * draft is a supported working state. A blanket trigger would break drafts.
 *
 * These are ADDITIVE. The application-level checks stay exactly as they are —
 * they give users a clean 400; these constraints are the backstop that no code
 * path can bypass.
 *
 * Idempotent: ADD CONSTRAINT has no IF NOT EXISTS, so each is wrapped in a DO
 * block that swallows duplicate_object; triggers are dropped before create.
 */
export class LedgerIntegrityConstraints1783800000000
  implements MigrationInterface
{
  name = 'LedgerIntegrityConstraints1783800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Row-level CHECK constraints ──────────────────────────────────
    // Mirrored as @Check() on the entities so TypeORM's synchronize (on in
    // local dev) does not drop them.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "journal_entry_lines"
          ADD CONSTRAINT "chk_line_shape"
          CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "journal_entry_lines"
          ADD CONSTRAINT "chk_non_negative"
          CHECK (debit >= 0 AND credit >= 0);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "invoices"
          ADD CONSTRAINT "chk_invoice_math"
          CHECK (total - amount_paid = balance);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "inventory_items"
          ADD CONSTRAINT "chk_no_negative_stock"
          CHECK (quantity_on_hand >= 0);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // ── Entry-level balance (deferred to COMMIT) ─────────────────────
    // One function serves both triggers; TG_TABLE_NAME tells it where to find
    // the entry id. Returns NULL early when the entry is gone (a cascaded
    // DELETE fires the lines trigger after the header has been removed) or
    // when the entry is still a draft.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION finmatrix_assert_entry_balanced()
      RETURNS trigger AS $$
      DECLARE
        v_entry_id uuid;
        v_status   varchar;
        v_debits   numeric(18,4);
        v_credits  numeric(18,4);
      BEGIN
        IF TG_TABLE_NAME = 'journal_entry_lines' THEN
          v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);
        ELSE
          v_entry_id := COALESCE(NEW.id, OLD.id);
        END IF;

        SELECT status INTO v_status
          FROM journal_entries WHERE id = v_entry_id;

        -- Entry deleted in this transaction, or still a draft: nothing to prove.
        IF v_status IS NULL OR v_status = 'draft' THEN
          RETURN NULL;
        END IF;

        SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
          INTO v_debits, v_credits
          FROM journal_entry_lines WHERE entry_id = v_entry_id;

        IF v_debits <> v_credits THEN
          RAISE EXCEPTION
            'UNBALANCED_ENTRY: journal entry % has debits % but credits %',
            v_entry_id, v_debits, v_credits
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Lines changing: covers insert/update/delete of any line.
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_je_lines_balanced" ON "journal_entry_lines"`,
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER "trg_je_lines_balanced"
        AFTER INSERT OR UPDATE OR DELETE ON "journal_entry_lines"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION finmatrix_assert_entry_balanced();
    `);

    // Header changing: postDraft() flips status draft -> posted and touches no
    // line, so the trigger above would never fire for that transition.
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_je_header_balanced" ON "journal_entries"`,
    );
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER "trg_je_header_balanced"
        AFTER INSERT OR UPDATE OF status ON "journal_entries"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION finmatrix_assert_entry_balanced();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_je_header_balanced" ON "journal_entries"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_je_lines_balanced" ON "journal_entry_lines"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS finmatrix_assert_entry_balanced()`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" DROP CONSTRAINT IF EXISTS "chk_no_negative_stock"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "chk_invoice_math"`,
    );
    await queryRunner.query(
      `ALTER TABLE "journal_entry_lines" DROP CONSTRAINT IF EXISTS "chk_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "journal_entry_lines" DROP CONSTRAINT IF EXISTS "chk_line_shape"`,
    );
  }
}
