/**
 * An in-memory LEDGER for the reports unit specs.
 *
 * Every query the statements issue is answered from one list of postings, the
 * way Postgres would answer it, so a balance sheet, a cash-flow statement and
 * a P&L built from it are three views of the same books and must tie. Lives
 * under test/ so the build never ships it.
 */
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReportsService } from '../src/modules/reports/reports.service';
import { ReportsKpiService } from '../src/modules/reports/reports-kpi.service';
import { BudgetsService } from '../src/modules/budgets/budgets.service';
import { Invoice } from '../src/modules/invoices/entities/invoice.entity';
import { Bill } from '../src/modules/bills/entities/bill.entity';
import { InventoryItem } from '../src/modules/inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../src/modules/inventory/entities/inventory-movement.entity';
import { Delivery } from '../src/modules/deliveries/entities/delivery.entity';
import { TaxPayment } from '../src/modules/tax/entities/tax-payment.entity';

export type Acct = {
  code: string;
  name: string;
  type: string;
  subType: string;
};
export type PostingFixture = {
  ref: string;
  date: string;
  sourceType: string;
  sourceId?: string;
  /** The customer or vendor the document names, for the drill-downs. */
  party?: string;
  /** [account code, debit, credit] */
  lines: Array<[string, number, number]>;
};

const CASH_SUBTYPES = new Set(['Cash', 'Bank']);
const OPENING = new Set(['opening_balance', 'opening_stock']);

/** A DataSource.query stub that answers from postings. */
export function ledgerQuery(
  accounts: Acct[],
  postings: PostingFixture[],
  opts: {
    fyMonth?: number | null;
    lookThrough?: any[];
    extra?: (sql: string, params: any[]) => any;
  } = {},
) {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const rows = postings.flatMap((p) =>
    p.lines.map(([code, debit, credit], i) => {
      const a = byCode.get(code);
      if (!a) throw new Error(`fixture: no account ${code}`);
      return {
        id: `${p.ref}:${i}`,
        reference: p.ref,
        date: p.date,
        sourceType: p.sourceType,
        sourceId: p.sourceId ?? p.ref,
        party: p.party ?? null,
        accountCode: a.code,
        accountName: a.name,
        type: a.type,
        subType: a.subType,
        debit,
        credit,
        amount: String(debit - credit),
      };
    }),
  );
  const isCash = (r: { subType: string }) => CASH_SUBTYPES.has(r.subType);
  const inRange = (d: string, s: string, e: string) => d >= s && d <= e;
  const numOf = (code: string) => parseInt(code, 10);
  const nonOp = (r: any) =>
    r.type === 'equity' ||
    r.subType === 'Fixed Asset' ||
    r.subType === 'Notes Payable' ||
    (r.subType === 'Other Asset' && numOf(r.accountCode) >= 1500);

  return jest.fn(async (sql: string, params: any[] = []) => {
    const extra = opts.extra?.(sql, params);
    if (extra !== undefined) return extra;

    if (sql.includes('fiscal_year_start_month'))
      return [{ month: opts.fyMonth ?? null }];

    // ── account lookups and per-account drill-downs ──
    const creditNormalSql = sql.includes(
      '(g.credit::numeric - g.debit::numeric)',
    );
    const signedOf = (r: any) =>
      creditNormalSql ? r.credit - r.debit : r.debit - r.credit;
    const ofAccount = (code: string) =>
      rows.filter((r) => r.accountCode === code);

    if (sql.includes('a.account_number = $2') && sql.includes('LIMIT 1')) {
      const a = byCode.get(params[1]);
      return a
        ? [
            {
              id: a.code,
              accountCode: a.code,
              accountName: a.name,
              accountType: a.type,
              subType: a.subType,
            },
          ]
        : [];
    }
    if (sql.includes('g.date >= $3 AND g.date < $4') && sql.includes('AS v')) {
      const [, code, from, to] = params;
      return [
        {
          v: String(
            ofAccount(code)
              .filter((r) => r.date >= from && r.date < to)
              .reduce((t, r) => t + signedOf(r), 0),
          ),
        },
      ];
    }
    if (sql.includes('COUNT(*)::int AS cnt')) {
      const [, code, s, e] = params;
      const mine = ofAccount(code).filter((r) => inRange(r.date, s, e));
      return [
        {
          cnt: mine.length,
          dr: String(mine.reduce((t, r) => t + r.debit, 0)),
          cr: String(mine.reduce((t, r) => t + r.credit, 0)),
        },
      ];
    }
    if (sql.includes('ROWS BETWEEN UNBOUNDED PRECEDING')) {
      const [, code, s, e, limit, offset] = params;
      let running = 0;
      const asc = ofAccount(code)
        .filter((r) => inRange(r.date, s, e))
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.reference.localeCompare(b.reference) ||
            a.id.localeCompare(b.id),
        )
        .map((r) => {
          running += signedOf(r);
          return {
            ...r,
            debit: String(r.debit),
            credit: String(r.credit),
            counterpartyName: r.party,
            running: String(running),
          };
        });
      const ordered = sql.includes('x.date DESC') ? asc.reverse() : asc;
      return ordered.slice(offset, offset + limit);
    }
    if (sql.includes('g.id = ANY($2::uuid[])')) {
      const ids = new Set(params[1]);
      return rows
        .filter((r) => ids.has(r.id))
        .map((r) => ({
          ...r,
          memo: null,
          debit: String(r.debit),
          credit: String(r.credit),
          documentNumber: null,
          counterpartyName: r.party,
        }));
    }
    if (sql.includes('FILTER (WHERE x.date >= $3')) {
      const [, code, s, e, cs, ce] = params;
      const m = new Map<string, any>();
      for (const r of ofAccount(code)) {
        const cur = inRange(r.date, s, e) ? signedOf(r) : 0;
        const pri = inRange(r.date, cs, ce) ? signedOf(r) : 0;
        if (!cur && !pri) continue;
        const k = `${r.party ?? ''}|${r.sourceType}`;
        const v = m.get(k) ?? {
          counterparty: r.party,
          sourceType: r.sourceType,
          cur: 0,
          pri: 0,
        };
        v.cur += cur;
        v.pri += pri;
        m.set(k, v);
      }
      return [...m.values()].map((v) => ({
        ...v,
        cur: String(v.cur),
        pri: String(v.pri),
      }));
    }
    if (sql.includes('make_interval')) {
      const [, priorEnd, month] = params;
      const m = new Map<string, any>();
      for (const r of rows.filter(
        (x) =>
          x.date <= priorEnd && (x.type === 'revenue' || x.type === 'expense'),
      )) {
        const [y, mo] = r.date.split('-').map(Number);
        const fy = mo >= month ? y : y - 1;
        const k = `${fy}|${r.accountCode}`;
        const v = m.get(k) ?? {
          fy,
          accountNumber: r.accountCode,
          type: r.type,
          subType: r.subType,
          dr: 0,
          cr: 0,
        };
        v.dr += r.debit;
        v.cr += r.credit;
        m.set(k, v);
      }
      return [...m.values()].map((v) => ({
        ...v,
        dr: String(v.dr),
        cr: String(v.cr),
      }));
    }

    if (sql.includes('cash_refs')) {
      const [, s, e] = params;
      const refs = new Set(
        rows
          .filter((r) => isCash(r) && inRange(r.date, s, e))
          .map((r) => r.reference),
      );
      return rows.filter((r) => refs.has(r.reference));
    }

    if (
      sql.includes("to_char(g.date, 'YYYY-MM') AS period") &&
      sql.includes("a.type IN ('revenue', 'expense')")
    ) {
      const [, s, e] = params;
      const m = new Map<string, any>();
      for (const r of rows.filter(
        (x) =>
          inRange(x.date, s, e) &&
          (x.type === 'revenue' || x.type === 'expense'),
      )) {
        const k = `${r.date.slice(0, 7)}|${r.accountCode}`;
        const v = m.get(k) ?? {
          period: r.date.slice(0, 7),
          accountNumber: r.accountCode,
          type: r.type,
          subType: r.subType,
          dr: 0,
          cr: 0,
        };
        v.dr += r.debit;
        v.cr += r.credit;
        m.set(k, v);
      }
      return [...m.values()].map((v) => ({
        ...v,
        dr: String(v.dr),
        cr: String(v.cr),
      }));
    }

    if (
      sql.includes("a.sub_type IN ('Cash', 'Bank')") &&
      sql.includes('g.date >= $2 AND g.date <= $3')
    ) {
      const [, s, e] = params;
      return [
        {
          v: String(
            rows
              .filter((r) => isCash(r) && inRange(r.date, s, e))
              .reduce((t, r) => t + r.debit - r.credit, 0),
          ),
        },
      ];
    }

    if (
      sql.includes("a.account_number = '1200'") &&
      sql.includes('GROUP BY period')
    ) {
      const anchor = params[1];
      const m = new Map<string, number>();
      for (const r of rows.filter(
        (x) => x.accountCode === '1200' && (!anchor || x.date <= anchor),
      )) {
        m.set(
          r.date.slice(0, 7),
          (m.get(r.date.slice(0, 7)) ?? 0) + r.debit - r.credit,
        );
      }
      return [...m.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, net]) => ({ period, net: String(net) }));
    }

    if (sql.includes('WITH candidates')) {
      const [, s, e] = params;
      const inPeriod = rows.filter((r) => inRange(r.date, s, e));
      const refs = new Set(
        inPeriod
          .filter((r) => OPENING.has(r.sourceType) || nonOp(r))
          .map((r) => r.reference),
      );
      return inPeriod.filter((r) => refs.has(r.reference));
    }

    if (sql.includes('bill_payment_applications'))
      return opts.lookThrough ?? [];

    if (
      sql.includes("to_char(g.date, 'YYYY-MM') AS period") &&
      sql.includes("a.sub_type IN ('Cash','Bank')")
    ) {
      // The month-by-month cash movement within the range.
      const [, s, e] = params;
      const m = new Map<string, number>();
      for (const r of rows.filter((x) => isCash(x) && inRange(x.date, s, e))) {
        const k = r.date.slice(0, 7);
        m.set(k, (m.get(k) ?? 0) + r.debit - r.credit);
      }
      return [...m.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, v]) => ({ period, v: String(v) }));
    }

    if (
      sql.includes('GROUP BY a.account_number, a.name') &&
      sql.includes('FILTER (WHERE g.date < $2)')
    ) {
      const [, s, e] = params;
      const m = new Map<
        string,
        {
          accountCode: string;
          accountName: string;
          beginning: number;
          ending: number;
        }
      >();
      for (const r of rows.filter((x) => isCash(x) && x.date <= e)) {
        const cur = m.get(r.accountCode) ?? {
          accountCode: r.accountCode,
          accountName: r.accountName,
          beginning: 0,
          ending: 0,
        };
        cur.ending += r.debit - r.credit;
        if (r.date < s) cur.beginning += r.debit - r.credit;
        m.set(r.accountCode, cur);
      }
      return [...m.values()].sort((a, b) =>
        a.accountCode.localeCompare(b.accountCode),
      );
    }

    if (
      sql.includes('FROM accounts a') &&
      sql.includes('LEFT JOIN general_ledger g')
    ) {
      const [, s, e] = params;
      return [...accounts]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((a) => {
          const mine = rows.filter(
            (r) => r.accountCode === a.code && inRange(r.date, s, e),
          );
          return {
            accountNumber: a.code,
            accountName: a.name,
            type: a.type,
            subType: a.subType,
            dr: String(mine.reduce((t, r) => t + r.debit, 0)),
            cr: String(mine.reduce((t, r) => t + r.credit, 0)),
          };
        });
    }

    if (sql.includes('g.date < $2') && sql.includes('AS v')) {
      const [, s] = params;
      const v = rows
        .filter((r) => isCash(r) && r.date < s)
        .reduce((t, r) => t + r.debit - r.credit, 0);
      return [{ v: String(v) }];
    }

    return [];
  });
}

export async function makeModule(
  query: jest.Mock,
  budgets: Partial<BudgetsService> = {},
) {
  const repo = {} as never;
  return Test.createTestingModule({
    providers: [
      ReportsService,
      ReportsKpiService,
      { provide: BudgetsService, useValue: budgets },
      { provide: DataSource, useValue: { query } },
      { provide: getRepositoryToken(Invoice), useValue: repo },
      { provide: getRepositoryToken(Bill), useValue: repo },
      { provide: getRepositoryToken(InventoryItem), useValue: repo },
      { provide: getRepositoryToken(InventoryMovement), useValue: repo },
      { provide: getRepositoryToken(Delivery), useValue: repo },
      { provide: getRepositoryToken(TaxPayment), useValue: repo },
    ],
  }).compile();
}

export async function makeService(query: jest.Mock) {
  return (await makeModule(query)).get(ReportsService);
}

export async function makeKpiService(
  query: jest.Mock,
  budgets: Partial<BudgetsService> = {},
) {
  return (await makeModule(query, budgets)).get(ReportsKpiService);
}

export const CHART: Acct[] = [
  { code: '1000', name: 'Cash', type: 'asset', subType: 'Cash' },
  { code: '1010', name: 'Business Checking', type: 'asset', subType: 'Bank' },
  {
    code: '1100',
    name: 'Accounts Receivable',
    type: 'asset',
    subType: 'Accounts Receivable',
  },
  { code: '1200', name: 'Inventory', type: 'asset', subType: 'Inventory' },
  { code: '1500', name: 'Equipment', type: 'asset', subType: 'Fixed Asset' },
  {
    code: '2000',
    name: 'Accounts Payable',
    type: 'liability',
    subType: 'Accounts Payable',
  },
  {
    code: '2700',
    name: 'Bank Loan',
    type: 'liability',
    subType: 'Notes Payable',
  },
  {
    code: '3000',
    name: 'Owner Equity',
    type: 'equity',
    subType: 'Owner Equity',
  },
  {
    code: '3100',
    name: 'Retained Earnings',
    type: 'equity',
    subType: 'Retained Earnings',
  },
  {
    code: '3200',
    name: 'Owner Drawings',
    type: 'equity',
    subType: 'Owner Draws',
  },
  {
    code: '3900',
    name: 'Opening Balance Equity',
    type: 'equity',
    subType: 'Opening Balance Equity',
  },
  { code: '4000', name: 'Sales Revenue', type: 'revenue', subType: 'Sales' },
  { code: '4100', name: 'Bank Interest', type: 'revenue', subType: 'Interest' },
  {
    code: '5000',
    name: 'Cost of Goods Sold',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  { code: '6000', name: 'Rent Expense', type: 'expense', subType: 'Operating' },
  {
    code: '6300',
    name: 'Office Supplies',
    type: 'expense',
    subType: 'Operating',
  },
];

/**
 * A year of books with every kind of cash the old statement misfiled, plus
 * the non-cash items that used to leave a residual.
 */
export const CASH_BOOKS: PostingFixture[] = [
  // Before the range: the opening cash position.
  {
    ref: 'JE-001',
    date: '2025-12-01',
    sourceType: 'opening_balance',
    lines: [
      ['1000', 10000, 0],
      ['3900', 0, 10000],
    ],
  },
  // Opening stock entered during the year — non-cash, the old residual.
  {
    ref: 'JE-002',
    date: '2026-02-01',
    sourceType: 'opening_stock',
    lines: [
      ['1200', 3000, 0],
      ['3900', 0, 3000],
    ],
  },
  // A bill for a machine and some supplies, then its payment.
  {
    ref: 'JE-003',
    date: '2026-03-01',
    sourceType: 'bill',
    sourceId: 'bill-1',
    lines: [
      ['1500', 4000, 0],
      ['6300', 1000, 0],
      ['2000', 0, 5000],
    ],
  },
  {
    ref: 'JE-004',
    date: '2026-03-15',
    sourceType: 'bill_payment',
    sourceId: 'bp-1',
    lines: [
      ['2000', 5000, 0],
      ['1010', 0, 5000],
    ],
  },
  // A bank loan, owner capital, owner drawings and a transfer — all journals.
  {
    ref: 'JE-005',
    date: '2026-04-01',
    sourceType: 'journal_entry',
    lines: [
      ['1010', 20000, 0],
      ['2700', 0, 20000],
    ],
  },
  {
    ref: 'JE-006',
    date: '2026-04-02',
    sourceType: 'journal_entry',
    lines: [
      ['1000', 7000, 0],
      ['3000', 0, 7000],
    ],
  },
  {
    ref: 'JE-007',
    date: '2026-04-03',
    sourceType: 'journal_entry',
    lines: [
      ['3200', 1500, 0],
      ['1000', 0, 1500],
    ],
  },
  {
    ref: 'JE-008',
    date: '2026-04-04',
    sourceType: 'journal_entry',
    lines: [
      ['1010', 2000, 0],
      ['1000', 0, 2000],
    ],
  },
  // Trade: a sale on credit with its cost, part of it collected.
  {
    ref: 'JE-009',
    date: '2026-05-01',
    sourceType: 'invoice',
    lines: [
      ['1100', 6000, 0],
      ['4000', 0, 6000],
      ['5000', 2000, 0],
      ['1200', 0, 2000],
    ],
  },
  {
    ref: 'JE-010',
    date: '2026-05-20',
    sourceType: 'payment',
    lines: [
      ['1000', 4000, 0],
      ['1100', 0, 4000],
    ],
  },
  // A second machine bought on credit and still unpaid at the year end.
  {
    ref: 'JE-011',
    date: '2026-06-01',
    sourceType: 'bill',
    sourceId: 'bill-2',
    lines: [
      ['1500', 2500, 0],
      ['2000', 0, 2500],
    ],
  },
];

/** What bp-1 paid for: bill-1's posted debit lines. */
export const LOOK_THROUGH = [
  {
    applicationId: 'app-1',
    paymentId: 'bp-1',
    applied: '5000',
    accountCode: '1500',
    type: 'asset',
    subType: 'Fixed Asset',
    debit: '4000',
  },
  {
    applicationId: 'app-1',
    paymentId: 'bp-1',
    applied: '5000',
    accountCode: '6300',
    type: 'expense',
    subType: 'Operating',
    debit: '1000',
  },
];
