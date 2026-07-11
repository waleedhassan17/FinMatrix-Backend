import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Access-token denylist for sign-out (signout.md): stateless access JWTs get
 * a jti at issue time; POST /auth/logout stores that jti here so the auth
 * guard rejects the token immediately instead of waiting out its 15-minute
 * lifetime. Additive + idempotent.
 */
export class RevokedAccessTokens1783760000000 implements MigrationInterface {
  name = 'RevokedAccessTokens1783760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "revoked_access_tokens" (
        "jti" varchar(64) PRIMARY KEY,
        "user_id" uuid NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_revoked_access_tokens_user"
        ON "revoked_access_tokens" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_revoked_access_tokens_expires"
        ON "revoked_access_tokens" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "revoked_access_tokens"`);
  }
}
