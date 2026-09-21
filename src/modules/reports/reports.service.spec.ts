import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
    expect(r.data.map((d: any) => d.amount)).toEqual([800, 400, -50]);
    expect(r.data.reduce((t: number, d: any) => t + d.amount, 0)).toBeCloseTo(
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
    expect(r.data.map((d: any) => d.amount)).toEqual([9000, -1000]);
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

    expect(r.data.map((d: any) => d.sourceLabel)).toEqual([
      'Bill',
      'Delivery approval',
      'Journal entry', // an unmapped type degrades to the generic noun
    ]);
    // Every row stays drillable — sourceId is what the client opens.
    expect(r.data.every((d: any) => !!d.sourceId)).toBe(true);
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
    const ITEM = { id: 'i1', name: 'Engine Oil 5L', sku: 'WC-OIL-5L' };

    async function makeItemService(rows: any[], found = true) {
      const query = jest.fn(async () => rows);
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

    it('reads the snapshotted closing balance and carries quiet months forward', async () => {
      const svc = await makeItemService([
        { period: monthsAgo(3), closing: '40', qty_in: '40', qty_out: '0' },
        { period: monthsAgo(1), closing: '25', qty_in: '0', qty_out: '15' },
      ]);
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      expect(r.points.map((p: any) => p.closingQty)).toEqual([40, 40, 25, 25]);
      expect(r.points.map((p: any) => p.qtyOut)).toEqual([0, 0, 15, 0]);
    });

    it('leaves months before the item ever moved as null, not zero', async () => {
      // null is "this item did not exist yet"; 0 is "it existed and was out of
      // stock". A chart that cannot tell them apart invents a stockout.
      const svc = await makeItemService([
        { period: monthsAgo(1), closing: '10', qty_in: '10', qty_out: '0' },
      ]);
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 4);

      expect(r.points.map((p: any) => p.closingQty)).toEqual([
        null,
        null,
        10,
        10,
      ]);
    });

    it('opens on stock bought before the window and never touched since', async () => {
      const svc = await makeItemService([
        { period: monthsAgo(30), closing: '72', qty_in: '72', qty_out: '0' },
      ]);
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 3);
      expect(r.points.map((p: any) => p.closingQty)).toEqual([72, 72, 72]);
    });

    it('declines to guess a value it cannot know', async () => {
      const svc = await makeItemService([
        { period: monthsAgo(0), closing: '10', qty_in: '10', qty_out: '0' },
      ]);
      const r: any = await svc.inventoryItemHistory('c1', 'i1', 2);

      // Pricing a past quantity at today's mutable average would be plausible
      // and wrong. Until cost is captured per movement, this says so.
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
