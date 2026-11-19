import { EntityManager } from 'typeorm';
import { SYSTEM_ACCOUNT_DEFS, SYSTEM_ROLES } from './accounts.constants';

/**
 * Charts written by a release from before system roles.
 *
 * Migration 1791100000000 gave every company's system accounts their role.
 * The release before it does not know the column, so a company it creates
 * after the migration ran — in the minutes while a deploy rolls out, or after
 * a rollback — gets a chart with no role at all, and automatic posting, which
 * finds Receivables, Cash and the rest by role, would find nothing. The same
 * release also adds a missing system account (Opening Balance Equity, GRNI,
 * Customer Advances…) the first time it needs one, again without its role.
 *
 * Both are healed by the rule the migration used, which is what automatic
 * posting itself did until roles existed: the account at a role's default
 * number IS that system account.
 * - A chart with no role at all: every account at a default number whose
 *   type agrees takes that role. Its name may have been edited; its number
 *   could not be, while numbers were how the system found it.
 * - A chart that has roles: only an account at the default number with the
 *   role's own type AND name (as the older release created it) takes a role
 *   no account holds. Anything else on that number is the owner's own account
 *   (a migrating owner's chart, say) and is never adopted on its number.
 *
 * One account per number per company, and one default number per role, so
 * no two accounts can compete for a role: concurrent heals of one company
 * wait on the same row, and the second finds it already holds its role.
 */
type Db = Pick<EntityManager, 'query'>;

const DEFS = SYSTEM_ROLES.map((role) => ({
  role,
  ...SYSTEM_ACCOUNT_DEFS[role],
}));
const ROLES = DEFS.map((d) => d.role);
const NUMBERS = DEFS.map((d) => d.defaultNumber);
const TYPES = DEFS.map((d) => d.type);
const NAMES = DEFS.map((d) => d.name);

/** Postgres UPDATE … RETURNING comes back from TypeORM as [rows, rowCount]. */
const returnedRows = (raw: unknown): unknown[] => {
  if (!Array.isArray(raw)) return [];
  return Array.isArray(raw[0]) ? (raw[0] as unknown[]) : raw;
};

/**
 * Heal the charts of the given companies, or of every company. Returns how
 * many accounts took a role; re-runnable, and a no-op on any chart this
 * release wrote.
 */
export async function healLegacyCharts(
  db: Db,
  companyIds?: string[],
): Promise<number> {
  if (companyIds && companyIds.length === 0) return 0;
  const ids = companyIds ?? null;
  const whole: unknown = await db.query(
    `WITH legacy AS (
       SELECT company_id FROM accounts
        WHERE $1::uuid[] IS NULL OR company_id = ANY($1::uuid[])
        GROUP BY company_id
       HAVING count(system_role) = 0
     ),
     defs AS (
       SELECT * FROM unnest($2::text[], $3::text[], $4::text[]) AS d(role, num, type)
     )
     UPDATE accounts a SET system_role = defs.role
       FROM legacy, defs
      WHERE a.company_id = legacy.company_id
        AND a.account_number = defs.num
        AND a.type = defs.type
        AND a.system_role IS NULL
     RETURNING a.id`,
    [ids, ROLES, NUMBERS, TYPES],
  );
  const single: unknown = await db.query(
    `WITH defs AS (
       SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS d(role, num, type, name)
     )
     UPDATE accounts a SET system_role = defs.role
       FROM defs
      WHERE ($1::uuid[] IS NULL OR a.company_id = ANY($1::uuid[]))
        AND a.account_number = defs.num
        AND a.type = defs.type
        AND lower(btrim(a.name)) = lower(defs.name)
        AND a.system_role IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM accounts b
           WHERE b.company_id = a.company_id AND b.system_role = defs.role
        )
     RETURNING a.id`,
    [ids, ROLES, NUMBERS, TYPES, NAMES],
  );
  return returnedRows(whole).length + returnedRows(single).length;
}
