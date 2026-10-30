import { BadRequestException } from '@nestjs/common';
import { ReportsController } from './reports.controller';

/**
 * The edge of the v2 routes: what is refused before any SQL runs, and what a
 * CSV export is allowed to contain.
 */
describe('ReportsController — v2 validation and CSV', () => {
  const res = () => {
    const r: any = { headers: {} as Record<string, string> };
    r.json = jest.fn();
    r.send = jest.fn();
    r.setHeader = jest.fn((k: string, v: string) => (r.headers[k] = v));
    return r;
  };
  const svc: any = {
    balanceSheet: jest.fn(async () => ({
      asOfDate: '2026-10-26',
      assets: [],
      liabilities: [],
      equity: [],
      totalAssets: 1,
      totalLiabilities: 0,
      totalEquity: 1,
      isBalanced: true,
      fiscalYearStart: '2026-01-01',
      gap: 0,
      sections: [],
      subtotals: [],
      comparison: null,
      totalLiabilitiesAndEquity: 1,
    })),
    trialBalance: jest.fn(async () => ({
      range: {},
      rows: [],
      totalDebits: 0,
      totalCredits: 0,
      isBalanced: true,
    })),
    accountRegister: jest.fn(async () => ({})),
    accountMovement: jest.fn(async () => ({})),
    retainedEarnings: jest.fn(async () => ({})),
    cashFlowLineEntries: jest.fn(async () => ({})),
    toCsv: (rows: Record<string, unknown>[]) => Object.keys(rows[0]).join(','),
  };
  const ctrl = new ReportsController(svc, {} as any);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as BadRequestException).getResponse() as any;
    }
  };

  it('refuses a comparison date that is not before asOfDate', async () => {
    expect(
      (
        await code(
          ctrl.balanceSheet('c1', '2026-10-26', 'json', res(), '2026-10-26'),
        )
      )?.code,
    ).toBe('INVALID_COMPARE_DATE');
    expect(
      (
        await code(
          ctrl.balanceSheet('c1', '2026-10-26', 'json', res(), '2026-12-01'),
        )
      )?.code,
    ).toBe('INVALID_COMPARE_DATE');
    expect(
      (
        await code(
          ctrl.balanceSheet('c1', '2026-10-26', 'json', res(), '2026-02-30'),
        )
      )?.code,
    ).toBe('INVALID_DATE');
    expect(
      await code(
        ctrl.balanceSheet('c1', '2026-10-26', 'json', res(), '2025-12-31'),
      ),
    ).toBeNull();
  });

  it('leaves the balance sheet without compareTo exactly as lenient as before', async () => {
    // No comparison: the date is passed through as it always was.
    expect(
      await code(ctrl.balanceSheet('c1', '2026-10-26', 'json', res())),
    ).toBeNull();
  });

  it('refuses malformed dates on the new routes', async () => {
    expect(
      (
        await code(
          ctrl.accountRegister('c1', '1000', '2026-13-01', '2026-12-31'),
        )
      )?.code,
    ).toBe('INVALID_DATE');
    expect(
      (
        await code(
          ctrl.accountRegister('c1', '1000', '2026-12-31', '2026-01-01'),
        )
      )?.code,
    ).toBe('INVALID_RANGE');
    expect((await code(ctrl.retainedEarnings('c1', 'yesterday')))?.code).toBe(
      'INVALID_DATE',
    );
    expect(
      (
        await code(
          ctrl.cashFlowLineEntries('c1', 'op.customers', '2026-01-01', 'x'),
        )
      )?.code,
    ).toBe('INVALID_DATE');
    expect(
      (
        await code(
          ctrl.accountMovement(
            'c1',
            '4000',
            '2026-02-01',
            '2026-02-28',
            '2026-01-01',
          ),
        )
      )?.code,
    ).toBe('INVALID_RANGE');
  });

  it('refuses an unknown order, mode or account code', async () => {
    expect(
      (
        await code(
          ctrl.accountRegister('c1', '1000', '', '', 1, 50, 'sideways'),
        )
      )?.code,
    ).toBe('INVALID_ORDER');
    expect(
      (await code(ctrl.trialBalance('c1', '', '', 'json', res(), 'final')))
        ?.code,
    ).toBe('INVALID_MODE');
    expect(
      (await code(ctrl.accountRegister('c1', "1000'; --", '', '')))?.code,
    ).toBe('INVALID_ACCOUNT_CODE');
  });

  it('keeps the trial balance on its old path when no mode is given', async () => {
    svc.trialBalance.mockClear();
    await ctrl.trialBalance('c1', '', '', 'json', res());
    expect(svc.trialBalance).toHaveBeenCalledWith(
      'c1',
      '1970-01-01',
      '2999-12-31',
    );
  });

  it('passes includeZero through only as the literal true', async () => {
    svc.balanceSheet.mockClear();
    await ctrl.balanceSheet('c1', '2026-10-26', 'json', res(), undefined, 'true');
    expect(svc.balanceSheet).toHaveBeenLastCalledWith('c1', '2026-10-26', undefined, { includeZero: true });
    await ctrl.balanceSheet('c1', '2026-10-26', 'json', res(), undefined, '1');
    expect(svc.balanceSheet).toHaveBeenLastCalledWith('c1', '2026-10-26', undefined, { includeZero: false });

    svc.trialBalance.mockClear();
    await ctrl.trialBalance('c1', '2026-01-01', '2026-06-30', 'json', res(), 'closing', 'true');
    expect(svc.trialBalance).toHaveBeenLastCalledWith('c1', '2026-01-01', '2026-06-30', 'closing', {
      includeZero: true,
    });
  });

  it('hands the donut sizes to the cockpit', async () => {
    const kpi = { analytics: jest.fn(async () => ({})) };
    const withKpi = new ReportsController(svc, kpi as any);
    await withKpi.analytics('c1', '2026-01-01', '2026-06-30', '5', '5');
    expect(kpi.analytics).toHaveBeenLastCalledWith('c1', '2026-01-01', '2026-06-30', {
      expenseTop: 5,
      customerTop: 5,
    });
    await withKpi.analytics('c1');
    expect(kpi.analytics).toHaveBeenLastCalledWith('c1', undefined, undefined, {
      expenseTop: undefined,
      customerTop: undefined,
    });
    expect((await code(withKpi.analytics('c1', '', '', 'five')))?.code).toBe(
      'INVALID_TOP',
    );
  });

  it('exports exactly the old columns to CSV, whatever v2 added', async () => {
    const r = res();
    await ctrl.balanceSheet('c1', '2026-10-26', 'csv', r);
    expect(r.send).toHaveBeenCalledWith(
      'asOfDate,assets,liabilities,equity,totalAssets,totalLiabilities,totalEquity,isBalanced',
    );
  });
});
