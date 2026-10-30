import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index general_ledger on (company_id, reference).
 *
 * A posting is every ledger row sharing a reference (the journal-entry
 * number), and the cash-flow statement reads postings whole: it finds the
 * references that touched cash, then every row of those postings, to see what
 * the cash was exchanged for. Without this index that second step hashes the
 * company's entire ledger each time — on a migrated ledger of 1.25M rows it
 * was most of the statement's time (287 ms → 65 ms measured on a production
 * copy).
 *
 * Additive only. Built in about 3 seconds on a ledger of that size; writes
 * to general_ledger wait for it during the release phase, before the new
 * code starts serving.
 */
export class GeneralLedgerReferenceIndex1790400000000 implements MigrationInterface {
  name = 'GeneralLedgerReferenceIndex1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_general_ledger_company_reference"
         ON "general_ledger" ("company_id", "reference")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_general_ledger_company_reference"`,
    );
  }
}
