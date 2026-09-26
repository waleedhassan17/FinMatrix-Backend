import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { firstValueFrom, of } from 'rxjs';
import { DataSource } from 'typeorm';
import { ResponseEnvelopeInterceptor } from '../../common/interceptors/response-envelope.interceptor';
import { REPORT_RANGE_DEFAULTS, ReportsService } from './reports.service';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { TaxPayment } from '../tax/entities/tax-payment.entity';
import {
  addDaysIso,
  businessToday,
} from '../../common/utils/business-date.util';

/**
 * The statements are pure functions of what the GL returns, so these drive the
 * service through a stubbed DataSource.query and assert the arithmetic.
 *
 * Two properties matter more than any individual number:
 *   • the five pre-existing P&L fields keep their values to the paisa, because
 *     a live screen and the CSV export read them;
 *   • the indirect cash-flow operating total equals the direct one exactly.
 */

type GlRow = {
  accountNumber: string;
  accountName: string;
  type: string;
  subType: string;
  dr: string;
  cr: string;
};

const gl = (
  accountNumber: string,
  accountName: string,
  type: string,
  subType: string,
  dr: number,
  cr: number,
): GlRow => ({
  accountNumber,
  accountName,
  type,
  subType,
  dr: String(dr),
  cr: String(cr),
});

/** Chart with no 7xxx/8xxx accounts — the shape the product ships with. */
const PLAIN: GlRow[] = [
  gl('1000', 'Cash', 'asset', 'Cash', 5000, 1000),
  gl('4000', 'Sales Revenue', 'revenue', 'Sales', 0, 10000),
  gl('5000', 'Cost of Goods Sold', 'expense', 'Cost of Goods', 4000, 0),
  gl('6000', 'Rent Expense', 'expense', 'Operating', 1500, 0),
  gl('6200', 'Salary Expense', 'expense', 'Payroll', 2500, 0),
];

/** Same, plus non-operating income and expense. */
const WITH_OTHER: GlRow[] = [
  ...PLAIN,
  gl('7000', 'Interest Income', 'revenue', 'Other Revenue', 0, 300),
  gl('8000', 'Interest Expense', 'expense', 'Other Expense', 120, 0),
];

/** Same, plus a damage write-off against the 54xx shrinkage account. */
const WITH_SHRINKAGE: GlRow[] = [
  ...PLAIN,
  gl(
    '5400',
    'Inventory Shrinkage – Damage',
    'expense',
    'Cost of Goods',
    600,
    0,
  ),
];

/**
 * A pre-existing adjustment, posted before the reason drove the account. 6400
 * stays an operating expense so historical entries keep reporting where they
 * were posted.
 */
const WITH_LEGACY_SHRINKAGE: GlRow[] = [
  ...PLAIN,
  gl(
    '6400',
    'Inventory Adjustment / Shrinkage',
    'expense',
    'Operating',
    600,
    0,
  ),
];

async function makeService(query: jest.Mock) {
  const repo = {} as never;
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReportsService,
      { provide: DataSource, useValue: { query } },
      { provide: getRepositoryToken(Invoice), useValue: repo },
      { provide: getRepositoryToken(Bill), useValue: repo },
      { provide: getRepositoryToken(InventoryItem), useValue: repo },
      { provide: getRepositoryToken(InventoryMovement), useValue: repo },
      { provide: getRepositoryToken(Delivery), useValue: repo },
      { provide: getRepositoryToken(TaxPayment), useValue: repo },
    ],
  }).compile();
  return moduleRef.get(ReportsService);
}

describe('ReportsService — profitLoss', () => {
  it('keeps the pre-change totals to the paisa when there are no other accounts', async () => {
    const svc = await makeService(jest.fn(async () => PLAIN));
    const r = await svc.profitLoss('c1', '2026-01-01', '2026-12-31');

    // Values computed the way the method always did: revenue 10000,
    // cogs 4000, gross 6000, expenses 4000, net 2000.
    expect(r.revenue).toBe(10000);
    expect(r.cogs).toBe(4000);
    expect(r.grossProfit).toBe(6000);
    expect(r.expenses).toBe(4000);
    expect(r.netIncome).toBe(2000);

    // …and the new operating figures coincide, since nothing is non-operating.
    expect(r.totalIncome).toBe(r.revenue);
    expect(r.totalCogs).toBe(r.cogs);
    expect(r.totalExpenses).toBe(r.expenses);
    expect(r.netOperatingIncome).toBe(r.netIncome);
    expect(r.netOtherIncome).toBe(0);
  });

  it('reports 54xx inventory shrinkage inside COGS, above gross profit', async () => {
    const svc = await makeService(jest.fn(async () => WITH_SHRINKAGE));
    const r = await svc.profitLoss('c1', '2026-01-01', '2026-12-31');

    // The whole point of the 54xx accounts: stock bought to sell and then lost
    // is a cost of goods, so it reduces GROSS profit — which is what makes the
    // margin comparable to QuickBooks.
    expect(r.cogs).toBe(4600);
    expect(r.grossProfit).toBe(5400);
    expect(r.totalCogs).toBe(4600);
    expect(r.cogsLines.map((l) => l.accountCode)).toContain('5400');

    // It is NOT an operating expense…
    expect(r.expenses).toBe(4000);
    expect(r.totalExpenses).toBe(4000);
    expect(r.expenseLines.map((l) => l.accountCode)).not.toContain('5400');

    // …and the bottom line is unmoved by where above it the cost sits.
    expect(r.netIncome).toBe(1400);
    expect(r.netOperatingIncome).toBe(r.netIncome);
  });

  it('leaves legacy 6400 shrinkage in operating expenses', async () => {
    const svc = await makeService(jest.fn(async () => WITH_LEGACY_SHRINKAGE));
    const r = await svc.profitLoss('c1', '2026-01-01', '2026-12-31');

    // 6400 was deliberately not reclassified: entries posted against it really
    // were operating-classified at the time, and the mobile client groups by
    // number range, so moving it would split client from server.
    expect(r.cogs).toBe(4000);
    expect(r.grossProfit).toBe(6000);
    expect(r.expenses).toBe(4600);
    expect(r.expenseLines.map((l) => l.accountCode)).toContain('6400');

    // Same net income as the 5400 case — only the split moved.
    expect(r.netIncome).toBe(1400);
  });

  it('reconciles the line detail against the totals', async () => {
    const svc = await makeService(jest.fn(async () => PLAIN));
    const r = await svc.profitLoss('c1', '2026-01-01', '2026-12-31');
    const sum = (ls: { amount: number }[]) =>
      ls.reduce((t, l) => t + l.amount, 0);

    expect(sum(r.income) - sum(r.cogsLines) - sum(r.expenseLines)).toBeCloseTo(
      r.grossProfit - r.totalExpenses,
      2,
    );
    expect(sum(r.income)).toBe(r.totalIncome);
    expect(sum(r.cogsLines)).toBe(r.totalCogs);
    expect(sum(r.expenseLines)).toBe(r.totalExpenses);
  });

  it('routes 7xxx/8xxx to other income and expense, never to opex', async () => {
    const svc = await makeService(jest.fn(async () => WITH_OTHER));
    const r = await svc.profitLoss('c1', '2026-01-01', '2026-12-31');

    expect(r.otherIncome.map((l) => l.accountCode)).toEqual(['7000']);
    expect(r.otherExpense.map((l) => l.accountCode)).toEqual(['8000']);
    expect(r.expenseLines.map((l) => l.accountCode)).toEqual(['6000', '6200']);

    // Operating totals exclude them; the legacy totals still include them.
    expect(r.totalIncome).toBe(10000);
    expect(r.revenue).toBe(10300);
    expect(r.totalExpenses).toBe(4000);
    expect(r.expenses).toBe(4120);
    expect(r.netOtherIncome).toBe(180);
  });

  it('orders lines by account code and drops untouched accounts', async () => {
    const rows = [
      gl('6200', 'Salary Expense', 'expense', 'Payroll', 100, 0),
      gl('6000', 'Rent Expense', 'expense', 'Operating', 50, 0),
      gl('6300', 'Office Supplies', 'expense', 'Operating', 0, 0), // untouched
    ];
    const svc = await makeService(jest.fn(async () => rows));
    const r = await svc.profitLoss('c1', '2026-01-01', '2026-12-31');
    expect(r.expenseLines.map((l) => l.accountCode)).toEqual(['6000', '6200']);
  });
});

describe('ReportsService — cashFlow indirect operating', () => {
  /**
   * cashFlow issues four queries in order: beginning cash, cash by source
   * type, the monthly trend, then (inside buildOperatingIndirect) opening
   * balances, closing balances and the period rows.
   */
  /** Distinguishes the three glByAccount calls by their date arguments. */
  function makeQuery(opts: {
    beginningCash: number;
    sources: Array<{ src: string; inflow: number; outflow: number }>;
    opening: GlRow[];
    closing: GlRow[];
    period: GlRow[];
    start: string;
    end: string;
    dayBefore: string;
  }) {
    return jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('g.date < $2'))
        return [{ v: String(opts.beginningCash) }];
      if (sql.includes('GROUP BY g.source_type')) {
        return opts.sources.map((s) => ({
          src: s.src,
          inflow: String(s.inflow),
          outflow: String(s.outflow),
        }));
      }
      if (sql.includes('EXTRACT(YEAR FROM g.date)')) return [];
      if (sql.includes('FROM accounts a')) {
        const [, from, to] = params as string[];
        if (to === opts.dayBefore) return opts.opening;
        if (from === '1970-01-01' && to === opts.end) return opts.closing;
        return opts.period;
      }
      return [];
    });
  }

  const START = '2026-02-01';
  const END = '2026-02-28';
  const DAY_BEFORE = '2026-01-31';

  it('ties the indirect operating total to the direct one exactly', async () => {
    // Sale of 1000 collected in cash, COGS 400 out of inventory.
    const query = makeQuery({
      beginningCash: 0,
      sources: [{ src: 'payment', inflow: 1000, outflow: 0 }],
      dayBefore: DAY_BEFORE,
      start: START,
      end: END,
      opening: [gl('1200', 'Inventory', 'asset', 'Inventory', 400, 0)],
      closing: [gl('1200', 'Inventory', 'asset', 'Inventory', 400, 400)],
      period: [
        gl('4000', 'Sales Revenue', 'revenue', 'Sales', 0, 1000),
        gl('5000', 'Cost of Goods Sold', 'expense', 'Cost of Goods', 400, 0),
      ],
    });
    const svc = await makeService(query);
    const r = await svc.cashFlow('c1', START, END);

    expect(r.operatingIndirect).toBeDefined();
    expect(r.operatingIndirect!.total).toBe(r.operating.total);
    expect(r.operatingIndirect!.netIncome).toBe(600);
    // Inventory fell by 400, which releases cash.
    expect(r.operatingIndirect!.adjustments).toContainEqual({
      label: 'Inventory',
      amount: 400,
    });
    // 600 + 400 == 1000 == the direct total, so nothing is left over.
    expect(
      r.operatingIndirect!.adjustments.find(
        (a) => a.label === 'Other operating adjustments',
      ),
    ).toBeUndefined();
  });

  it('surfaces an unattributable remainder instead of silently forcing the tie', async () => {
    // Cash moved but no P&L or working-capital account explains it.
    const query = makeQuery({
      beginningCash: 0,
      sources: [{ src: 'journal_entry', inflow: 250, outflow: 0 }],
      dayBefore: DAY_BEFORE,
      start: START,
      end: END,
      opening: [],
      closing: [],
      period: [],
    });
    const svc = await makeService(query);
    const r = await svc.cashFlow('c1', START, END);

    const residual = r.operatingIndirect!.adjustments.find(
      (a) => a.label === 'Other operating adjustments',
    );
    expect(residual).toEqual({
      label: 'Other operating adjustments',
      amount: 250,
    });
    expect(r.operatingIndirect!.total).toBe(r.operating.total);
  });

  it('counts Goods in Transit once — never also inside the 1200-1299 inventory range', async () => {
    const query = makeQuery({
      beginningCash: 0,
      sources: [],
      dayBefore: DAY_BEFORE,
      start: START,
      end: END,
      opening: [gl('1250', 'Goods in Transit', 'asset', 'Inventory', 0, 0)],
      closing: [gl('1250', 'Goods in Transit', 'asset', 'Inventory', 500, 0)],
      period: [],
    });
    const svc = await makeService(query);
    const r = await svc.cashFlow('c1', START, END);

    const labels = r.operatingIndirect!.adjustments.map((a) => a.label);
    expect(labels).toContain('Goods in Transit');
    expect(labels).not.toContain('Inventory');
    // Stock in transit rose 500, so it consumed cash — counted exactly once.
    expect(
      r.operatingIndirect!.adjustments.find(
        (a) => a.label === 'Goods in Transit',
      ),
    ).toEqual({ label: 'Goods in Transit', amount: -500 });
  });

  it('leaves the direct-method sections untouched', async () => {
    const query = makeQuery({
      beginningCash: 100,
      sources: [
        { src: 'payment', inflow: 1000, outflow: 0 },
        { src: 'opening_balance', inflow: 5000, outflow: 0 },
      ],
      dayBefore: DAY_BEFORE,
      start: START,
      end: END,
      opening: [],
      closing: [],
      period: [],
    });
    const svc = await makeService(query);
    const r = await svc.cashFlow('c1', START, END);

    expect(r.operating.total).toBe(1000);
    expect(r.financing.total).toBe(5000);
    expect(r.netChange).toBe(6000);
    expect(r.beginningCash).toBe(100);
    expect(r.endingCash).toBe(6100);
  });
});

/**
 * A dated statement is computed by filtering general_ledger inside a LEFT
 * JOIN — `g.date >= $2 AND g.date <= $3`. Hand that an undefined bound and the
 * join condition is never true, so every account comes back with dr = 0 and
 * cr = 0: a complete, well-formed, entirely empty set of books, returned with
 * a 200 and nothing to say why. That is the failure worth a test, because
 * nothing about it looks like a failure.
 *
 * These assert on the ARGUMENTS reaching SQL, not just the totals. A report
 * that returns numbers for the wrong reason would still pass a totals-only
 * check.
 */
describe('ReportsService — a missing date range never blanks a statement', () => {
  const undatedCases: Array<
    [string, (svc: ReportsService) => Promise<unknown>]
  > = [
    [
      'profitLoss',
      (svc) => svc.profitLoss('c1', undefined as any, undefined as any),
    ],
    [
      'trialBalance',
      (svc) => svc.trialBalance('c1', undefined as any, undefined as any),
    ],
  ];

  it.each(undatedCases)(
    '%s still passes concrete dates to SQL',
    async (_name, run) => {
      const query = jest.fn(async () => PLAIN);
      await run(await makeService(query));

      const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
      const [, startDate, endDate] = params as [string, string, string];

      expect(startDate).toBe(REPORT_RANGE_DEFAULTS.startDate);
      expect(endDate).toBe(REPORT_RANGE_DEFAULTS.endDate);
      // The bug this guards against is a NULL/undefined reaching the BETWEEN.
      expect(startDate).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
      expect(endDate).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    },
  );

  it('gives an undated P&L the same numbers as an explicit all-time range', async () => {
    const dated = await (
      await makeService(jest.fn(async () => PLAIN))
    ).profitLoss(
      'c1',
      REPORT_RANGE_DEFAULTS.startDate,
      REPORT_RANGE_DEFAULTS.endDate,
    );
    const undated = await (
      await makeService(jest.fn(async () => PLAIN))
    ).profitLoss('c1', undefined as any, undefined as any);

    expect(undated).toEqual(dated);
    expect(undated.revenue).toBe(10000);
    expect(undated.netIncome).toBe(2000);
  });

  it('gives an undated trial balance real rows that still foot', async () => {
    // PLAIN nets to 2000 — it is a P&L fixture, not a whole ledger, so it does
    // NOT foot on its own. Balance it with the equity that a real set of books
    // would carry, otherwise "isBalanced" here would assert nothing.
    const BALANCED: GlRow[] = [
      ...PLAIN,
      gl('3000', 'Owner Equity', 'equity', 'Equity', 0, 2000),
    ];
    const svc = await makeService(jest.fn(async () => BALANCED));
    const tb = await svc.trialBalance('c1', undefined as any, undefined as any);

    expect(tb.rows.length).toBeGreaterThan(0);
    expect(tb.totalDebits).toBeGreaterThan(0);
    expect(tb.totalDebits).toBe(tb.totalCredits);
    expect(tb.isBalanced).toBe(true);
    expect(tb.range).toEqual({
      startDate: REPORT_RANGE_DEFAULTS.startDate,
      endDate: REPORT_RANGE_DEFAULTS.endDate,
    });
  });

  it('closes an undated balance sheet as of today, not on an undefined date', async () => {
    const query = jest.fn(async () => PLAIN);
    const svc = await makeService(query);
    await svc.balanceSheet('c1', undefined as any);

    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    const [, startDate, asOf] = params as [string, string, string];

    expect(startDate).toBe(REPORT_RANGE_DEFAULTS.startDate);
    expect(asOf).toBe(new Date().toISOString().slice(0, 10));
  });
});

/**
 * Telling a business its books do not balance when they do is worse than most
 * genuine defects: it sends someone hunting for an error that was never
 * posted. Warehouse Co hit this for real — a ledger balanced to the last unit
 * in the database (1,288,526.5650 on each side) reported Dr …56 against
 * Cr …57 and isBalanced: false.
 *
 * The cause is not the ledger. The two columns are summed from different sets
 * of floats in different orders, so they carry different accumulated error;
 * normally far below a paisa, but when the true total sits exactly on a
 * half-paisa boundary they land on OPPOSITE sides of it and round a full paisa
 * apart. So the verdict has to be taken before rounding, never after.
 */
describe('ReportsService — a balanced ledger never reports as unbalanced', () => {
  /**
   * Nets that sum to zero while landing the column totals on x.xx5 exactly.
   * Split across several accounts so the two reduce() calls really do
   * accumulate their error differently, which is the whole mechanism.
   */
  const ON_THE_BOUNDARY: GlRow[] = [
    gl('1000', 'Cash', 'asset', 'Cash', 1288526.565, 0),
    gl('1100', 'Accounts Receivable', 'asset', 'Receivable', 0.1, 0),
    gl('1200', 'Inventory', 'asset', 'Inventory', 0.2, 0),
    gl('4000', 'Sales Revenue', 'revenue', 'Sales', 0, 1288526.565),
    gl('2000', 'Accounts Payable', 'liability', 'Payable', 0, 0.3),
  ];

  it('foots a trial balance whose columns sit on a half-paisa boundary', async () => {
    const svc = await makeService(jest.fn(async () => ON_THE_BOUNDARY));
    const tb = await svc.trialBalance('c1', '2026-01-01', '2026-12-31');

    expect(tb.isBalanced).toBe(true);
    // And it must not PRINT a paisa of difference either: at the ledger's own
    // precision these are one number, so showing two is simply false.
    expect(tb.totalDebits).toBe(tb.totalCredits);
  });

  it('still reports a REAL imbalance, with both sides intact', async () => {
    const LOPSIDED: GlRow[] = [
      gl('1000', 'Cash', 'asset', 'Cash', 500, 0),
      gl('4000', 'Sales Revenue', 'revenue', 'Sales', 0, 400),
    ];
    const svc = await makeService(jest.fn(async () => LOPSIDED));
    const tb = await svc.trialBalance('c1', '2026-01-01', '2026-12-31');

    expect(tb.isBalanced).toBe(false);
    expect(tb.totalDebits).toBe(500);
    expect(tb.totalCredits).toBe(400);
  });

  /**
   * The balance sheet carries the period's earnings into equity, so that line
   * has to equal the P&L's bottom line exactly. profitLoss derives it through a
   * ROUNDED gross profit; the balance sheet used the shorter
   * r2(revenue - cogs - expense). Identical in exact arithmetic, a paisa apart
   * in floating point whenever the value lands on a half-paisa boundary — and a
   * balance sheet whose net income disagrees with the P&L is a reason to
   * distrust both statements.
   */
  it('carries the SAME net income into equity that the P&L reports', async () => {
    const rows: GlRow[] = [
      gl('1000', 'Cash', 'asset', 'Cash', 100000.005, 0),
      gl('4000', 'Sales Revenue', 'revenue', 'Sales', 0, 60000.005),
      gl('5000', 'Cost of Goods Sold', 'expense', 'Cost of Goods', 20000.0, 0),
      gl('6000', 'Rent Expense', 'expense', 'Operating', 10000.005, 0),
      gl('3000', 'Owner Equity', 'equity', 'Equity', 0, 70000.0),
    ];
    const pl = await (
      await makeService(jest.fn(async () => rows))
    ).profitLoss('c1', '2026-01-01', '2026-12-31');
    const bs = await (
      await makeService(jest.fn(async () => rows))
    ).balanceSheet('c1', '2026-12-31');
    const equityNetIncome = bs.equity
      .filter((e) => e.accountName.includes('Net Income'))
      .reduce((t, e) => t + e.amount, 0);

    expect(equityNetIncome).toBe(pl.netIncome);
  });

  it('balances a balance sheet whose sections round in different directions', async () => {
    // A = L + E exactly at full precision, with each section landing on a
    // boundary of its own.
    const BS: GlRow[] = [
      gl('1000', 'Cash', 'asset', 'Cash', 100000.005, 0),
      gl('2000', 'Accounts Payable', 'liability', 'Payable', 0, 50000.005),
      gl('3000', 'Owner Equity', 'equity', 'Equity', 0, 50000.0),
    ];
    const svc = await makeService(jest.fn(async () => BS));
    const bs = await svc.balanceSheet('c1', '2026-12-31');

    expect(bs.isBalanced).toBe(true);
  });
});

/**
 * Aging.
 *
 * `bucketAging` had no unit test at all before buckets became configurable,
 * which is why the UTC day-count bug below survived — at 30-day buckets it is
 * invisible, and there was nothing asserting the boundary.
 *
 * The property that matters most is the LAST one: re-bucketing must not change
 * `total`. Three CI suites tie AR aging's total to balance-sheet account 1100
 * and AP's to 2000, so a preset that moved the total would break the books
 * rather than the report.
 */
describe('ReportsService — aging', () => {
  const AR_SQL = 'FROM invoices i JOIN customers c';
  const PREF_SQL = 'report_preferences';

  /**
   * `days` overdue, as the YYYY-MM-DD the ::text cast returns.
   *
   * Built off businessToday() rather than Date.now(), because that is the
   * calendar the service ages against. Deriving these from the UTC day makes
   * the suite fail for the five hours a day when Karachi is already tomorrow —
   * which is the same off-by-one this bucketing was fixed to avoid, and a neat
   * demonstration of why the helper exists.
   */
  const dueDaysAgo = (days: number): string =>
    addDaysIso(businessToday(), -days);

  type OpenDoc = {
    customerId: string;
    customerName: string;
    balance: string;
    dueDate: string;
  };

  const makeQuery = (docs: OpenDoc[], prefs: unknown = null) =>
    jest.fn(async (sql: string) => {
      if (sql.includes(PREF_SQL)) return prefs === null ? [] : [{ prefs }];
      if (sql.includes(AR_SQL)) return docs;
      return [];
    });

  const oneDoc = (days: number, balance = '100'): OpenDoc[] => [
    {
      customerId: 'cust-1',
      customerName: 'Acme',
      balance,
      dueDate: dueDaysAgo(days),
    },
  ];

  it('defaults to the classic five columns and fills the legacy fields', async () => {
    const svc = await makeService(makeQuery(oneDoc(45)));
    const r: any = await svc.arAging('c1');

    expect(r.preset).toBe('monthly');
    expect(r.buckets.map((b: any) => b.label)).toEqual([
      'Current',
      '1–30',
      '31–60',
      '61–90',
      '91 and over',
    ]);
    // Both shapes describe the same money.
    expect(r.rows[0].amounts.d31to60).toBe(100);
    expect(r.rows[0].bucket31to60).toBe(100);
    expect(r.totals.total).toBe(100);
  });

  it('slices the same books into 3-day buckets on request', async () => {
    const svc = await makeService(makeQuery(oneDoc(5)));
    const r: any = await svc.arAging('c1', { preset: 'days3' });

    expect(r.preset).toBe('days3');
    expect(r.rows[0].amounts.d4to6).toBe(100);
    // …while the legacy fields stay on 30/60/90 for the clients that read them.
    expect(r.rows[0].bucket1to30).toBe(100);
    expect(r.rows[0].bucket31to60).toBe(0);
  });

  it('counts a document due today as Current, not one day overdue', async () => {
    // The old Math.floor((Date.now() - dueMidnightUTC)/86400000) read up to 5
    // hours short in Asia/Karachi and could age a same-day document by a whole
    // day. Invisible at 30-day buckets; a whole bucket at 3-day ones.
    const svc = await makeService(makeQuery(oneDoc(0)));
    const r: any = await svc.arAging('c1', { preset: 'days3' });

    expect(r.rows[0].amounts.current).toBe(100);
    expect(r.rows[0].current).toBe(100);
  });

  it('honours a saved company preference when the request names none', async () => {
    const svc = await makeService(
      makeQuery(oneDoc(10), { aging: { preset: 'weekly' } }),
    );
    const r: any = await svc.arAging('c1', {});

    expect(r.preset).toBe('weekly');
    expect(r.rows[0].amounts.d8to14).toBe(100);
  });

  it('lets an explicit request beat the saved preference', async () => {
    const svc = await makeService(
      makeQuery(oneDoc(10), { aging: { preset: 'weekly' } }),
    );
    const r: any = await svc.arAging('c1', { preset: 'monthly' });
    expect(r.preset).toBe('monthly');
  });

  it('rejects a malformed request with a coded 400', async () => {
    const svc = await makeService(makeQuery(oneDoc(10)));
    await expect(svc.arAging('c1', { buckets: '60,30' })).rejects.toMatchObject(
      {
        response: { code: 'INVALID_AGING_BUCKETS' },
      },
    );
  });

  it('falls back to the default when the SAVED preference is corrupt', async () => {
    // A bad saved value must not make the report unopenable — there would be no
    // way back in to fix it.
    const svc = await makeService(
      makeQuery(oneDoc(45), { aging: { preset: 'nonsense' } }),
    );
    const r: any = await svc.arAging('c1');
    expect(r.preset).toBe('monthly');
    expect(r.rows[0].amounts.d31to60).toBe(100);
  });

  it('survives the report_preferences column not existing yet', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes(PREF_SQL)) {
        const err: any = new Error(
          'column "report_preferences" does not exist',
        );
        err.code = '42703';
        throw err;
      }
      if (sql.includes(AR_SQL)) return oneDoc(45);
      return [];
    });
    const svc = await makeService(query);
    const r: any = await svc.arAging('c1');
    expect(r.preset).toBe('monthly');
    expect(r.totals.total).toBe(100);
  });

  it('keeps the total identical under every preset, and footed by both shapes', async () => {
    // The invariant three CI suites depend on: AR aging's total ties to
    // balance-sheet 1100, so re-slicing must never change it.
    const docs: OpenDoc[] = [
      {
        customerId: 'a',
        customerName: 'A',
        balance: '125.55',
        dueDate: dueDaysAgo(0),
      },
      {
        customerId: 'a',
        customerName: 'A',
        balance: '200.10',
        dueDate: dueDaysAgo(2),
      },
      {
        customerId: 'b',
        customerName: 'B',
        balance: '75.35',
        dueDate: dueDaysAgo(9),
      },
      {
        customerId: 'b',
        customerName: 'B',
        balance: '310.00',
        dueDate: dueDaysAgo(47),
      },
      {
        customerId: 'c',
        customerName: 'C',
        balance: '99.99',
        dueDate: dueDaysAgo(400),
      },
    ];
    const expected = 810.99;

    for (const preset of ['days3', 'weekly', 'biweekly', 'monthly'] as const) {
      const svc = await makeService(makeQuery(docs));
      const r: any = await svc.arAging('c1', { preset });

      expect(r.totals.total).toBeCloseTo(expected, 2);
      // The configurable columns foot to the total…
      const fromBuckets = r.buckets.reduce(
        (s: number, b: any) => s + r.totals.amounts[b.key],
        0,
      );
      expect(fromBuckets).toBeCloseTo(expected, 2);
      // …and so do the legacy five, on their own fixed boundaries.
      const fromLegacy =
        r.totals.current +
        r.totals.bucket1to30 +
        r.totals.bucket31to60 +
        r.totals.bucket61to90 +
        r.totals.bucket90Plus;
      expect(fromLegacy).toBeCloseTo(expected, 2);
      // Every row foots too.
      for (const row of r.rows) {
        const rowSum = r.buckets.reduce(
          (s: number, b: any) => s + row.amounts[b.key],
          0,
        );
        expect(rowSum).toBeCloseTo(row.total, 2);
      }
    }
  });

  it('ages payables off bills and vendors, not invoices', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes(PREF_SQL)) return [];
      if (sql.includes('FROM bills b JOIN vendors v')) {
        return [
          {
            customerId: 'v1',
            customerName: 'Vendor Co',
            balance: '500',
            dueDate: dueDaysAgo(95),
          },
        ];
      }
      return [];
    });
    const svc = await makeService(query);
    const r: any = await svc.apAging('c1');
    expect(r.rows[0].bucket90Plus).toBe(500);
    expect(r.totals.total).toBe(500);
  });
});

/**
 * Aging drill-down — one party's open documents.
 *
 * The property that carries this endpoint is the same one that carries the P&L
 * drill-down: what it returns must add up to the row it was opened from. A
 * detail that disagrees with its own row makes a correct report look wrong, and
 * a finance tool that shows figures which do not reconcile is worse than one
 * that shows fewer figures.
 *
 * So the fixture below feeds BOTH `arAging` and `arAgingPartyDocuments` from one
 * list of documents, and the tests compare the two against each other rather
 * than against numbers typed into the test.
 */
describe('ReportsService — aging party documents', () => {
  const dueDaysAgo = (days: number): string => addDaysIso(businessToday(), -days);

  type Doc = {
    id: string;
    number: string;
    /** Days overdue. Negative means not yet due. */
    days: number;
    balance: string;
    status?: string;
  };

  /** Captures every statement the service issues, so we can assert on the SQL. */
  const sqlSeen: string[] = [];

  const makeQuery = (docs: Doc[], prefs: unknown = null, party: unknown = { name: 'Acme' }) =>
    jest.fn(async (sql: string) => {
      sqlSeen.push(sql);
      if (sql.includes('report_preferences')) return prefs === null ? [] : [{ prefs }];
      // Party lookups. Distinct from the summary's `JOIN customers c ON …`.
      if (sql.includes('FROM customers c WHERE c.id')) return party === null ? [] : [party];
      if (sql.includes('FROM vendors v WHERE v.id')) return party === null ? [] : [party];
      // The drill-down. Checked before the summary because both name `invoices i`.
      if (sql.includes('i.customer_id = $2')) {
        return docs.map((d) => ({
          documentId: d.id,
          documentNumber: d.number,
          issueDate: dueDaysAgo(d.days + 30),
          dueDate: dueDaysAgo(d.days),
          total: d.balance,
          amountPaid: '0',
          balance: d.balance,
          status: d.status ?? 'sent',
        }));
      }
      // The summary, from the same documents.
      if (sql.includes('FROM invoices i JOIN customers c')) {
        return docs.map((d) => ({
          customerId: 'cust-1',
          customerName: 'Acme',
          balance: d.balance,
          dueDate: dueDaysAgo(d.days),
        }));
      }
      return [];
    });

  beforeEach(() => {
    sqlSeen.length = 0;
  });

  const SPREAD: Doc[] = [
    { id: 'i1', number: 'INV-1', days: -5, balance: '100' }, // not yet due
    { id: 'i2', number: 'INV-2', days: 10, balance: '200' }, // 1–30
    { id: 'i3', number: 'INV-3', days: 20, balance: '50' }, // 1–30
    { id: 'i4', number: 'INV-4', days: 45, balance: '300' }, // 31–60
    { id: 'i5', number: 'INV-5', days: 200, balance: '25' }, // 91+
  ];

  it('foots to the aging row total when no bucket is named', async () => {
    const svc = await makeService(makeQuery(SPREAD));
    const summary: any = await svc.arAging('c1');
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1');

    expect(detail.outstandingTotal).toBe(summary.rows[0].total);
    expect(detail.total).toBe(SPREAD.length);
    expect(detail.partyName).toBe('Acme');
    expect(detail.partyType).toBe('customer');
    expect(detail.partyId).toBe('cust-1');
  });

  it('foots to the aging row bucket when one is named', async () => {
    const svc = await makeService(makeQuery(SPREAD));
    const summary: any = await svc.arAging('c1');
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1', undefined, 'd1to30');

    // 200 + 50, and the row's own figure for that column, computed independently.
    expect(detail.outstandingTotal).toBe(summary.rows[0].amounts.d1to30);
    expect(detail.total).toBe(2);
    expect(detail.documents.map((d: any) => d.documentNumber)).toEqual(['INV-2', 'INV-3']);
  });

  it('every document reports the bucket its own row would have put it in', async () => {
    const svc = await makeService(makeQuery(SPREAD));
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1');
    const byNumber = Object.fromEntries(
      detail.documents.map((d: any) => [d.documentNumber, d.bucketKey]),
    );
    expect(byNumber).toEqual({
      'INV-1': 'current',
      'INV-2': 'd1to30',
      'INV-3': 'd1to30',
      'INV-4': 'd31to60',
      'INV-5': 'd91plus',
    });
  });

  it('asks the database for exactly the documents aging ages', async () => {
    // The regression guard. InvoicesService.outstandingForCustomer answers
    // almost this question with `status NOT IN ('draft','void')` — no `paid` —
    // and swapping it in here would make the detail disagree with its row for
    // any paid document still carrying a balance. The mock cannot execute a
    // WHERE clause, so this asserts the predicate the service actually sends,
    // and that it is character-identical to the summary's.
    const svc = await makeService(makeQuery(SPREAD));
    await svc.arAging('c1');
    await svc.arAgingPartyDocuments('c1', 'cust-1');

    const summarySql = sqlSeen.find((s) => s.includes('FROM invoices i JOIN customers c'))!;
    const detailSql = sqlSeen.find((s) => s.includes('i.customer_id = $2'))!;
    const predicate = /i\.balance::numeric > 0 AND i\.status NOT IN \('paid','void','draft'\)/;

    expect(summarySql).toMatch(predicate);
    expect(detailSql).toMatch(predicate);
  });

  it('re-buckets with the requested preset, not the company default', async () => {
    const svc = await makeService(makeQuery(SPREAD, { aging: { preset: 'monthly' } }));
    const detail: any = await svc.arAgingPartyDocuments(
      'c1', 'cust-1', { preset: 'days3' }, undefined,
    );

    expect(detail.preset).toBe('days3');
    // days3 is 3,6,9,12 → current, 1–3, 4–6, 7–9, 10–12, 13+. A document 10
    // days overdue sits mid-table here and in `1–30` under monthly: same money,
    // finer columns, which is the whole reason the preset is configurable.
    expect(detail.buckets.map((b: any) => b.key)).toContain('d13plus');
    const inv2 = detail.documents.find((d: any) => d.documentNumber === 'INV-2');
    expect(inv2.bucketKey).toBe('d10to12');
    expect(inv2.bucketLabel).toBe('10–12');
    // …and the oldest document has moved into the open-ended bucket.
    const inv5 = detail.documents.find((d: any) => d.documentNumber === 'INV-5');
    expect(inv5.bucketKey).toBe('d13plus');
  });

  it('counts a document due today as current, in calendar days', async () => {
    // The same boundary the summary suite guards: elapsed milliseconds read
    // short in Asia/Karachi and could age a same-day document by a whole day.
    const svc = await makeService(
      makeQuery([{ id: 'i1', number: 'INV-1', days: 0, balance: '100' }]),
    );
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1');
    expect(detail.documents[0].bucketKey).toBe('current');
    expect(detail.documents[0].daysOverdue).toBe(0);
  });

  it('separates 30 days overdue from 31', async () => {
    const svc = await makeService(
      makeQuery([
        { id: 'i1', number: 'INV-30', days: 30, balance: '10' },
        { id: 'i2', number: 'INV-31', days: 31, balance: '10' },
      ]),
    );
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1');
    const byNumber = Object.fromEntries(
      detail.documents.map((d: any) => [d.documentNumber, d.bucketKey]),
    );
    expect(byNumber['INV-30']).toBe('d1to30');
    expect(byNumber['INV-31']).toBe('d31to60');
  });

  it('reports a negative daysOverdue for a document that is not yet due', async () => {
    // Signed, so the client can say "due in 5 days" without recomputing.
    const svc = await makeService(makeQuery(SPREAD));
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1');
    const notDue = detail.documents.find((d: any) => d.documentNumber === 'INV-1');
    expect(notDue.daysOverdue).toBe(-5);
    expect(notDue.bucketKey).toBe('current');
  });

  it('paginates after filtering, and totals over everything that matched', async () => {
    const many: Doc[] = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
      number: `INV-${i}`,
      days: 10,
      balance: '100',
    }));
    const svc = await makeService(makeQuery(many));
    const detail: any = await svc.arAgingPartyDocuments(
      'c1', 'cust-1', undefined, 'd1to30', 1, 2,
    );

    expect(detail.documents).toHaveLength(2);
    expect(detail.total).toBe(5);
    // Money is over all five, not the two on this page — otherwise the panel
    // could not be reconciled against the row.
    expect(detail.outstandingTotal).toBe(500);
    expect(detail.page).toBe(1);
    expect(detail.limit).toBe(2);
  });

  it('clamps an absurd limit rather than trying to serve it', async () => {
    const svc = await makeService(makeQuery(SPREAD));
    const detail: any = await svc.arAgingPartyDocuments(
      'c1', 'cust-1', undefined, undefined, 1, 99999,
    );
    expect(detail.limit).toBe(200);
  });

  it('refuses a bucket key this report does not have', async () => {
    const svc = await makeService(makeQuery(SPREAD));
    // Not an empty list: an unknown key means the client and the spec have
    // drifted, and "nothing in this bucket" would hide that.
    await expect(
      svc.arAgingPartyDocuments('c1', 'cust-1', undefined, 'd4to6'),
    ).rejects.toMatchObject({
      response: { code: 'UNKNOWN_AGING_BUCKET' },
    });
  });

  it('refuses an unknown customer rather than reporting no debt', async () => {
    const svc = await makeService(makeQuery(SPREAD, null, null));
    await expect(svc.arAgingPartyDocuments('c1', 'nobody')).rejects.toMatchObject({
      response: { code: 'CUSTOMER_NOT_FOUND' },
    });
  });

  it('refuses an unknown vendor on the payables side', async () => {
    const svc = await makeService(makeQuery([], null, null));
    await expect(svc.apAgingPartyDocuments('c1', 'nobody')).rejects.toMatchObject({
      response: { code: 'VENDOR_NOT_FOUND' },
    });
  });

  it('names the payables side honestly rather than reusing the A/R field names', async () => {
    // The summary calls a vendor `customerName` for back-compat with shipped
    // clients. A new endpoint has none, so it does not inherit the lie.
    const svc = await makeService(makeQuery([], null, { name: 'Supplier Co' }));
    const detail: any = await svc.apAgingPartyDocuments('c1', 'vend-1');
    expect(detail.partyType).toBe('vendor');
    expect(detail.partyName).toBe('Supplier Co');
    expect(detail).not.toHaveProperty('customerName');
  });

  it('returns the bucket spec so the panel can label itself', async () => {
    const svc = await makeService(makeQuery(SPREAD));
    const summary: any = await svc.arAging('c1');
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1');
    // Identical, because both resolved it the same way. This is what stops the
    // detail's labels disagreeing with the column that was clicked.
    expect(detail.buckets).toEqual(summary.buckets);
    expect(detail.asOfDate).toBe(summary.asOfDate);
  });

  it('is empty, not broken, for a party with nothing open', async () => {
    const svc = await makeService(makeQuery([]));
    const detail: any = await svc.arAgingPartyDocuments('c1', 'cust-1');
    expect(detail.documents).toEqual([]);
    expect(detail.outstandingTotal).toBe(0);
    expect(detail.total).toBe(0);
  });

  /**
   * The envelope, driven for real.
   *
   * This is the bug that took the P&L drill-down down for months: naming the
   * rows `data` makes ResponseEnvelopeInterceptor lift the array into the
   * envelope slot and discard every sibling, so the client gets rows with no
   * `outstandingTotal`, no `partyName` and no `total`. A service-level test
   * never runs the interceptor, which is exactly why nobody saw it.
   *
   * So rather than trusting the field name by inspection, this pushes the real
   * service output through the real interceptor and checks the metadata is
   * still there on the other side. It needs no HTTP server, and it fails the
   * moment somebody renames `documents` to `data`.
   */
  it('survives the response envelope with its metadata intact', async () => {
    const svc = await makeService(makeQuery(SPREAD));
    const payload = await svc.arAgingPartyDocuments('c1', 'cust-1');

    const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
    const enveloped: any = await firstValueFrom(
      interceptor.intercept({} as ExecutionContext, {
        handle: () => of(payload),
      } as CallHandler),
    );

    expect(enveloped.success).toBe(true);
    // The rows arrived…
    expect(enveloped.data.documents).toHaveLength(SPREAD.length);
    // …and so did everything beside them.
    expect(enveloped.data.outstandingTotal).toBe(675);
    expect(enveloped.data.partyName).toBe('Acme');
    expect(enveloped.data.partyType).toBe('customer');
    expect(enveloped.data.total).toBe(SPREAD.length);
    expect(enveloped.data.buckets).toHaveLength(5);
    expect(enveloped.data.asOfDate).toBe(businessToday());
  });

  it('would have caught the P&L bug: a `data` key loses its siblings', async () => {
    // The counter-example, pinned so the reason for the field name cannot be
    // lost. If this ever stops being true the interceptor changed, and the
    // naming constraint above can be revisited.
    const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
    const enveloped: any = await firstValueFrom(
      interceptor.intercept({} as ExecutionContext, {
        handle: () => of({ data: [1, 2], outstandingTotal: 99 }),
      } as CallHandler),
    );
    expect(enveloped.data).toEqual([1, 2]);
    expect(enveloped.outstandingTotal).toBeUndefined();
    expect(enveloped.data.outstandingTotal).toBeUndefined();
  });
});

/**
 * P&L line drill-down.
 *
 * One property carries this endpoint: the entries it returns must add up to
 * the figure on the line the user tapped. A drill-down that disagrees with its
 * own total is worse than none — it makes a correct statement look wrong.
 */
describe('ReportsService — statementLineEntries', () => {
  const ACCOUNT_SQL = 'FROM accounts a';
  const COUNT_SQL = 'COUNT(*)::int AS cnt';
  const ROWS_SQL = 'g.source_type AS "sourceType"';

  type GlEntry = {
    debit: string;
    credit: string;
    sourceType?: string;
    id?: string;
  };

  const makeQuery = (
    account: { accountType: string; accountCode?: string } | null,
    entries: GlEntry[],
  ) =>
    jest.fn(async (sql: string) => {
      if (sql.includes(ACCOUNT_SQL)) {
        return account
          ? [
              {
                id: 'acct-1',
                accountCode: account.accountCode ?? '4000',
                accountName: 'Sales Revenue',
                accountType: account.accountType,
                subType: null,
              },
            ]
          : [];
      }
      if (sql.includes(COUNT_SQL)) {
        return [
          {
            cnt: entries.length,
            dr: entries.reduce((t, x) => t + Number(x.debit), 0).toFixed(4),
            cr: entries.reduce((t, x) => t + Number(x.credit), 0).toFixed(4),
          },
        ];
      }
      if (sql.includes(ROWS_SQL)) {
        return entries.map((x, i) => ({
          id: x.id ?? `gl-${i}`,
          date: '2026-04-0'.concat(String(i + 1)),
          reference: `JE-${i + 1}`,
          memo: 'memo',
          debit: x.debit,
          credit: x.credit,
          sourceType: x.sourceType ?? 'invoice',
          sourceId: `src-${i}`,
        }));
      }
      return [];
    });

  it('signs a revenue account credit-normal, so its entries foot to the line', async () => {
    const entries = [
      { debit: '0', credit: '800.00' },
      { debit: '0', credit: '400.00' },
      { debit: '50.00', credit: '0' }, // a credit memo reducing revenue
    ];
    const svc = await makeService(
      makeQuery({ accountType: 'revenue' }, entries),
    );
    const r: any = await svc.statementLineEntries(
      'c1',
      '4000',
      '2026-01-01',
      '2026-12-31',
    );

    expect(r.lineAmount).toBe(1150);
    expect(r.entries.map((d: any) => d.amount)).toEqual([800, 400, -50]);
    expect(r.entries.reduce((t: number, d: any) => t + d.amount, 0)).toBeCloseTo(
      r.lineAmount,
      2,
    );
  });

  it('signs an expense account debit-normal', async () => {
    const entries = [
      { debit: '9000.00', credit: '0' },
      { debit: '0', credit: '1000.00' }, // a vendor credit reducing the expense
    ];
    const svc = await makeService(
      makeQuery({ accountType: 'expense', accountCode: '6100' }, entries),
    );
    const r: any = await svc.statementLineEntries(
      'c1',
      '6100',
      '2026-01-01',
      '2026-12-31',
    );

    expect(r.lineAmount).toBe(8000);
    expect(r.entries.map((d: any) => d.amount)).toEqual([9000, -1000]);
  });

  it('names the document behind each row rather than calling everything a journal entry', async () => {
    // The reason this reads general_ledger and not journal_entry_lines: that
    // table has no source link and labels every row 'journal_entry'.
    const svc = await makeService(
      makeQuery({ accountType: 'expense', accountCode: '5000' }, [
        { debit: '500', credit: '0', sourceType: 'bill' },
        { debit: '300', credit: '0', sourceType: 'delivery_approval' },
        { debit: '100', credit: '0', sourceType: 'something_new' },
      ]),
    );
    const r: any = await svc.statementLineEntries(
      'c1',
      '5000',
      '2026-01-01',
      '2026-12-31',
    );

    expect(r.entries.map((d: any) => d.sourceLabel)).toEqual([
      'Bill',
      'Delivery approval',
      'Journal entry', // an unmapped type degrades to the generic noun
    ]);
    // Every row stays drillable — sourceId is what the client opens.
    expect(r.entries.every((d: any) => !!d.sourceId)).toBe(true);
  });

  it('reports lineAmount over the whole range, not just the page', async () => {
    const entries = Array.from({ length: 5 }, () => ({
      debit: '0',
      credit: '100.00',
    }));
    const query = makeQuery({ accountType: 'revenue' }, entries);
    const svc = await makeService(query);
    const r: any = await svc.statementLineEntries(
      'c1',
      '4000',
      '2026-01-01',
      '2026-12-31',
      1,
      2,
    );

    // The aggregate is unpaginated even though the rows are.
    expect(r.lineAmount).toBe(500);
    expect(r.total).toBe(5);
    expect(r.limit).toBe(2);

    const [, params] = query.mock.calls.find(([sql]) =>
      (sql as string).includes(ROWS_SQL),
    ) as unknown as [string, unknown[]];
    expect(params[4]).toBe(2); // LIMIT
    expect(params[5]).toBe(0); // OFFSET
  });

  it('clamps an absurd page size instead of letting a client ask for the whole ledger', async () => {
    const query = makeQuery({ accountType: 'revenue' }, []);
    const svc = await makeService(query);
    const r: any = await svc.statementLineEntries(
      'c1',
      '4000',
      '2026-01-01',
      '2026-12-31',
      0,
      100000,
    );
    expect(r.limit).toBe(200);
    expect(r.page).toBe(1);
  });

  it('says the account does not exist rather than returning an empty, reassuring list', async () => {
    const svc = await makeService(makeQuery(null, []));
    await expect(
      svc.statementLineEntries('c1', '9999', '2026-01-01', '2026-12-31'),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
  });

  it('defaults a missing range to all time rather than filtering on NULL', async () => {
    const query = makeQuery({ accountType: 'revenue' }, []);
    const svc = await makeService(query);
    await svc.statementLineEntries('c1', '4000', '', '');

    const [, params] = query.mock.calls.find(([sql]) =>
      (sql as string).includes(COUNT_SQL),
    ) as unknown as [string, unknown[]];
    expect(params[2]).toBe(REPORT_RANGE_DEFAULTS.startDate);
    expect(params[3]).toBe(REPORT_RANGE_DEFAULTS.endDate);
  });
});

/**
 * Inventory value and stock history.
 *
 * Both series carry forward across months with no activity, which is the part
 * that goes wrong quietly: a month with no movement must repeat the previous
 * close, not read zero. A zero there looks like the warehouse emptied.
 */
describe('ReportsService — inventory history', () => {
  /** 'YYYY-MM' of `back` months before the current business month. */
  const monthsAgo = (back: number): string => {
    const [y, m] = businessToday().slice(0, 7).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  describe('inventoryValuationTrend', () => {
    const makeQuery = (nets: { period: string; net: string }[]) =>
      jest.fn(async () => nets);

    it('reports a closing balance, carrying quiet months forward', async () => {
      const svc = await makeService(
        makeQuery([
          { period: monthsAgo(3), net: '1000' },
          { period: monthsAgo(1), net: '250' },
        ]),
      );
      const r: any = await svc.inventoryValuationTrend('c1', 4);

      // months: -3 -2 -1 0  →  1000, 1000 (quiet), 1250, 1250 (quiet)
      expect(r.points.map((p: any) => p.value)).toEqual([
        1000, 1000, 1250, 1250,
      ]);
      expect(r.points).toHaveLength(4);
    });

    it('opens on everything posted before the window, not on zero', async () => {
      const svc = await makeService(
        makeQuery([
          { period: monthsAgo(24), net: '5000' }, // long before the window
          { period: monthsAgo(1), net: '100' },
        ]),
      );
      const r: any = await svc.inventoryValuationTrend('c1', 3);
      // A company with old stock does not start the chart at nothing.
      expect(r.points[0].value).toBe(5000);
      expect(r.points[2].value).toBe(5100);
    });

    it('gives every point a month-end as-of date', async () => {
      const svc = await makeService(makeQuery([]));
      const r: any = await svc.inventoryValuationTrend('c1', 12);
      expect(r.points).toHaveLength(12);
      for (const p of r.points) {
        expect(p.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Month-end, so the balance is a close rather than a mid-month cut.
        const [yy, mm, dd] = p.asOfDate.split('-').map(Number);
        expect(dd).toBe(new Date(Date.UTC(yy, mm, 0)).getUTCDate());
      }
    });

    it('clamps an absurd window', async () => {
      const svc = await makeService(makeQuery([]));
      expect(
        ((await svc.inventoryValuationTrend('c1', 9999)) as any).months,
      ).toBe(60);
      expect(((await svc.inventoryValuationTrend('c1', 0)) as any).months).toBe(
        12,
      );
    });
  });

  describe('inventoryItemHistory', () => {
    const ITEM = { id: 'i1', name: 'Engine Oil 5L', sku: 'WC-OIL-5L', quantityOnHand: '0', unitCost: '0' };

    async function makeItemService(rows: any[], found = true, onHand = '0') {
      const query = jest.fn(async () => rows);
      const repo = {} as never;
      const itemRepo = {
        find: jest.fn(async () => (found ? [{ ...ITEM, quantityOnHand: onHand }] : [])),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          ReportsService,
          { provide: DataSource, useValue: { query } },
          { provide: getRepositoryToken(Invoice), useValue: repo },
          { provide: getRepositoryToken(Bill), useValue: repo },
          { provide: getRepositoryToken(InventoryItem), useValue: itemRepo },
          { provide: getRepositoryToken(InventoryMovement), useValue: repo },
          { provide: getRepositoryToken(Delivery), useValue: repo },
          { provide: getRepositoryToken(TaxPayment), useValue: repo },
        ],
      }).compile();
      return moduleRef.get(ReportsService);
    }

    it('walks back from the quantity on hand, carrying quiet months forward', async () => {
      const svc = await makeItemService(
        [
          { period: monthsAgo(3), qty_in: '40', qty_out: '0' },
          { period: monthsAgo(1), qty_in: '0', qty_out: '15' },
        ],
        true,
        '25',
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      expect(r.points.map((p: any) => p.closingQty)).toEqual([40, 40, 25, 25]);
      expect(r.points.map((p: any) => p.qtyOut)).toEqual([0, 0, 15, 0]);
    });

    it('leaves months before the item ever moved as null, not zero', async () => {
      // null is "this item did not exist yet"; 0 is "it existed and was out of
      // stock". A chart that cannot tell them apart invents a stockout.
      const svc = await makeItemService(
        [{ period: monthsAgo(1), qty_in: '10', qty_out: '0' }],
        true,
        '10',
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      expect(r.points.map((p: any) => p.closingQty)).toEqual([
        null,
        null,
        10,
        10,
      ]);
    });

    it('opens on stock bought before the window and never touched since', async () => {
      const svc = await makeItemService(
        [{ period: monthsAgo(30), qty_in: '72', qty_out: '0' }],
        true,
        '72',
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 3);
      expect(r.points.map((p: any) => p.closingQty)).toEqual([72, 72, 72]);
    });

    it('declines to guess a value it cannot know', async () => {
      const svc = await makeItemService(
        [{ period: monthsAgo(0), qty_in: '10', qty_out: '0' }],
        true,
        '10',
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 2);

      // Pricing a past quantity at today's mutable average would be plausible
      // and wrong. With no cost horizon (no `since` on the rows) nothing is
      // claimed, and the response says so.
      expect(r.points.every((p: any) => p.closingValue === null)).toBe(true);
      expect(r.points.every((p: any) => p.valueKnown === false)).toBe(true);
      expect(r.coverage.quantity).toBe('exact');
      expect(r.coverage.value).toBe('unavailable');
    });

    it("404s on an item that is not this company's", async () => {
      const svc = await makeItemService([], false);
      await expect(
        svc.inventoryItemHistory('c1', 'nope', 12),
      ).rejects.toMatchObject({
        response: { code: 'ITEM_NOT_FOUND' },
      });
    });
  });
});

describe('ReportsService — item explorer', () => {
  /** 'YYYY-MM' of `back` months before the current business month. */
  const monthsAgo = (back: number): string => {
    const [y, m] = businessToday().slice(0, 7).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const ITEM = {
    id: 'i1',
    name: 'Engine Oil 5L',
    sku: 'WC-OIL-5L',
    category: 'Lubricants',
    unitOfMeasure: 'can',
    unitCost: '10.0000',
    sellingPrice: '14.0000',
    quantityOnHand: '25.0000',
    reorderPoint: '30.0000',
    isActive: true,
  };

  /**
   * A DataSource whose answer depends on which query was asked — these
   * methods run several, and a single canned answer would feed month rows to
   * the customer query.
   */
  const routed = (routes: [RegExp, unknown[]][]) =>
    jest.fn(async (sql: string, _params?: unknown[]) => {
      for (const [re, rows] of routes) if (re.test(sql)) return rows;
      return [];
    });

  async function makeItemService(query: jest.Mock, found = true) {
    const repo = {} as never;
    const itemRepo = { find: jest.fn(async () => (found ? [ITEM] : [])) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: DataSource, useValue: { query } },
        { provide: getRepositoryToken(Invoice), useValue: repo },
        { provide: getRepositoryToken(Bill), useValue: repo },
        { provide: getRepositoryToken(InventoryItem), useValue: itemRepo },
        { provide: getRepositoryToken(InventoryMovement), useValue: repo },
        { provide: getRepositoryToken(Delivery), useValue: repo },
        { provide: getRepositoryToken(TaxPayment), useValue: repo },
      ],
    }).compile();
    return moduleRef.get(ReportsService);
  }

  describe('inventoryItemHistory — month-end value', () => {
    const since = `${monthsAgo(6)}-01`;

    it('walks back from today, so the latest close is qty × average cost', async () => {
      // 25 on hand at 10 today = 250. Last month 15 went out (−150), three
      // months ago 40 came in (+400).
      const svc = await makeItemService(
        jest.fn(async () => [
          { period: monthsAgo(3), closing: '40', qty_in: '40', qty_out: '0', value_net: '400', value_missing: false, since },
          { period: monthsAgo(1), closing: '25', qty_in: '0', qty_out: '15', value_net: '-150', value_missing: false, since },
        ]),
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      expect(r.points.map((p: any) => p.closingValue)).toEqual([400, 400, 250, 250]);
      expect(r.points.every((p: any) => p.valueKnown)).toBe(true);
      expect(r.coverage.value).toBe('exact');
      expect(r.coverage.message).toBe('');
    });

    it('ends on the quantity on hand even when entries were typed out of order', async () => {
      // The old snapshot read would have closed this month on whatever the
      // last-DATED movement's running balance was; the walk cannot miss.
      const svc = await makeItemService(
        jest.fn(async () => [
          { period: monthsAgo(0), qty_in: '0', qty_out: '4', value_net: '-40', value_missing: false, since },
        ]),
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 1);
      expect(r.points[0].closingQty).toBe(25);
      expect(r.points[0].closingValue).toBe(250);
    });

    it('claims nothing for a month that ended before the cost horizon', async () => {
      const horizon = `${monthsAgo(1)}-01`;
      const svc = await makeItemService(
        jest.fn(async () => [
          { period: monthsAgo(3), closing: '40', qty_in: '40', qty_out: '0', value_net: '400', value_missing: false, since: horizon },
          { period: monthsAgo(1), closing: '25', qty_in: '0', qty_out: '15', value_net: '-150', value_missing: false, since: horizon },
        ]),
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      // Months −3 and −2 closed before the horizon: the quantity is still
      // exact, the value is not claimed.
      expect(r.points.map((p: any) => p.closingQty)).toEqual([40, 40, 25, 25]);
      expect(r.points.map((p: any) => p.closingValue)).toEqual([null, null, 250, 250]);
      expect(r.coverage.value).toBe('partial');
      expect(r.coverage.costHistoryFrom).toBe(horizon);
      expect(r.coverage.message).toContain(horizon);
    });

    it('stops the walk at a movement that carries no value', async () => {
      const svc = await makeItemService(
        jest.fn(async () => [
          { period: monthsAgo(3), closing: '40', qty_in: '40', qty_out: '0', value_net: '400', value_missing: false, since },
          { period: monthsAgo(1), closing: '25', qty_in: '0', qty_out: '15', value_net: '0', value_missing: true, since },
        ]),
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      // Everything before the unvalued movement would be off by whatever it
      // moved, so none of it is claimed.
      expect(r.points.map((p: any) => p.valueKnown)).toEqual([false, false, true, true]);
      expect(r.points[0].closingValue).toBeNull();
    });

    it('reports a back-dated sale as stock below zero, with a value to match', async () => {
      // Received 40 in month −1 and sold 8 on an invoice dated month −3,
      // entered after the receipt. By document date the item was 8 short
      // until the receipt — which the chart says, quantity and value alike,
      // rather than borrowing a running balance typed in a different order.
      const svc = await makeItemService(
        jest.fn(async () => [
          { period: monthsAgo(3), closing: '32', qty_in: '0', qty_out: '8', value_net: '-80', value_missing: false, since },
          { period: monthsAgo(1), closing: '32', qty_in: '40', qty_out: '0', value_net: '400', value_missing: false, since },
        ]),
      );
      // 32 on hand at 10 = 320 today.
      (svc as any).itemRepo.find = jest.fn(async () => [{ ...ITEM, quantityOnHand: '32' }]);
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      expect(r.points.map((p: any) => p.closingQty)).toEqual([-8, -8, 32, 32]);
      expect(r.points.map((p: any) => p.closingValue)).toEqual([-80, -80, 320, 320]);
      expect(r.coverage.value).toBe('exact');
      expect(r.coverage.message).toMatch(/below zero at the end of/);
    });

    it('declines every value when the company has no horizon at all', async () => {
      const svc = await makeItemService(
        jest.fn(async () => [
          { period: monthsAgo(0), closing: '10', qty_in: '10', qty_out: '0', value_net: '100', value_missing: false, since: null },
        ]),
      );
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 2);
      expect(r.points.every((p: any) => p.closingValue === null)).toBe(true);
      expect(r.coverage.value).toBe('unavailable');
    });

    it('covers the whole months of a range when given one', async () => {
      const svc = await makeItemService(jest.fn(async () => []));
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 12, {
        startDate: '2025-11-15',
        endDate: '2026-02-03',
      });
      expect(r.points.map((p: any) => p.period)).toEqual([
        '2025-11',
        '2025-12',
        '2026-01',
        '2026-02',
      ]);
      expect(r.months).toBe(4);
    });
  });

  describe('itemPerformance — facts and customers', () => {
    const MONTH = { period: monthsAgo(0), units: '6', revenue: '600', cogs: '360', est_cogs: '0', cost_missing: false };
    const CUSTOMERS = [
      { customerId: 'k1', customerName: 'Acme Ltd', units: '3', revenue: '300', cogs: '180' },
      { customerId: 'k2', customerName: 'Beta', units: '1', revenue: '100', cogs: '60' },
      { customerId: 'k3', customerName: 'Gamma', units: '1', revenue: '80', cogs: '60' },
      { customerId: 'k4', customerName: 'Delta', units: '0.5', revenue: '60', cogs: '30' },
      { customerId: 'k5', customerName: 'Epsilon', units: '0.3', revenue: '40', cogs: '20' },
      { customerId: 'k6', customerName: '', units: '0.2', revenue: '20', cogs: '10' },
    ];

    const makeQuery = () =>
      routed([
        [/GROUP BY period\s/, [MONTH]],
        [/"customerName"/, CUSTOMERS],
        [/last_sold/, [{ since: '2026-04-08', last_sold: '2026-09-21' }]],
      ]);

    it('states the item as it stands today', async () => {
      const svc = await makeItemService(makeQuery());
      const r: any = await svc.itemPerformance('c1', 'i1', `${monthsAgo(0)}-01`, businessToday());

      expect(r.item).toEqual({
        category: 'Lubricants',
        unitOfMeasure: 'can',
        sellingPrice: 14,
        unitCost: 10,
        qtyOnHand: 25,
        stockValue: 250,
        reorderPoint: 30,
        isActive: true,
        lastSoldDate: '2026-09-21',
      });
      expect(r.costHistoryFrom).toBe('2026-04-08');
      expect(r.totals.revenue).toBe(600);
    });

    it('names the top five customers and folds the rest', async () => {
      const svc = await makeItemService(makeQuery());
      const r: any = await svc.itemPerformance('c1', 'i1', `${monthsAgo(0)}-01`, businessToday());

      expect(r.customers.map((c: any) => c.customerName)).toEqual([
        'Acme Ltd',
        'Beta',
        'Gamma',
        'Delta',
        'Epsilon',
      ]);
      expect(r.customers[0]).toMatchObject({ unitsSold: 3, revenue: 300, grossProfit: 120 });
      expect(r.otherCustomers).toEqual({ count: 1, unitsSold: 0.2, revenue: 20, grossProfit: 10 });
    });

    it('asks for revenue net of the invoice discount', async () => {
      const query = makeQuery();
      const svc = await makeItemService(query);
      await svc.itemPerformance('c1', 'i1', `${monthsAgo(0)}-01`, businessToday());

      // The ledger credits 4000 with subtotal − discount; a line that ignored
      // the discount would overstate every item on a discounted invoice.
      const monthSql = query.mock.calls.find(([sql]) => /GROUP BY period\s/.test(sql))![0];
      expect(monthSql).toMatch(/discount_amount/);
      expect(monthSql).toMatch(/i\.subtotal::numeric > 0/);
    });

    it("404s on an item that is not this company's", async () => {
      const svc = await makeItemService(makeQuery(), false);
      await expect(svc.itemPerformance('c1', 'nope', '2026-01-01', '2026-01-31')).rejects.toMatchObject({
        response: { code: 'ITEM_NOT_FOUND' },
      });
    });
  });

  describe('itemSalesEntries', () => {
    const ROWS = [
      { date: '2026-09-20', docType: 'credit_memo', docId: 'cm1', docNumber: 'CM-0003', customerId: 'k1', customerName: 'Acme Ltd', lineId: 'l3', units: '-1', revenue: '-100', cogs: '-60', costBasis: 'exact', costMissing: false },
      { date: '2026-09-18', docType: 'invoice', docId: 'in2', docNumber: 'INV-0009', customerId: 'k1', customerName: 'Acme Ltd', lineId: 'l2', units: '2', revenue: '180', cogs: '120', costBasis: 'posted', costMissing: false },
      { date: '2026-09-02', docType: 'delivery', docId: 'in1', docNumber: 'INV-0007', customerId: null, customerName: '', lineId: 'l1', units: '3', revenue: '300', cogs: '180', costBasis: 'delivery', costMissing: false },
    ];

    const makeQuery = () =>
      routed([
        [/COUNT\(\*\)::int AS total/, [{ total: 42, units: '4', revenue: '380', cogs: '240' }]],
        [/LIMIT \$5 OFFSET \$6/, ROWS],
      ]);

    it('lists each line with its document, price and margin', async () => {
      const svc = await makeItemService(makeQuery());
      const r: any = await svc.itemSalesEntries('c1', 'i1', '2026-09-01', '2026-09-30');

      expect(r.entries[1]).toMatchObject({
        docType: 'invoice',
        docNumber: 'INV-0009',
        units: 2,
        unitPrice: 90,
        revenue: 180,
        cogs: 120,
        grossProfit: 60,
        marginPct: 33.33,
      });
      // A return reads at the price it was credited at, and has no margin of
      // its own to speak of.
      expect(r.entries[0]).toMatchObject({ units: -1, unitPrice: 100, marginPct: null });
      expect(r.entries[2].customerName).toBe('(no customer)');
      expect(r.totals).toEqual({ unitsSold: 4, revenue: 380, cogs: 240, grossProfit: 140 });
      expect(r.total).toBe(42);
    });

    it('pages by LIMIT/OFFSET and clamps an absurd page size', async () => {
      const query = makeQuery();
      const svc = await makeItemService(query);
      const r: any = await svc.itemSalesEntries('c1', 'i1', '2026-09-01', '2026-09-30', 3, 5000);

      expect(r.limit).toBe(100);
      expect(r.page).toBe(3);
      const pageCall = query.mock.calls.find(([sql]) => /LIMIT \$5/.test(sql))!;
      expect(pageCall[1]!.slice(4)).toEqual([100, 200]);
    });

    it('keeps its rows under `entries`, never `data`', async () => {
      // The response envelope lifts a `data` key and drops every sibling —
      // which is how the P&L drill-down once shipped empty.
      const svc = await makeItemService(makeQuery());
      const r: any = await svc.itemSalesEntries('c1', 'i1', '2026-09-01', '2026-09-30');
      expect(r).not.toHaveProperty('data');
      expect(Array.isArray(r.entries)).toBe(true);
    });
  });

  describe('inventoryPerformance — ledger and last sale', () => {
    it('reports the control account beside the stock, and when each item last sold', async () => {
      const query = routed([
        [/WITH sales AS/, [
          { itemId: 'i1', itemName: 'Oil', sku: 'O', category: 'Lubricants', units: '0', revenue: '0', cogs: '0', est_cogs: '0', cost_missing: false, qtyOnHand: '25', unitCost: '10' },
        ]],
        [/AS "lastSold"/, [{ itemId: 'i1', lastSold: '2026-03-14' }]],
        [/account_number = '1200'/, [{ value: '245.5' }]],
      ]);
      const svc = await makeItemService(query);
      const r: any = await svc.inventoryPerformance('c1', '2026-09-01', '2026-09-30');

      expect(r.totals.stockValue).toBe(250);
      expect(r.totals.ledgerValue).toBe(245.5);
      expect(r.rows[0].lastSoldDate).toBe('2026-03-14');
      expect(r.rows[0].marginPct).toBeNull();
    });
  });
});
