import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer and vendor IDs, and the index a party's history reads by.
 *
 * 1. customers.code / vendors.code — the short ID people search, print and
 *    quote (C-0001, V-0001), as Peachtree's Customer ID and Vendor ID. Existing
 *    parties are numbered per company in the order they were created, after
 *    any code already in that shape, so a second run numbers only what is
 *    still blank. Unique per company; NULL stays possible for a row inserted
 *    outside TypeORM, which Postgres's unique index allows.
 *
 *    The series lives in document_sequences under doc_type CUST / VEND and
 *    year 0 (common/utils/party-code.util.ts). It is seeded here with the
 *    highest number issued; GREATEST keeps a series that is already ahead.
 *
 *    The padding is written out with a CASE, not lpad(): lpad() truncates a
 *    longer string, which would turn the 10,000th customer into C-1000.
 *
 * 2. audit_trail(company_id, resource_type, resource_id) — a customer's or
 *    vendor's History reads its own rows, and the party ledger traces a
 *    deleted receipt or bill back to its party through its delete row. Both
 *    filter on exactly these columns, which had no index.
 *
 * The entities declare the columns and indexes too: environments running with
 * DB_SYNCHRONIZE=true drop whatever the entities do not.
 */
export class PartyCodesLedgerHistory1790000000000 implements MigrationInterface {
  name = 'PartyCodesLedgerHistory1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, prefix, docType } of PARTIES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "code" varchar(20) NULL`,
      );

      await queryRunner.query(`
        WITH numbered AS (
          SELECT p.id, p.company_id,
                 ROW_NUMBER() OVER (PARTITION BY p.company_id ORDER BY p.created_at, p.id) AS rn
            FROM "${table}" p
           WHERE p.code IS NULL
        ), highest AS (
          SELECT company_id,
                 COALESCE(MAX(CAST(substring(code FROM '[0-9]+$') AS integer))
                            FILTER (WHERE code ~ '^${prefix}-[0-9]{1,9}$'), 0) AS n
            FROM "${table}"
           GROUP BY company_id
        )
        UPDATE "${table}" p
           SET code = '${prefix}-' || CASE
                 WHEN length((t.n + x.rn)::text) < 4 THEN lpad((t.n + x.rn)::text, 4, '0')
                 ELSE (t.n + x.rn)::text
               END
          FROM numbered x
          JOIN highest t ON t.company_id = x.company_id
         WHERE p.id = x.id
      `);

      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_${table}_company_code" ON "${table}" ("company_id", "code")`,
      );

      await queryRunner.query(`
        INSERT INTO document_sequences (company_id, doc_type, year, last_value, updated_at)
        SELECT company_id, '${docType}', 0, MAX(CAST(substring(code FROM '[0-9]+$') AS integer)), now()
          FROM "${table}"
         WHERE code ~ '^${prefix}-[0-9]{1,9}$'
         GROUP BY company_id
        ON CONFLICT (company_id, doc_type, year)
          DO UPDATE SET last_value = GREATEST(document_sequences.last_value, EXCLUDED.last_value),
                        updated_at = now()
      `);
    }

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_trail_company_resource"
        ON "audit_trail" ("company_id", "resource_type", "resource_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_audit_trail_company_resource"`,
    );
    for (const { table, docType } of PARTIES) {
      await queryRunner.query(
        `DELETE FROM document_sequences WHERE doc_type = '${docType}' AND year = 0`,
      );
      await queryRunner.query(
        `DROP INDEX IF EXISTS "UQ_${table}_company_code"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "code"`,
      );
    }
  }
}

const PARTIES = [
  { table: 'customers', prefix: 'C', docType: 'CUST' },
  { table: 'vendors', prefix: 'V', docType: 'VEND' },
] as const;
