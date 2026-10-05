import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager, ObjectLiteral } from 'typeorm';

/**
 * Customer and vendor IDs — C-0001, V-0001 — the way Peachtree's Customer ID
 * and Vendor ID work: a short code people search by, print and quote, beside
 * the UUID the database keys on.
 *
 * The number comes from the same `document_sequences` table as invoice numbers
 * (sequence.util.ts), under doc_type CUST / VEND and year 0 — a party series
 * never restarts with the year. The UPDATE holds a row lock until the creating
 * transaction commits, so two people adding a customer at once queue rather
 * than collide. A code typed by hand is allowed anywhere in the series; the
 * counter steps over any number already taken that way.
 */
export type PartyKind = 'customer' | 'vendor';

interface PartySeries {
  docType: string;
  prefix: string;
  table: string;
  nameColumn: string;
  label: string;
  errorCode: string;
}

const SERIES: Record<PartyKind, PartySeries> = {
  customer: {
    docType: 'CUST',
    prefix: 'C',
    table: 'customers',
    nameColumn: 'name',
    label: 'Customer',
    errorCode: 'CUSTOMER_CODE',
  },
  vendor: {
    docType: 'VEND',
    prefix: 'V',
    table: 'vendors',
    nameColumn: 'company_name',
    label: 'Vendor',
    errorCode: 'VENDOR_CODE',
  },
};

/** Letters, digits and . _ / - — starting with a letter or digit, at most 20. */
export const PARTY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;

/**
 * Trimmed and upper-cased, so `c-0007` and `C-0007` are one ID. Empty means
 * "assign the next one".
 */
export function normalizePartyCode(
  raw: string | null | undefined,
): string | null {
  const code = String(raw ?? '')
    .trim()
    .toUpperCase();
  return code ? code : null;
}

/** Refuses a code the pattern does not allow, with a message a person can act on. */
export function assertValidPartyCode(kind: PartyKind, code: string): void {
  if (PARTY_CODE_PATTERN.test(code)) return;
  const { label, errorCode } = SERIES[kind];
  throw new BadRequestException({
    code: `INVALID_${errorCode}`,
    message: `${label} ID can use letters, numbers and . _ / - (no spaces), up to 20 characters.`,
  });
}

/** `C-0007` — four digits until the series outgrows them. */
export function formatPartyCode(kind: PartyKind, n: number): string {
  return `${SERIES[kind].prefix}-${String(n).padStart(4, '0')}`;
}

/** TypeORM hands back `[rows, rowCount]` for UPDATE … RETURNING on Postgres. */
function returnedRows(raw: unknown): ObjectLiteral[] {
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    Array.isArray(raw[0]) &&
    typeof raw[1] === 'number'
  ) {
    return raw[0] as ObjectLiteral[];
  }
  return (raw as ObjectLiteral[]) ?? [];
}

/** The highest number this company has issued in its own series, e.g. 41 for C-0041. */
function highestIssuedSql(kind: PartyKind): string {
  const { table } = SERIES[kind];
  return `SELECT MAX(CAST(substring(code FROM '[0-9]+$') AS integer))
            FROM ${table}
           WHERE company_id = $1 AND code ~ $2`;
}

/** Matches the generated shape only, capped at 9 digits so the cast cannot overflow. */
const seriesPattern = (kind: PartyKind) =>
  `^${SERIES[kind].prefix}-[0-9]{1,9}$`;

async function bump(
  manager: EntityManager,
  companyId: string,
  kind: PartyKind,
): Promise<number> {
  const { docType } = SERIES[kind];
  const bumped = returnedRows(
    await manager.query(
      `UPDATE document_sequences
          SET last_value = last_value + 1, updated_at = now()
        WHERE company_id = $1 AND doc_type = $2 AND year = 0
      RETURNING last_value`,
      [companyId, docType],
    ),
  );
  if (bumped.length > 0) return Number(bumped[0].last_value);

  // First party of this kind since the series existed: seed from the highest
  // code already in use. ON CONFLICT covers two first creates racing.
  const seeded = await manager.query<ObjectLiteral[]>(
    `INSERT INTO document_sequences (company_id, doc_type, year, last_value, updated_at)
     VALUES ($1, $3, 0, COALESCE((${highestIssuedSql(kind)}), 0) + 1, now())
     ON CONFLICT (company_id, doc_type, year)
       DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
     RETURNING last_value`,
    [companyId, seriesPattern(kind), docType],
  );
  return Number(returnedRows(seeded)[0].last_value);
}

async function codeTaken(
  manager: EntityManager,
  companyId: string,
  kind: PartyKind,
  code: string,
): Promise<boolean> {
  const rows = await manager.query<ObjectLiteral[]>(
    `SELECT 1 FROM ${SERIES[kind].table} WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, code],
  );
  return rows.length > 0;
}

/**
 * The next free code in the series. Must run inside the creating transaction,
 * which is what keeps the number until the party is saved.
 */
export async function nextPartyCode(
  manager: EntityManager,
  companyId: string,
  kind: PartyKind,
): Promise<string> {
  // A hand-typed C-0050 is skipped when the counter reaches 50. The bound only
  // guards against a runaway loop; a real company never comes near it.
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const code = formatPartyCode(kind, await bump(manager, companyId, kind));
    if (!(await codeTaken(manager, companyId, kind, code))) return code;
  }
  throw new ConflictException({
    code: `${SERIES[kind].errorCode}_EXHAUSTED`,
    message: `Could not find a free ${SERIES[kind].label.toLowerCase()} ID. Type one in instead.`,
  });
}

/**
 * What the next create would most likely be given, for a form's placeholder.
 * Reads without taking a number, so it is a suggestion, not a reservation:
 * someone else may save first.
 */
export async function peekNextPartyCode(
  manager: EntityManager,
  companyId: string,
  kind: PartyKind,
): Promise<string> {
  const rows = await manager.query<ObjectLiteral[]>(
    `SELECT COALESCE(
              (SELECT last_value FROM document_sequences
                WHERE company_id = $1 AND doc_type = $3 AND year = 0),
              (${highestIssuedSql(kind)}),
              0) AS last`,
    [companyId, seriesPattern(kind), SERIES[kind].docType],
  );
  let n = Number(rows[0]?.last ?? 0) + 1;
  for (let attempt = 0; attempt < 10_000; attempt++, n++) {
    const code = formatPartyCode(kind, n);
    if (!(await codeTaken(manager, companyId, kind, code))) return code;
  }
  return formatPartyCode(kind, n);
}

/** The party already holding `code`, other than `exceptId`. */
export async function partyCodeHolder(
  manager: EntityManager,
  companyId: string,
  kind: PartyKind,
  code: string,
  exceptId?: string,
): Promise<{ id: string; name: string } | null> {
  const { table, nameColumn } = SERIES[kind];
  const rows = await manager.query<ObjectLiteral[]>(
    `SELECT id, ${nameColumn} AS name FROM ${table}
      WHERE company_id = $1 AND code = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [companyId, code, exceptId ?? null],
  );
  return rows[0]
    ? { id: String(rows[0].id), name: String(rows[0].name ?? '') }
    : null;
}

/** The error for a taken code, naming who has it so the person can choose another. */
export function partyCodeTaken(
  kind: PartyKind,
  code: string,
  holder: { id: string; name: string } | null,
): ConflictException {
  const { label, errorCode } = SERIES[kind];
  return new ConflictException({
    code: `${errorCode}_TAKEN`,
    message: holder?.name
      ? `${code} is already the ${label.toLowerCase()} ID of ${holder.name}. Choose another ID.`
      : `${code} is already in use. Choose another ${label.toLowerCase()} ID.`,
    holder,
  });
}

/** Refuses a code another party of this company already uses. */
export async function assertPartyCodeFree(
  manager: EntityManager,
  companyId: string,
  kind: PartyKind,
  code: string,
  exceptId?: string,
): Promise<void> {
  const holder = await partyCodeHolder(
    manager,
    companyId,
    kind,
    code,
    exceptId,
  );
  if (holder) throw partyCodeTaken(kind, code, holder);
}

/** Postgres unique violation, as TypeORM surfaces it. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === '23505' || e?.driverError?.code === '23505';
}
