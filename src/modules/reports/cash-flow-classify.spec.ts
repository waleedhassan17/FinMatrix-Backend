import {
  CASH_FLOW_LINES,
  classifyPosting,
  nonCashShares,
  cashRowShare,
  type LedgerRow,
  type Posting,
} from './cash-flow-classify';

let seq = 0;
const row = (
  accountCode: string,
  type: string,
  subType: string,
  amount: number,
): LedgerRow => ({
  id: `r${++seq}`,
  accountCode,
  type,
  subType,
  amount,
  isCash: subType === 'Cash' || subType === 'Bank',
});
const posting = (sourceType: string, rows: LedgerRow[]): Posting => ({
  reference: `JE-${++seq}`,
  date: '2026-03-01',
  sourceType,
  sourceId: 'x',
  rows,
});

const CASH = (amt: number) => row('1000', 'asset', 'Cash', amt);
const BANK = (amt: number) => row('1010', 'asset', 'Bank', amt);
const byLine = (p: ReturnType<typeof classifyPosting>) =>
  Object.fromEntries(
    p.allocations.map((a) => [a.lineKey, Math.round(a.amount * 100) / 100]),
  );
const sum = (p: ReturnType<typeof classifyPosting>) =>
  p.allocations.reduce((t, a) => t + a.amount, 0);

describe('classifyPosting — by counterpart', () => {
  it('sends a fixed-asset purchase paid in cash to investing', () => {
    const r = classifyPosting(
      posting('journal_entry', [
        row('1500', 'asset', 'Fixed Asset', 50000),
        CASH(-50000),
      ]),
    );
    expect(byLine(r)).toEqual({ 'inv.fixed_assets': -50000 });
  });

  it('sends loan proceeds and repayments to financing', () => {
    const r = classifyPosting(
      posting('journal_entry', [
        BANK(200000),
        row('2700', 'liability', 'Notes Payable', -200000),
      ]),
    );
    expect(byLine(r)).toEqual({ 'fin.loans': 200000 });
  });

  it('sends owner capital to financing contributions', () => {
    const r = classifyPosting(
      posting('journal_entry', [
        CASH(75000),
        row('3000', 'equity', 'Owner Equity', -75000),
      ]),
    );
    expect(byLine(r)).toEqual({ 'fin.owner_contributions': 75000 });
  });

  it('sends owner drawings to financing drawings', () => {
    const r = classifyPosting(
      posting('journal_entry', [
        row('3200', 'equity', 'Owner Draws', 12000),
        CASH(-12000),
      ]),
    );
    expect(byLine(r)).toEqual({ 'fin.owner_drawings': -12000 });
  });

  it('excludes a cash-to-bank transfer from every section', () => {
    const r = classifyPosting(
      posting('journal_entry', [BANK(30000), CASH(-30000)]),
    );
    expect(r.transfer).toBe(true);
    expect(r.allocations).toEqual([]);
  });

  it('keeps only the fee of a transfer that carried one', () => {
    const r = classifyPosting(
      posting('journal_entry', [
        BANK(9990),
        row('6500', 'expense', 'Operating', 10),
        CASH(-10000),
      ]),
    );
    expect(r.transfer).toBe(false);
    expect(byLine(r)).toEqual({ 'op.other': -10 });
  });

  it('puts all of a payroll payment in payroll, none of it in tax', () => {
    // Dr Salary 100 / Cr Tax Payable 10 / Cr Cash 90.
    const r = classifyPosting(
      posting('payroll', [
        row('6200', 'expense', 'Payroll', 100),
        row('2300', 'liability', 'Tax Payable', -10),
        CASH(-90),
      ]),
    );
    expect(byLine(r)).toEqual({ 'op.payroll': -90 });
  });

  it('splits a posting whose cash paid for several classes, in proportion', () => {
    // Loan repayment with interest.
    const r = classifyPosting(
      posting('journal_entry', [
        row('2700', 'liability', 'Notes Payable', 900),
        row('6800', 'expense', 'Operating', 100),
        BANK(-1000),
      ]),
    );
    expect(byLine(r)).toEqual({ 'fin.loans': -900, 'op.other': -100 });
    expect(sum(r)).toBeCloseTo(-1000, 10);
  });

  it('allocates only the cash part of an asset partly financed by a direct loan', () => {
    // Dr Fixed Asset 1000 / Cr Notes Payable 700 / Cr Cash 300.
    const r = classifyPosting(
      posting('journal_entry', [
        row('1500', 'asset', 'Fixed Asset', 1000),
        row('2700', 'liability', 'Notes Payable', -700),
        CASH(-300),
      ]),
    );
    expect(byLine(r)).toEqual({ 'inv.fixed_assets': -300 });
  });

  it('keeps an opening-balance posting on its own financing line', () => {
    const r = classifyPosting(
      posting('opening_balance', [
        CASH(40000),
        row('3900', 'equity', 'Opening Balance Equity', -40000),
      ]),
    );
    expect(byLine(r)).toEqual({ 'fin.opening_balance': 40000 });
    expect(CASH_FLOW_LINES['fin.opening_balance'].label).toBe(
      'Opening balance / owner funding',
    );
  });

  it('keeps trade cash on the line its document type always used', () => {
    const r = classifyPosting(
      posting('payment', [
        BANK(5000),
        row('1100', 'asset', 'Accounts Receivable', -5000),
      ]),
    );
    expect(byLine(r)).toEqual({ 'op.customers': 5000 });
  });

  describe('bill payments look through to the bills they paid (D2)', () => {
    const payment = () =>
      posting('bill_payment', [
        row('2000', 'liability', 'Accounts Payable', 1000),
        BANK(-1000),
      ]);

    it('sends a payment for a capex bill to investing', () => {
      const r = classifyPosting(payment(), [
        {
          type: 'asset',
          subType: 'Fixed Asset',
          accountCode: '1500',
          weight: 1000,
        },
      ]);
      expect(byLine(r)).toEqual({ 'inv.fixed_assets': -1000 });
    });

    it('splits a payment for a mixed bill in proportion to its posted lines', () => {
      const r = classifyPosting(payment(), [
        {
          type: 'asset',
          subType: 'Fixed Asset',
          accountCode: '1500',
          weight: 600,
        },
        {
          type: 'expense',
          subType: 'Operating',
          accountCode: '6300',
          weight: 400,
        },
      ]);
      expect(byLine(r)).toEqual({
        'inv.fixed_assets': -600,
        'op.suppliers': -400,
      });
    });

    it('leaves the unapplied part of a payment with suppliers', () => {
      const r = classifyPosting(payment(), [
        {
          type: 'asset',
          subType: 'Fixed Asset',
          accountCode: '1500',
          weight: 700,
        },
      ]);
      expect(byLine(r)).toEqual({
        'inv.fixed_assets': -700,
        'op.suppliers': -300,
      });
    });

    it('stays with suppliers when there is nothing to look through to', () => {
      expect(byLine(classifyPosting(payment(), []))).toEqual({
        'op.suppliers': -1000,
      });
      expect(byLine(classifyPosting(payment()))).toEqual({
        'op.suppliers': -1000,
      });
    });
  });

  it('always allocates exactly the posting net cash', () => {
    const r = classifyPosting(
      posting('journal_entry', [
        row('1500', 'asset', 'Fixed Asset', 333.3333),
        row('3000', 'equity', 'Owner Equity', 333.3333),
        row('6000', 'expense', 'Operating', 333.3334),
        CASH(-1000),
      ]),
    );
    expect(sum(r)).toBeCloseTo(-1000, 9);
  });
});

describe('nonCashShares — what the indirect method must leave out', () => {
  it('takes opening stock out of working capital entirely', () => {
    const inv = row('1200', 'asset', 'Inventory', 500);
    const p = posting('opening_stock', [
      inv,
      row('3900', 'equity', 'Opening Balance Equity', -500),
    ]);
    expect(nonCashShares(p).get(inv.id)).toBe(1);
  });

  it('takes the capex part of a credit purchase out of the AP increase', () => {
    const ap = row('2000', 'liability', 'Accounts Payable', -1000);
    const supplies = row('6300', 'expense', 'Operating', 400);
    const p = posting('bill', [
      row('1500', 'asset', 'Fixed Asset', 600),
      supplies,
      ap,
    ]);
    const shares = nonCashShares(p);
    expect(shares.get(ap.id)).toBeCloseTo(0.6, 10);
    expect(shares.has(supplies.id)).toBe(false);
  });

  it('keeps only the cash-paid half of inventory part-financed by a loan', () => {
    const inv = row('1200', 'asset', 'Inventory', 1000);
    const p = posting('journal_entry', [
      inv,
      CASH(-300),
      row('2700', 'liability', 'Notes Payable', -700),
    ]);
    expect(nonCashShares(p).get(inv.id)).toBeCloseTo(0.7, 10);
  });

  it('adds back an expense the owner paid personally', () => {
    const rent = row('6000', 'expense', 'Operating', 500);
    const p = posting('journal_entry', [
      rent,
      row('3000', 'equity', 'Owner Equity', -500),
    ]);
    expect(nonCashShares(p).get(rent.id)).toBe(1);
  });

  it('leaves ordinary trade alone', () => {
    const ar = row('1100', 'asset', 'Accounts Receivable', 1000);
    const p = posting('invoice', [ar, row('4000', 'revenue', 'Sales', -1000)]);
    expect(nonCashShares(p).size).toBe(0);
  });

  it('gives a capex bill payment its look-through investing share', () => {
    const ap = row('2000', 'liability', 'Accounts Payable', 1000);
    const p = posting('bill_payment', [ap, BANK(-1000)]);
    const flow = classifyPosting(p, [
      {
        type: 'asset',
        subType: 'Fixed Asset',
        accountCode: '1500',
        weight: 600,
      },
      {
        type: 'expense',
        subType: 'Operating',
        accountCode: '6300',
        weight: 400,
      },
    ]);
    expect(nonCashShares(p, flow).get(ap.id)).toBeCloseTo(0.6, 10);
  });
});

describe('compound postings — cash on both sides', () => {
  it('matches a receipt and payments in one journal to their own counterparts', () => {
    // A day's bank book: a customer's 3,000 in; a 15,000 loan instalment and a
    // 500 expense out — one journal entry.
    const p = posting('journal_entry', [
      row('2700', 'liability', 'Notes Payable', 15000),
      row('6000', 'expense', 'Operating', 500),
      BANK(3000),
      row('1100', 'asset', 'Accounts Receivable', -3000),
      BANK(-15500),
    ]);
    const r = classifyPosting(p);
    // Netting first would have smeared the receipt across the loan; matched
    // gross, the loan is exactly the instalment.
    expect(byLine(r)).toEqual({ 'fin.loans': -15000, 'op.other': 2500 });
    expect(sum(r)).toBeCloseTo(-12500, 9);
  });

  it('leaves money moved between own accounts inside an entry in no section', () => {
    // 1,000 from bank to cash and a 200 sale in cash, in one entry.
    const r = classifyPosting(
      posting('journal_entry', [
        CASH(1200),
        BANK(-1000),
        row('4000', 'revenue', 'Sales', -200),
      ]),
    );
    expect(byLine(r)).toEqual({ 'op.other': 200 });
  });

  /** Deterministic pseudo-random numbers, so a failure is reproducible. */
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const ACCOUNTS: Array<[string, string, string]> = [
    ['1100', 'asset', 'Accounts Receivable'],
    ['1200', 'asset', 'Inventory'],
    ['1500', 'asset', 'Fixed Asset'],
    ['2000', 'liability', 'Accounts Payable'],
    ['2310', 'liability', 'Other Liability'],
    ['2700', 'liability', 'Notes Payable'],
    ['3000', 'equity', 'Owner Equity'],
    ['3200', 'equity', 'Owner Draws'],
    ['4000', 'revenue', 'Sales'],
    ['6000', 'expense', 'Operating'],
  ];

  it('reconciles the indirect walk to the direct figure for any balanced posting', () => {
    const next = rng(20261030);
    for (let n = 0; n < 500; n++) {
      const rows: LedgerRow[] = [];
      const lines = 2 + Math.floor(next() * 9);
      for (let i = 0; i < lines; i++) {
        const amount = Math.round((next() * 20000 - 10000) * 100) / 100 || 1;
        if (next() < 0.4) rows.push(next() < 0.5 ? CASH(amount) : BANK(amount));
        else {
          const [code, type, subType] =
            ACCOUNTS[Math.floor(next() * ACCOUNTS.length)];
          rows.push(row(code, type, subType, amount));
        }
      }
      // Balance it on a random account, cash or not.
      const imbalance = rows.reduce((t, r) => t + r.amount, 0);
      if (Math.abs(imbalance) > 0.001) {
        const [code, type, subType] =
          ACCOUNTS[Math.floor(next() * ACCOUNTS.length)];
        rows.push(
          next() < 0.3
            ? CASH(-imbalance)
            : row(code, type, subType, -imbalance),
        );
      }
      const p = posting('journal_entry', rows);
      const flow = classifyPosting(p);
      const shares = nonCashShares(p, flow);

      const direct = flow.allocations
        .filter((a) => CASH_FLOW_LINES[a.lineKey].section === 'operating')
        .reduce((t, a) => t + a.amount, 0);
      // What the indirect method reads from this posting: every operating
      // non-cash row's movement, less what was excluded as non-cash.
      const indirect = rows
        .filter(
          (r) =>
            !r.isCash &&
            [
              'Accounts Receivable',
              'Inventory',
              'Accounts Payable',
              'Other Liability',
              'Sales',
              'Operating',
            ].includes(r.subType!),
        )
        .reduce((t, r) => t - r.amount * (1 - (shares.get(r.id) ?? 0)), 0);
      expect(indirect).toBeCloseTo(direct, 6);

      // Every section together is exactly the posting's net cash.
      const net = rows
        .filter((r) => r.isCash)
        .reduce((t, r) => t + r.amount, 0);
      expect(sum(flow)).toBeCloseTo(flow.transfer ? 0 : net, 6);

      // The cash rows' shares add up to each line — the drill-down contract.
      for (const a of flow.allocations) {
        const fromRows = flow.cashRows.reduce(
          (t, r) => t + r.amount * cashRowShare(r, a),
          0,
        );
        expect(fromRows).toBeCloseTo(a.amount, 6);
      }
    }
  });
});
