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
  gl('5400', 'Inventory Shrinkage – Damage', 'expense', 'Cost of Goods', 600, 0),
];

/**
 * A pre-existing adjustment, posted before the reason drove the account. 6400
 * stays an operating expense so historical entries keep reporting where they
 * were posted.
 */
const WITH_LEGACY_SHRINKAGE: GlRow[] = [
  ...PLAIN,
  gl('6400', 'Inventory Adjustment / Shrinkage', 'expense', 'Operating', 600, 0),
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
  const undatedCases: Array<[string, (svc: ReportsService) => Promise<unknown>]> = [
    ['profitLoss', (svc) => svc.profitLoss('c1', undefined as any, undefined as any)],
    ['trialBalance', (svc) => svc.trialBalance('c1', undefined as any, undefined as any)],
  ];

  it.each(undatedCases)('%s still passes concrete dates to SQL', async (_name, run) => {
    const query = jest.fn(async () => PLAIN);
    await run(await makeService(query));

    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    const [, startDate, endDate] = params as [string, string, string];

    expect(startDate).toBe(REPORT_RANGE_DEFAULTS.startDate);
    expect(endDate).toBe(REPORT_RANGE_DEFAULTS.endDate);
    // The bug this guards against is a NULL/undefined reaching the BETWEEN.
    expect(startDate).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(endDate).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('gives an undated P&L the same numbers as an explicit all-time range', async () => {
    const dated = await (await makeService(jest.fn(async () => PLAIN))).profitLoss(
      'c1',
      REPORT_RANGE_DEFAULTS.startDate,
      REPORT_RANGE_DEFAULTS.endDate,
    );
    const undated = await (await makeService(jest.fn(async () => PLAIN))).profitLoss(
      'c1',
      undefined as any,
      undefined as any,
    );

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
    const pl = await (await makeService(jest.fn(async () => rows))).profitLoss(
      'c1',
      '2026-01-01',
      '2026-12-31',
    );
    const bs = await (await makeService(jest.fn(async () => rows))).balanceSheet(
      'c1',
      '2026-12-31',
    );
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
