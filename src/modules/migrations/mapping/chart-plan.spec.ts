import { DEFAULT_CHART_OF_ACCOUNTS } from '../../accounts/accounts.constants';
import { ChartPlan, planChart, PlanSourceAccount } from './chart-plan';

/** FinMatrix's default chart, as a fresh company has it. */
const CHART = DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
  id: `fm-${a.accountNumber}`,
  accountNumber: a.accountNumber,
  name: a.name,
  type: a.type,
  subType: a.subType,
  systemRole: a.systemRole ?? null,
}));

const src = (
  number: string,
  name: string,
  type: string | null = null,
  kind: string | null = null,
): PlanSourceAccount => ({ number, name, type, kind });
const plan = (
  sources: PlanSourceAccount[],
  decide: {
    roles?: Record<string, string>;
    accounts?: Record<string, string>;
  } = {},
) =>
  planChart(CHART, sources, {
    roleDecision: (r) => decide.roles?.[r],
    accountDecision: (k) => decide.accounts?.[k],
  });
/** Where a FinMatrix account (by its default number) ends up: number and name. */
const at = (p: ChartPlan, defaultNumber: string) => {
  const change = p.changes.find((c) => c.accountId === `fm-${defaultNumber}`);
  return {
    number: p.finalNumber.get(`fm-${defaultNumber}`),
    name:
      change?.toName ??
      CHART.find((a) => a.accountNumber === defaultNumber)!.name,
    change: change?.change ?? null,
  };
};

describe('the owner’s chart wins', () => {
  it('QuickBooks Desktop: Receivables takes 1200 and Inventory takes 1120 — a swap, nothing renumbered on the owner’s side', () => {
    const p = plan([
      src('1000', 'Checking', 'Asset', 'Bank'),
      src('1120', 'Inventory Asset', 'Asset', 'Inventory'),
      src('1200', 'Accounts Receivable', 'Asset', 'Accounts Receivable'),
      src('2000', 'Accounts Payable', 'Liability', 'Accounts Payable'),
    ]);
    expect(at(p, '1100')).toEqual({
      number: '1200',
      name: 'Accounts Receivable',
      change: 'adopt',
    });
    expect(at(p, '1200')).toEqual({
      number: '1120',
      name: 'Inventory Asset',
      change: 'adopt',
    });
    expect(at(p, '2000')).toEqual({
      number: '2000',
      name: 'Accounts Payable',
      change: null,
    });
    // The owner's checking account is the bank; FinMatrix's Cash steps off 1000.
    expect(at(p, '1010')).toMatchObject({
      number: '1000',
      name: 'Checking',
      change: 'adopt',
    });
    expect(at(p, '1000')).toMatchObject({ change: 'step_aside', name: 'Cash' });
    expect(at(p, '1000').number).not.toBe('1000');
    // Every owner number is used exactly as given.
    expect(new Set(p.finalNumber.values()).size).toBe(CHART.length);
  });

  it('Sage 50 UK default chart: debtors 1100, bank 1200, creditors 2100, VAT 2200, P&L reserve 3200, stock 1001', () => {
    const p = plan([
      src('0030', 'Office Equipment', 'Asset', 'Fixed Asset'),
      src('1001', 'Stock', 'Asset', 'Inventory'),
      src('1100', 'Debtors Control Account', 'Asset'),
      src('1200', 'Bank Current Account', 'Asset', 'Bank'),
      src('1230', 'Petty Cash', 'Asset', 'Cash'),
      src('2100', 'Creditors Control Account', 'Liability'),
      src('2200', 'Sales Tax Control Account', 'Liability', 'Tax Payable'),
      src('3000', 'Ordinary Shares', 'Equity', 'Owner Equity'),
      src('3200', 'Profit and Loss Account', 'Equity', 'Retained Earnings'),
      src('4000', 'Sales Type A', 'Revenue', 'Sales'),
      src('5000', 'Materials Purchased', 'Expense', 'Cost of Goods'),
      src('6000', 'Productive Labour', 'Expense', 'Operating'),
      src('7000', 'Gross Wages', 'Expense', 'Payroll'),
    ]);
    expect(at(p, '1100')).toMatchObject({
      number: '1100',
      name: 'Debtors Control Account',
    });
    expect(at(p, '1200')).toMatchObject({ number: '1001', name: 'Stock' });
    expect(at(p, '1010')).toMatchObject({
      number: '1200',
      name: 'Bank Current Account',
    });
    expect(at(p, '1000')).toMatchObject({ number: '1230', name: 'Petty Cash' });
    expect(at(p, '2000')).toMatchObject({
      number: '2100',
      name: 'Creditors Control Account',
    });
    expect(at(p, '2300')).toMatchObject({
      number: '2200',
      name: 'Sales Tax Control Account',
    });
    expect(at(p, '3100')).toMatchObject({
      number: '3200',
      name: 'Profit and Loss Account',
    });
    expect(at(p, '3000')).toMatchObject({
      number: '3000',
      name: 'Ordinary Shares',
    });
    expect(at(p, '4000')).toMatchObject({
      number: '4000',
      name: 'Sales Type A',
    });
    expect(at(p, '5000')).toMatchObject({
      number: '5000',
      name: 'Materials Purchased',
    });
    expect(at(p, '6200')).toMatchObject({
      number: '7000',
      name: 'Gross Wages',
    });
    // FinMatrix's Rent Expense is not Productive Labour: it steps aside.
    expect(at(p, '6000')).toMatchObject({
      change: 'step_aside',
      name: 'Rent Expense',
    });
    expect(at(p, '6000').number).not.toBe('6000');
  });

  it('the owner’s example: sales tax at 2100 in their books, 2300 in FinMatrix — FinMatrix’s moves to 2100 for good', () => {
    const p = plan([
      src('2100', 'Sales Tax Payable', 'Liability', 'Tax Payable'),
      src('2300', 'Accrued Expenses', 'Liability', 'Other Liability'),
    ]);
    expect(at(p, '2300')).toEqual({
      number: '2100',
      name: 'Sales Tax Payable',
      change: 'adopt',
    });
    // 2300 is now free for the owner's Accrued Expenses, created with its own number.
    expect(p.mergedInto.has('2300')).toBe(false);
    expect([...p.finalNumber.values()]).not.toContain('2300');
  });

  it('a FinMatrix account the owner does not have steps aside to the next free number', () => {
    const p = plan([
      src('6000', 'Productive Labour', 'Expense', 'Operating'),
      src('6001', 'Overtime', 'Expense', 'Operating'),
    ]);
    expect(at(p, '6000')).toEqual({
      number: '6002',
      name: 'Rent Expense',
      change: 'step_aside',
    });
  });

  it('two accounts that both look like Receivables: one is chosen, and the owner is asked', () => {
    const p = plan([
      src('1100', 'Trade Debtors', 'Asset', 'Accounts Receivable'),
      src('1150', 'Debtors', 'Asset', 'Accounts Receivable'),
    ]);
    const ar = p.roles.find((r) => r.role === 'accounts_receivable')!;
    expect(ar.unsure).toBe(true);
    expect(ar.candidates).toEqual(['1100', '1150']);
    expect(at(p, '1100').number).toBe('1100');
    // The owner picks the other one.
    const chosen = plan(
      [
        src('1100', 'Trade Debtors', 'Asset', 'Accounts Receivable'),
        src('1150', 'Debtors', 'Asset', 'Accounts Receivable'),
      ],
      { roles: { accounts_receivable: '1150' } },
    );
    expect(at(chosen, '1100')).toMatchObject({
      number: '1150',
      name: 'Debtors',
    });
    expect(
      chosen.roles.find((r) => r.role === 'accounts_receivable')!.unsure,
    ).toBe(false);
  });

  it('“keep FinMatrix’s own”: the owner’s account is created, FinMatrix’s steps aside if it must', () => {
    const p = plan([src('2300', 'GST Payable', 'Liability', 'Tax Payable')], {
      roles: { sales_tax_payable: 'keep' },
    });
    expect(p.mergedInto.has('2300')).toBe(false);
    expect(at(p, '2300')).toMatchObject({
      change: 'step_aside',
      name: 'Sales Tax Payable',
    });
  });

  it('the owner says an account goes into a FinMatrix account: that account becomes it', () => {
    const p = plan(
      [
        src('1050', 'Meezan Bank', 'Asset', 'Bank'),
        src('1060', 'HBL', 'Asset', 'Bank'),
      ],
      { accounts: { '1060': '1010' } },
    );
    expect(at(p, '1010')).toMatchObject({ number: '1060', name: 'HBL' });
    expect(p.mergedInto.has('1050')).toBe(false);
  });

  it('a source without numbers (FinMatrix numbered it): same numbers, the owner’s names', () => {
    const p = plan([
      src('1100', 'Accounts Receivable (A/R)', 'Asset', 'Accounts Receivable'),
      src('1200', 'Inventory Asset', 'Asset', 'Inventory'),
      src('18001', 'Checking', 'Asset', 'Bank'),
    ]);
    expect(at(p, '1100')).toEqual({
      number: '1100',
      name: 'Accounts Receivable (A/R)',
      change: 'adopt',
    });
    expect(at(p, '1200')).toEqual({
      number: '1200',
      name: 'Inventory Asset',
      change: 'adopt',
    });
    expect(at(p, '1010')).toMatchObject({ number: '18001', name: 'Checking' });
  });

  it('Peachtree’s five-digit chart: every system account takes Peachtree’s ID, nothing steps aside', () => {
    const p = plan([
      src('10200', 'Regular Checking Account', 'Asset', 'Bank'),
      src('11000', 'Accounts Receivable', 'Asset', 'Accounts Receivable'),
      src('12000', 'Inventory', 'Asset', 'Inventory'),
      src('20000', 'Accounts Payable', 'Liability', 'Accounts Payable'),
      src('23100', 'Sales Tax Payable', 'Liability', 'Tax Payable'),
      src('39005', 'Retained Earnings', 'Equity', 'Retained Earnings'),
      src('40000', 'Sales', 'Revenue', 'Sales'),
      src('50000', 'Cost of Goods Sold', 'Expense', 'Cost of Goods'),
    ]);
    expect(at(p, '1100').number).toBe('11000');
    expect(at(p, '1200').number).toBe('12000');
    expect(at(p, '2000').number).toBe('20000');
    expect(at(p, '2300').number).toBe('23100');
    expect(at(p, '3100').number).toBe('39005');
    expect(at(p, '1010').number).toBe('10200');
    expect(p.changes.filter((c) => c.change === 'step_aside')).toEqual([]);
  });

  it('the source’s own control wins over an account merely named like it (a real Peachtree chart)', () => {
    const p = plan([
      src('2000', 'Accounts Payable', 'Liability', 'Other Liability'),
      src('2100', 'Purchase Payable', 'Liability', 'Accounts Payable'),
    ]);
    expect(at(p, '2000')).toMatchObject({
      number: '2100',
      name: 'Purchase Payable',
      change: 'adopt',
    });
    expect(p.mergedInto.has('2000')).toBe(false);
  });

  it('an account named exactly as FinMatrix’s own outranks one that only looks like it', () => {
    const chart = CHART.filter((a) => a.systemRole !== 'customer_advances');
    const p = planChart(
      chart,
      [
        src('2400', 'Customer Deposits', 'Liability', 'Other Liability'),
        src(
          '28001',
          'Customer Advances (Unearned Revenue)',
          'Liability',
          'Other Liability',
        ),
      ],
      { roleDecision: () => undefined, accountDecision: () => undefined },
    );
    expect(p.newRoles.get('28001')).toBe('customer_advances');
    expect(p.newRoles.has('2400')).toBe(false);
  });

  it('a trial balance line with only a number is the FinMatrix account on that number', () => {
    const p = plan([{ number: '1100', name: null, type: null, kind: null }]);
    expect(p.mergedInto.get('1100')).toBe('fm-1100');
    expect(p.changes).toEqual([]);
  });

  it('is deterministic: the same files give the same plan', () => {
    const sources = [
      src('1200', 'Bank Current Account', 'Asset', 'Bank'),
      src('6000', 'Productive Labour', 'Expense', 'Operating'),
    ];
    expect(plan(sources).changes).toEqual(plan([...sources].reverse()).changes);
  });
});
