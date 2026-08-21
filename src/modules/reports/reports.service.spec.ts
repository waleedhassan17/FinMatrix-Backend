import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReportsService } from './reports.service';
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
