import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Username logins for owner-created accounts, plus the credential vault.
 *
 * Staff and delivery riders do not sign themselves up. The owner (or, for
 * riders, a staff member) creates the account from User management / Delivery
 * personnel, and hands the username and password over in person. There is no
 * inbox to verify and no self-service reset: the creator is the custodian of
 * that password for the life of the account, and the screen that created it
 * shows it again whenever the holder forgets it.
 *
 * That last part is why `managed_credentials` exists. It is deliberately NOT a
 * column on `users`:
 *
 *   • `users` is read on every single authenticated request via JwtStrategy.
 *     A secret that most code paths must never see does not belong on the row
 *     that all of them load.
 *   • Its own table can be granted, audited, exported and purged separately.
 *
 * The secret is stored ENCRYPTED, never in clear text — AES-256-GCM under a
 * key held outside the database (CREDENTIAL_ENCRYPTION_KEY). A stolen dump, a
 * read replica or a SQL-injection foothold therefore yields ciphertext and
 * nothing else. The format is `v1:<iv>:<authTag>:<ciphertext>`, all base64,
 * version-prefixed so the scheme can be rotated without guessing at old rows.
 *
 * `password_hash` on `users` remains the ONLY thing authentication consults.
 * This table is a convenience copy for the custodian; it is never a login path.
 */
export class StaffUserCredentials1787240000000 implements MigrationInterface {
  name = 'StaffUserCredentials1787240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── users.username ──────────────────────────────────────────────────────
    // Nullable because every existing row signs in by email and must keep
    // working; Postgres permits many NULLs under a unique index, so the whole
    // back catalogue coexists with the constraint.
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "username" character varying(64)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_username"
        ON "users" ("username")
    `);
    // A username-only account has no address to store.
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL
    `);

    // ── managed_credentials ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "managed_credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "secret" text NOT NULL,
        "issued_by" uuid NOT NULL,
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_managed_credentials" PRIMARY KEY ("id")
      )
    `);
    // One live credential per account: re-issuing overwrites rather than
    // accumulating a history of old passwords nobody should still hold.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_managed_credentials_user"
        ON "managed_credentials" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_managed_credentials_company"
        ON "managed_credentials" ("company_id")
    `);
    // Deleting the account destroys its stored secret with it.
    await queryRunner.query(`
      ALTER TABLE "managed_credentials"
        ADD CONSTRAINT "FK_managed_credentials_user"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "managed_credentials"`);

    // Give username-only accounts a syntactically valid placeholder so the
    // NOT NULL below can be restored. Without this the revert fails on any
    // company that actually used the feature, leaving the schema half-migrated.
    await queryRunner.query(`
      UPDATE "users"
         SET "email" = "id" || '@username-only.invalid'
       WHERE "email" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_username"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "username"`,
    );
  }
}
