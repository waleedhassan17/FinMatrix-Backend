/**
 * The owner's chart wins.
 *
 * A business moving to FinMatrix keeps its own chart of accounts exactly:
 * every account keeps its number and name. FinMatrix's own accounts evolve
 * instead:
 *
 *  - Adopt: the FinMatrix account that IS one of the owner's accounts —
 *    Receivables and the owner's "1200 Accounts Receivable", Sales Tax
 *    Payable and the owner's "2100 Sales Tax Control" — takes the owner's
 *    number and name for good. Its role (what automatic posting uses it for),
 *    type and kind stay, so invoices keep posting to it.
 *  - Create: every other owner account is created with its own number.
 *  - Step aside: a FinMatrix account the owner does not have, sitting on a
 *    number the owner uses for something else, moves to the next free number
 *    (6000 Rent Expense → 6001).
 *
 * Pure and deterministic: the analysis shows the plan, the commit applies the
 * same plan, and the same files always give the same plan.
 */
import { freeNumber } from '../../accounts/account-number.util';
import {
  SYS,
  SYSTEM_ACCOUNT_DEFS,
  SystemRole,
} from '../../accounts/accounts.constants';
import { normalizeKey } from '../parsers/text-normalize';
import { CONTROL_ACCOUNT_HINTS } from '../targets';
import { namesAgree, sameAccount, typesAgree } from './account-clash';

export interface PlanChartAccount {
  id: string;
  accountNumber: string;
  name: string;
  type: string;
  subType: string | null;
  systemRole: string | null;
}

export interface PlanSourceAccount {
  number: string;
  name: string | null;
  type: string | null;
  kind: string | null;
}

export interface ChartChange {
  accountId: string;
  role: SystemRole | null;
  fromNumber: string;
  fromName: string;
  toNumber: string;
  toName: string;
  /** adopt: becomes one of the owner's accounts; step_aside: moves off a number the owner uses. */
  change: 'adopt' | 'step_aside';
  /** The owner's account it became (adopt only). */
  source: string | null;
}

export interface RoleChoice {
  role: SystemRole;
  accountId: string;
  /** The owner's accounts that could be it, best first. */
  candidates: string[];
  chosen: string | null;
  /** More than one fits equally well: the owner confirms. */
  unsure: boolean;
}

export interface ChartPlan {
  changes: ChartChange[];
  /** FinMatrix account each owner account becomes (normalised owner number → account id). */
  mergedInto: Map<string, string>;
  /** Every FinMatrix account's number once the plan is applied. */
  finalNumber: Map<string, string>;
  /** How each FinMatrix role was matched, for the Match step. */
  roles: RoleChoice[];
  /**
   * Owner accounts that are a system role this company does not have yet
   * (Customer Advances before its first use, say): created with that role,
   * so automatic posting finds them instead of making a second one.
   */
  newRoles: Map<string, SystemRole>;
}

export interface PlanOptions {
  /** The owner's choice for a role: an owner account number, or 'keep' (FinMatrix keeps its own). */
  roleDecision: (role: SystemRole) => string | undefined;
  /**
   * The owner's choice for an account: a FinMatrix account number (merge into
   * it), 'NEW' / 'NEW:<type>' (create it), or undefined.
   */
  accountDecision: (sourceKey: string) => string | undefined;
}

/** What makes an owner account a FinMatrix role, strongest signals first. */
interface RoleMatch {
  kinds?: string[];
  names: string[];
  /** A role a business has one of: its kind alone is enough. */
  control?: boolean;
}

const ROLE_MATCH: Partial<Record<SystemRole, RoleMatch>> = {
  [SYS.AR]: {
    kinds: ['Accounts Receivable'],
    names: [...CONTROL_ACCOUNT_HINTS.ar],
    control: true,
  },
  [SYS.AP]: {
    kinds: ['Accounts Payable'],
    names: [...CONTROL_ACCOUNT_HINTS.ap],
    control: true,
  },
  [SYS.INVENTORY]: {
    kinds: ['Inventory'],
    names: [...CONTROL_ACCOUNT_HINTS.inventory],
    control: true,
  },
  [SYS.RETAINED_EARNINGS]: {
    kinds: ['Retained Earnings'],
    names: [
      'retained earnings',
      'retained profit',
      'profit and loss account',
      'profit & loss account',
      'p&l reserve',
      'accumulated profit',
      'profit and loss reserve',
    ],
    control: true,
  },
  [SYS.CASH]: {
    kinds: ['Cash'],
    names: [
      'cash',
      'cash in hand',
      'cash on hand',
      'petty cash',
      'cash-in-hand',
    ],
  },
  [SYS.BANK]: {
    kinds: ['Bank'],
    names: [
      'bank',
      'business checking',
      'checking',
      'bank current account',
      'current account',
    ],
  },
  [SYS.TAX_PAYABLE]: {
    kinds: ['Tax Payable'],
    names: [
      'sales tax payable',
      'sales tax',
      'sales tax control',
      'vat',
      'vat control',
      'vat liability',
      'gst payable',
      'gst',
      'output tax',
      'output vat',
    ],
  },
  [SYS.INPUT_TAX]: {
    names: [
      'input tax',
      'sales tax recoverable',
      'input vat',
      'vat input',
      'gst input',
      'gst receivable',
      'sales tax receivable',
    ],
  },
  [SYS.SALES_REVENUE]: {
    kinds: ['Sales'],
    names: [
      'sales',
      'sales revenue',
      'revenue',
      'sales income',
      'sales accounts',
      'sales of goods',
    ],
  },
  [SYS.COGS]: {
    kinds: ['Cost of Goods'],
    names: ['cost of goods sold', 'cost of sales', 'cogs', 'cost of goods'],
  },
  [SYS.OWNER_EQUITY]: {
    kinds: ['Owner Equity'],
    names: [
      'owner equity',
      'owners equity',
      "owner's equity",
      'capital',
      'owner capital',
      "owner's capital",
      'share capital',
      'capital account',
      'proprietor capital',
    ],
  },
  [SYS.OPENING_BALANCE_EQUITY]: {
    kinds: ['Opening Balance Equity'],
    names: ['opening balance equity', 'opening balances', 'opening balance'],
  },
  [SYS.CUSTOMER_ADVANCES]: {
    names: [
      'customer advances',
      'customer deposits',
      'unearned revenue',
      'advances from customers',
      'customer credits',
      'customer advances unearned revenue',
    ],
  },
  [SYS.PAYROLL_LIABILITIES]: {
    kinds: ['Payroll Liability'],
    names: [
      'payroll liabilities',
      'salaries payable',
      'wages payable',
      'payroll payable',
      'paye',
    ],
  },
  [SYS.SALARY_EXPENSE]: {
    kinds: ['Payroll'],
    names: [
      'salary expense',
      'salaries',
      'salary',
      'wages',
      'salaries and wages',
      'salaries & wages',
      'gross wages',
    ],
  },
};

/** Roles in the order they choose, the controls first. */
const ROLE_ORDER: SystemRole[] = [
  SYS.AR,
  SYS.AP,
  SYS.INVENTORY,
  SYS.RETAINED_EARNINGS,
  SYS.CASH,
  SYS.BANK,
  SYS.TAX_PAYABLE,
  SYS.INPUT_TAX,
  SYS.SALES_REVENUE,
  SYS.COGS,
  SYS.OWNER_EQUITY,
  SYS.OPENING_BALANCE_EQUITY,
  SYS.CUSTOMER_ADVANCES,
  SYS.PAYROLL_LIABILITIES,
  SYS.SALARY_EXPENSE,
  SYS.GOODS_IN_TRANSIT,
  SYS.GRNI,
  SYS.MIGRATION_CLEARING,
  SYS.SHRINKAGE_DAMAGE,
  SYS.SHRINKAGE_THEFT,
  SYS.SHRINKAGE_OBSOLESCENCE,
  SYS.INVENTORY_COUNT_VARIANCE,
  SYS.INVENTORY_ADJUSTMENT,
];

/** Plural-tolerant name agreement ("Salaries" and "Salary"). */
const stem = (s: string | null | undefined) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ies\b/g, 'y')
    .replace(/(?<=[a-z]{3})s\b/g, '');

const nameMatches = (name: string | null, hints: string[]): boolean =>
  !!name && hints.some((h) => namesAgree(stem(name), stem(h)));

/**
 * How well an owner account fits a FinMatrix role: 0 not at all. Named
 * exactly as the FinMatrix account (or the role) beats a name that only
 * looks like it ("Customer Deposits" for Customer Advances), which beats a
 * kind alone. A control's kind is decisive (8); its name adds to it.
 */
function score(
  role: SystemRole,
  fm: PlanChartAccount,
  src: PlanSourceAccount,
): number {
  const def = SYSTEM_ACCOUNT_DEFS[role];
  if (!typesAgree(src, { type: def.type })) return 0;
  const match = ROLE_MATCH[role];
  const exact = namesAgree(src.name, fm.name) || namesAgree(src.name, def.name);
  const hinted = !exact && !!match && nameMatches(src.name, match.names);
  const kind = normalizeKey(src.kind);
  const byKind =
    !!kind && !!match?.kinds?.some((k) => normalizeKey(k) === kind);
  // The source's own control (Peachtree's AP control, the report engine's
  // receivables) always outranks an account merely named like one —
  // Peachtree may hold "2000 Accounts Payable" beside its real control.
  if (match?.control) return (byKind ? 8 : 0) + (exact ? 4 : hinted ? 3 : 0);
  if (exact) return 5 + (byKind ? 1 : 0);
  if (hinted) return 3 + (byKind ? 1 : 0);
  // A kind alone fits only roles a chart has one of (Cash, Owner Equity…);
  // a bank or a sales account by kind alone is the first such, by number.
  return byKind ? 2 : 0;
}

const byNumber = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true });

export function planChart(
  chart: PlanChartAccount[],
  sources: PlanSourceAccount[],
  opts: PlanOptions,
): ChartPlan {
  const key = (n: string) => normalizeKey(n);
  const srcByKey = new Map(sources.map((s) => [key(s.number), s]));
  const adoptedBy = new Map<string, string>(); // account id → owner key
  const mergedInto = new Map<string, string>(); // owner key → account id
  const adopt = (accountId: string, sourceKey: string) => {
    adoptedBy.set(accountId, sourceKey);
    mergedInto.set(sourceKey, accountId);
  };
  const free = (sourceKey: string) => {
    if (mergedInto.has(sourceKey)) return false;
    const d = opts.accountDecision(sourceKey);
    return !d || !d.startsWith('NEW');
  };
  const byFmNumber = new Map(chart.map((a) => [key(a.accountNumber), a]));

  // 1. The owner said where an account goes: that FinMatrix account becomes it.
  for (const s of [...sources].sort((a, b) => byNumber(a.number, b.number))) {
    const k = key(s.number);
    const d = opts.accountDecision(k);
    if (!d || d.startsWith('NEW')) continue;
    const fm = byFmNumber.get(key(d));
    if (fm && !adoptedBy.has(fm.id) && !mergedInto.has(k)) adopt(fm.id, k);
  }

  // 2. Each FinMatrix role takes the owner account that is it.
  const roles: RoleChoice[] = [];
  /** Roles the owner keeps as FinMatrix's own: never merged with an owner account. */
  const kept = new Set<string>();
  for (const role of ROLE_ORDER) {
    const fm = chart.find((a) => a.systemRole === role);
    if (!fm) continue;
    if (adoptedBy.has(fm.id)) {
      roles.push({
        role,
        accountId: fm.id,
        candidates: [adoptedBy.get(fm.id)!],
        chosen: srcByKey.get(adoptedBy.get(fm.id)!)?.number ?? null,
        unsure: false,
      });
      continue;
    }
    const decided = opts.roleDecision(role);
    const scored = sources
      .filter((s) => free(key(s.number)))
      .map((s) => ({ s, score: score(role, fm, s) }))
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          // The owner account on FinMatrix's own number first, then the lowest number.
          Number(key(b.s.number) === key(fm.accountNumber)) -
            Number(key(a.s.number) === key(fm.accountNumber)) ||
          byNumber(a.s.number, b.s.number),
      );
    const candidates = scored.map((x) => x.s.number);
    if (decided === 'keep') {
      kept.add(fm.id);
      roles.push({
        role,
        accountId: fm.id,
        candidates,
        chosen: null,
        unsure: false,
      });
      continue;
    }
    const pick =
      decided && srcByKey.has(key(decided)) && free(key(decided))
        ? srcByKey.get(key(decided))!
        : scored[0]?.s;
    const unsure =
      !decided &&
      !!ROLE_MATCH[role]?.control &&
      scored.length > 1 &&
      scored[1].score === scored[0].score;
    if (pick) adopt(fm.id, key(pick.number));
    roles.push({
      role,
      accountId: fm.id,
      candidates,
      chosen: pick?.number ?? null,
      unsure,
    });
  }

  // 2b. A role this company has no account for yet: the owner account that
  //     clearly is it (by name, or a control's kind) is created with it.
  const newRoles = new Map<string, SystemRole>();
  for (const role of ROLE_ORDER) {
    if (chart.some((a) => a.systemRole === role)) continue;
    const def = SYSTEM_ACCOUNT_DEFS[role];
    const ghost: PlanChartAccount = {
      id: `role:${role}`,
      accountNumber: def.defaultNumber,
      name: def.name,
      type: def.type,
      subType: def.subType,
      systemRole: role,
    };
    // Any owner account not merged into a FinMatrix one — including one the
    // owner chose to create new: it is created, and with its role.
    const best = sources
      .filter((s) => {
        const k = key(s.number);
        const d = opts.accountDecision(k);
        return (
          !mergedInto.has(k) && !newRoles.has(k) && (!d || d.startsWith('NEW'))
        );
      })
      .map((s) => ({ s, score: score(role, ghost, s) }))
      .filter((x) => x.score >= 3)
      .sort((a, b) => b.score - a.score || byNumber(a.s.number, b.s.number))[0];
    if (best) newRoles.set(key(best.s.number), role);
  }

  // 3. An ordinary FinMatrix account becomes the owner account of the same
  //    name (its own number first), then the owner account on its number
  //    when they are the same account.
  const plain = chart
    .filter((a) => !a.systemRole && !adoptedBy.has(a.id))
    .sort((a, b) => byNumber(a.accountNumber, b.accountNumber));
  for (const fm of plain) {
    const same = sources
      .filter(
        (s) =>
          free(key(s.number)) &&
          typesAgree(s, fm) &&
          namesAgree(s.name, fm.name),
      )
      .sort(
        (a, b) =>
          Number(key(b.number) === key(fm.accountNumber)) -
            Number(key(a.number) === key(fm.accountNumber)) ||
          byNumber(a.number, b.number),
      );
    if (same[0]) adopt(fm.id, key(same[0].number));
  }
  for (const s of sources) {
    const k = key(s.number);
    if (!free(k)) continue;
    const fm = byFmNumber.get(k);
    if (fm && !adoptedBy.has(fm.id) && !kept.has(fm.id) && sameAccount(s, fm))
      adopt(fm.id, k);
  }

  // 4. Numbers: an adopted account takes the owner's; an account on a number
  //    the owner uses for something else steps aside; the rest stay.
  const finalNumber = new Map<string, string>();
  const changes: ChartChange[] = [];
  const ownerNumbers = new Set(sources.map((s) => key(s.number)));
  const taken = new Set<string>([
    ...ownerNumbers,
    ...chart.map((a) => key(a.accountNumber)),
  ]);
  for (const fm of chart) {
    const k = adoptedBy.get(fm.id);
    if (!k) continue;
    const s = srcByKey.get(k)!;
    finalNumber.set(fm.id, s.number);
    const toName = (s.name ?? '').trim() || fm.name;
    if (s.number !== fm.accountNumber || toName !== fm.name)
      changes.push({
        accountId: fm.id,
        role: (fm.systemRole as SystemRole | null) ?? null,
        fromNumber: fm.accountNumber,
        fromName: fm.name,
        toNumber: s.number,
        toName: toName.slice(0, 150),
        change: 'adopt',
        source: s.number,
      });
  }
  for (const fm of [...chart].sort((a, b) =>
    byNumber(a.accountNumber, b.accountNumber),
  )) {
    if (finalNumber.has(fm.id)) continue;
    const k = key(fm.accountNumber);
    if (ownerNumbers.has(k)) {
      const to = freeNumber(fm.accountNumber, taken, normalizeKey);
      finalNumber.set(fm.id, to);
      changes.push({
        accountId: fm.id,
        role: (fm.systemRole as SystemRole | null) ?? null,
        fromNumber: fm.accountNumber,
        fromName: fm.name,
        toNumber: to,
        toName: fm.name,
        change: 'step_aside',
        source: null,
      });
    } else finalNumber.set(fm.id, fm.accountNumber);
  }
  return { changes, mergedInto, finalNumber, roles, newRoles };
}

/** A role's name as the owner reads it. */
export const roleLabel = (role: SystemRole): string =>
  SYSTEM_ACCOUNT_DEFS[role]?.name ?? role;
