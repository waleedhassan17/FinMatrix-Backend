/**
 * The super-admin a suite signs in as: SUPER_EMAIL / SUPER_PASSWORD (or
 * SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD) when set, otherwise a throwaway
 * one created for the run in the suite's own database (DATABASE_URL /
 * PG_URL — a scratch copy, never production).
 *
 * These suites used to default to a real account with its password written
 * in the file. There are no credentials in test code any more.
 */
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { Client } = require('pg');

export async function superAdminCredentials(
  dbUrl?: string,
): Promise<{ email: string; password: string }> {
  const email = process.env.SUPER_EMAIL ?? process.env.SUPER_ADMIN_EMAIL;
  const password =
    process.env.SUPER_PASSWORD ?? process.env.SUPER_ADMIN_PASSWORD;
  if (email && password) return { email, password };
  const url = dbUrl || process.env.DATABASE_URL || process.env.PG_URL;
  if (!url) {
    throw new Error(
      'Set SUPER_EMAIL and SUPER_PASSWORD, or DATABASE_URL (a scratch database) so a throwaway super-admin can be created.',
    );
  }
  const made = {
    email: `qa_super_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}@example.com`,
    password: `Sa!${randomUUID()}`,
  };
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    await pg.query(
      `INSERT INTO users (email, password_hash, display_name, role, is_active, is_email_verified)
       VALUES ($1, $2, 'QA Super Admin', 'super_admin', true, true)`,
      [made.email, await bcrypt.hash(made.password, 10)],
    );
  } finally {
    await pg.end();
  }
  return made;
}
