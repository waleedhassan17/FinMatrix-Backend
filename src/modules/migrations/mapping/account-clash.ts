/**
 * Whether a source account and the FinMatrix account that already has its
 * number are the same account.
 *
 * Every system numbers its chart its own way: QuickBooks Desktop keeps
 * Accounts Receivable at 1200 (FinMatrix's Inventory), Sage 50 UK keeps its
 * bank at 1200 and its creditors at 2100. Taking "same number" as "same
 * account" would post a bank balance into stock, or rent into salaries,
 * with every total still balancing. So a number match counts only when the
 * types agree and the names, the control role or a distinctive kind agree
 * too; anything else is a clash, asked about, never merged silently.
 */
import { ACCT_AP, ACCT_AR, ACCT_INVENTORY } from '../../accounts/accounts.constants';
import { normalizeKey } from '../parsers/text-normalize';
import { CONTROL_ACCOUNT_HINTS } from '../targets';

export interface SourceAccountInfo {
  number: string;
  name: string | null;
  type: string | null;
  kind: string | null;
}

export interface ChartAccountInfo {
  accountNumber: string;
  name: string;
  type: string;
  subType?: string | null;
}

/** Words that say nothing about which account it is. */
const FILLER = new Set(['account', 'accounts', 'ac', 'expense', 'expenses', 'revenue', 'income', 'the', 'and', 'of', 'control', 'total']);

const words = (s: string | null | undefined): string[] =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !FILLER.has(w));

/** "Rent" and "Rent Expense", "Sales" and "Sales Revenue" agree; "Sales" and "Sales Returns" do not. */
export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  if (normalizeKey(a) && normalizeKey(a) === normalizeKey(b)) return true;
  const x = new Set(words(a));
  const y = new Set(words(b));
  return x.size > 0 && x.size === y.size && [...x].every((w) => y.has(w));
}

/** The names share a meaningful word ("Cash in Hand" and "Cash"). */
export function namesOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  const y = new Set(words(b));
  return words(a).some((w) => y.has(w));
}

type Control = 'ar' | 'ap' | 'inventory';

/** The control role a source account's name or kind gives it ("Debtors Control Account" → receivables). */
export function controlByName(src: Pick<SourceAccountInfo, 'name' | 'kind'>): Control | null {
  const candidates = new Set(
    [normalizeKey(src.name), normalizeKey(src.kind), normalizeKey(words(src.name).join(' '))].filter(Boolean),
  );
  for (const role of ['ar', 'ap', 'inventory'] as const) {
    if (CONTROL_ACCOUNT_HINTS[role].some((h) => candidates.has(normalizeKey(h)))) return role;
  }
  return null;
}

const controlAt = (number: string): Control | null =>
  number === ACCT_AR ? 'ar' : number === ACCT_AP ? 'ap' : number === ACCT_INVENTORY ? 'inventory' : null;

/** Kinds a chart has one of: two accounts of the same such kind are the same account. */
const DISTINCTIVE = new Set(
  ['Cash', 'Accounts Receivable', 'Accounts Payable', 'Tax Payable', 'Owner Equity', 'Retained Earnings', 'Opening Balance Equity'].map(normalizeKey),
);

export function sameAccount(src: SourceAccountInfo, acct: ChartAccountInfo): boolean {
  if (!typesAgree(src, acct)) return false;
  // A bare number with no name: nothing says it is a different account.
  if (!normalizeKey(src.name)) return true;
  if (namesAgree(src.name, acct.name)) return true;
  const mine = controlByName(src);
  if (mine && mine === controlAt(acct.accountNumber)) return true;
  const kind = normalizeKey(src.kind);
  return !!kind && DISTINCTIVE.has(kind) && kind === normalizeKey(acct.subType);
}

export function typesAgree(src: Pick<SourceAccountInfo, 'type'>, acct: Pick<ChartAccountInfo, 'type'>): boolean {
  return !normalizeKey(src.type) || normalizeKey(src.type) === normalizeKey(acct.type);
}

/**
 * The next number nobody uses, near the clashing one: 1200 → 1201, "090" →
 * "091", "ALI-7" → "ALI-8", "CASH" → "CASH-1". `taken` holds every number
 * in FinMatrix and in the source (normalised), and gains the one returned.
 */
export function freeNumber(number: string, taken: Set<string>): string {
  const m = /^(.*?)(\d+)$/.exec(number);
  for (let i = 1; i < 10_000; i++) {
    const candidate = m ? `${m[1]}${String(Number(m[2]) + i).padStart(m[2].length, '0')}` : `${number}-${i}`;
    const key = normalizeKey(candidate);
    if (!taken.has(key)) {
      taken.add(key);
      return candidate;
    }
  }
  throw new Error(`No free account number near ${number}`);
}
