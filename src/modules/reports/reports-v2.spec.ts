import {
  CASH_BOOKS,
  CHART,
  LOOK_THROUGH,
  ledgerQuery,
  makeService,
  type PostingFixture,
} from '../../../test/reports-ledger-fixture';

/**
 * Reports v2 — the statements driven through an in-memory LEDGER rather than
 * canned query results (test/reports-ledger-fixture.ts). Identities, not just
 * figures: a balance sheet, a cash-flow statement and a P&L built from the
 * same postings must tie.
 */

const lineOf = (
  section: { lines: Array<{ lineKey?: string; amount: number }> },
  key: string,
) => section.lines.find((l) => l.lineKey === key)?.amount;

describe('Reports v2 — cash flow by counterpart', () => {
  const S = '2026-01-01';
  const E = '2026-12-31';
  const run = async () =>
    (
      await makeService(
        ledgerQuery(CHART, CASH_BOOKS, { lookThrough: LOOK_THROUGH }),
      )
    ).cashFlow('c1', S, E);

  it('lands capex paid by bill in investing, and only the capex part', async () => {
    const r = await run();
    expect(lineOf(r.investing, 'inv.fixed_assets')).toBe(-4000);
    expect(lineOf(r.operating, 'op.suppliers')).toBe(-1000);
  });

  it('lands a loan journal in financing', async () => {
    expect(lineOf((await run()).financing, 'fin.loans')).toBe(20000);
  });

  it('lands owner capital in financing', async () => {
    expect(lineOf((await run()).financing, 'fin.owner_contributions')).toBe(
      7000,
    );
  });

  it('lands owner drawings in financing', async () => {
    expect(lineOf((await run()).financing, 'fin.owner_drawings')).toBe(-1500);
  });

  it('excludes a cash-to-bank transfer from every section', async () => {
    const r = await run();
    const all = [
      ...r.operating.lines,
      ...r.investing.lines,
      ...r.financing.lines,
    ];
    expect(all.map((l) => l.lineKey)).not.toContain(undefined);
    // Nothing is "Other cash movements": the only journal without a
    // non-operating counterpart was the transfer, and it is excluded.
    expect(lineOf(r.operating, 'op.other')).toBeUndefined();
  });

  it('sections sum to the net change, and the net change to the cash moved', async () => {
    const r = await run();
    expect(
      r.operating.total + r.investing.total + r.financing.total,
    ).toBeCloseTo(r.netChange, 10);
    expect(r.netChange).toBe(24500);
    expect(r.beginningCash).toBe(10000);
    expect(r.endingCash).toBe(34500);
  });

  it('ends on the balance sheet cash, account by account', async () => {
    const r = await run();
    const bs = await (
      await makeService(ledgerQuery(CHART, CASH_BOOKS))
    ).balanceSheet('c1', E);
    const bsCash = bs.sections.find((s) => s.key === 'cashAndBank')!.subtotal;
    expect(r.endingCash).toBe(bsCash);
    expect(r.accounts!.reduce((t, a) => t + a.ending, 0)).toBeCloseTo(
      r.endingCash,
      10,
    );
    expect(r.cashTie).toEqual({
      endingCash: 34500,
      balanceSheetCash: 34500,
      ties: true,
    });
  });

  it('reconciles the indirect method with no residual, naming what it left out', async () => {
    const r = await run();
    const ind = r.operatingIndirect!;
    expect(ind.total).toBe(r.operating.total);
    expect(ind.adjustments.map((a) => a.label)).not.toContain(
      'Other operating adjustments',
    );
    expect(
      ind.netIncome + ind.adjustments.reduce((t, a) => t + a.amount, 0),
    ).toBeCloseTo(ind.total, 10);
    // Opening stock is listed as left out, not hidden in a residual.
    expect(ind.excludedNonCash).toContainEqual({
      label: 'Opening balances and opening stock entered in the period',
      amount: -3000,
    });
  });

  it('zero-fills the monthly trend and carries month-end cash', async () => {
    const r = await run();
    expect(r.monthlyTrend).toHaveLength(12);
    expect(r.monthlyTrend[0]).toEqual({
      label: 'Jan 26',
      value: 0,
      endingCash: 10000,
    });
    expect(r.monthlyTrend[11].endingCash).toBe(34500);
    expect(r.monthlyTrend.reduce((t, p) => t + p.value, 0)).toBe(r.netChange);
  });

  it('splits each month into cash in and cash out, with a transfer in neither', async () => {
    const r = await run();
    const monthly = r.monthly!;
    expect(monthly).toHaveLength(12);
    for (const m of monthly)
      expect(m.net).toBeCloseTo(m.inflow - m.outflow, 10);
    expect(monthly.reduce((t, m) => t + m.net, 0)).toBeCloseTo(r.netChange, 10);
    expect(monthly.map((m) => m.endingCash)).toEqual(
      r.monthlyTrend.map((p) => p.endingCash),
    );
    expect(monthly.map((m) => m.net)).toEqual(
      r.monthlyTrend.map((p) => p.value),
    );
    // March: the bill payment.
    expect(monthly[2]).toMatchObject({
      period: '2026-03',
      inflow: 0,
      outflow: 5000,
      net: -5000,
    });
    // April: the loan and the owner's capital in, the drawings out; the
    // 2,000 moved from cash to the bank is in neither column.
    expect(monthly[3]).toEqual({
      period: '2026-04',
      label: 'Apr 26',
      inflow: 27000,
      outflow: 1500,
      net: 25500,
      endingCash: 30500,
    });
    expect(monthly[0]).toMatchObject({
      inflow: 0,
      outflow: 0,
      net: 0,
      endingCash: 10000,
    });
  });
});

describe('Reports v2 — balance sheet equity', () => {
  const accounts = CHART;
  const books: PostingFixture[] = [
    {
      ref: 'JE-1',
      date: '2024-01-01',
      sourceType: 'journal_entry',
      lines: [
        ['1000', 5000, 0],
        ['3000', 0, 5000],
      ],
    },
    // Fiscal 2025: earned 1000, spent 300.
    {
      ref: 'JE-2',
      date: '2025-06-01',
      sourceType: 'invoice',
      lines: [
        ['1000', 1000, 0],
        ['4000', 0, 1000],
      ],
    },
    {
      ref: 'JE-3',
      date: '2025-07-01',
      sourceType: 'journal_entry',
      lines: [
        ['6000', 300, 0],
        ['1000', 0, 300],
      ],
    },
    // A posted balance on Retained Earnings itself.
    {
      ref: 'JE-4',
      date: '2025-12-31',
      sourceType: 'journal_entry',
      lines: [
        ['3000', 200, 0],
        ['3100', 0, 200],
      ],
    },
    // Fiscal 2026 to date: earned 500, spent 100.
    {
      ref: 'JE-5',
      date: '2026-03-01',
      sourceType: 'invoice',
      lines: [
        ['1000', 500, 0],
        ['4000', 0, 500],
      ],
    },
    {
      ref: 'JE-6',
      date: '2026-08-01',
      sourceType: 'journal_entry',
      lines: [
        ['6000', 100, 0],
        ['1000', 0, 100],
      ],
    },
  ];
  const AS_OF = '2026-10-26';

  it('splits earnings at the fiscal year and never reuses a real code', async () => {
    const bs = await (
      await makeService(ledgerQuery(accounts, books))
    ).balanceSheet('c1', AS_OF);
    const codes = bs.equity.map((l) => l.accountCode).filter((c) => c !== '');
    expect(new Set(codes).size).toBe(codes.length);
    expect(bs.equity).toEqual([
      { accountCode: '3000', accountName: 'Owner Equity', amount: 4800 },
      {
        accountCode: '3100',
        accountName: 'Retained Earnings',
        amount: 900,
        composite: { postedBalance: 200, priorYearsEarnings: 700 },
      },
      {
        accountCode: '',
        accountName: 'Net Income (current fiscal year)',
        amount: 400,
        synthetic: 'currentYearEarnings',
      },
    ]);
  });

  it('keeps every total exactly where it was', async () => {
    const bs = await (
      await makeService(ledgerQuery(accounts, books))
    ).balanceSheet('c1', AS_OF);
    // Computed the old way: assets 6100; equity 4800 + 200 + all-time NI 1100.
    expect(bs.totalAssets).toBe(6100);
    expect(bs.totalLiabilities).toBe(0);
    expect(bs.totalEquity).toBe(6100);
    expect(bs.isBalanced).toBe(true);
    expect(bs.gap).toBe(0);
    expect(bs.totalLiabilitiesAndEquity).toBe(6100);
    expect(bs.fiscalYearStart).toBe('2026-01-01');
  });

  it("states each year's earnings exactly as the P&L does", async () => {
    const svc = await makeService(ledgerQuery(accounts, books));
    const bs = await svc.balanceSheet('c1', AS_OF);
    const fy = await svc.profitLoss('c1', '2026-01-01', AS_OF);
    const before = await svc.profitLoss('c1', '1970-01-01', '2025-12-31');
    expect(
      bs.equity.find((l) => l.synthetic === 'currentYearEarnings')!.amount,
    ).toBe(fy.netIncome);
    expect(
      bs.equity.find((l) => l.accountCode === '3100')!.composite!
        .priorYearsEarnings,
    ).toBe(before.netIncome);
  });

  it('follows a July fiscal year', async () => {
    const bs = await (
      await makeService(ledgerQuery(accounts, books, { fyMonth: 7 }))
    ).balanceSheet('c1', AS_OF);
    expect(bs.fiscalYearStart).toBe('2026-07-01');
    // March 2026 now belongs to the prior year; only August's 100 is current.
    expect(
      bs.equity.find((l) => l.synthetic === 'currentYearEarnings')!.amount,
    ).toBe(-100);
    expect(bs.equity.find((l) => l.accountCode === '3100')!.amount).toBe(1400);
    expect(bs.totalEquity).toBe(6100);
  });

  it('shows a synthetic Retained Earnings line when the chart has no account for it', async () => {
    const noRe = accounts.filter((a) => a.code !== '3100');
    const booksNoRe = books.filter((b) => b.ref !== 'JE-4');
    const bs = await (
      await makeService(ledgerQuery(noRe, booksNoRe))
    ).balanceSheet('c1', AS_OF);
    expect(bs.equity).toContainEqual({
      accountCode: '',
      accountName: 'Retained Earnings',
      amount: 700,
      synthetic: 'retainedEarnings',
    });
    expect(bs.isBalanced).toBe(true);
  });

  it('groups lines into sections whose subtotals foot to the totals', async () => {
    const bs = await (
      await makeService(ledgerQuery(accounts, books))
    ).balanceSheet('c1', AS_OF);
    expect(bs.sections.map((s) => s.key)).toEqual([
      'cashAndBank',
      'receivables',
      'inventory',
      'otherCurrentAssets',
      'fixedAssets',
      'currentLiabilities',
      'longTermLiabilities',
      'equity',
    ]);
    const sideTotal = (keys: string[]) =>
      bs.sections
        .filter((s) => keys.includes(s.key))
        .reduce((t, s) => t + s.subtotal, 0);
    expect(
      sideTotal([
        'cashAndBank',
        'receivables',
        'inventory',
        'otherCurrentAssets',
        'fixedAssets',
      ]),
    ).toBe(bs.totalAssets);
    expect(bs.sections.find((s) => s.key === 'equity')!.subtotal).toBe(
      bs.totalEquity,
    );
    expect(bs.subtotals.find((s) => s.key === 'totalAssets')!.amount).toBe(
      bs.totalAssets,
    );
    expect(bs.comparison).toBeNull();
  });

  it('lists the active accounts with no balance only when asked, moving no total', async () => {
    const svc = await makeService(ledgerQuery(accounts, books));
    const plain = await svc.balanceSheet('c1', AS_OF);
    const all = await svc.balanceSheet('c1', AS_OF, undefined, {
      includeZero: true,
    });
    const codes = (bs: typeof plain) =>
      bs.sections.flatMap((s) => s.lines.map((l) => l.accountCode));
    // The loan account has never been posted to.
    expect(codes(plain)).not.toContain('2700');
    expect(
      all.sections.find((s) => s.key === 'longTermLiabilities')!.lines,
    ).toEqual([expect.objectContaining({ accountCode: '2700', amount: 0 })]);
    for (const code of [
      '1010',
      '1100',
      '1200',
      '1500',
      '2000',
      '3200',
      '3900',
    ]) {
      expect(codes(all)).toContain(code);
    }
    expect(all.sections.map((s) => s.subtotal)).toEqual(
      plain.sections.map((s) => s.subtotal),
    );
    expect(all.subtotals).toEqual(plain.subtotals);
    expect([all.totalAssets, all.totalLiabilities, all.totalEquity]).toEqual([
      plain.totalAssets,
      plain.totalLiabilities,
      plain.totalEquity,
    ]);
    // The flat legacy arrays are what the old clients and the CSV read.
    expect([all.assets, all.liabilities, all.equity]).toEqual([
      plain.assets,
      plain.liabilities,
      plain.equity,
    ]);
  });

  it('compares with an earlier date, keeping accounts that have since gone to zero', async () => {
    const withAr: PostingFixture[] = [
      ...books,
      {
        ref: 'JE-7',
        date: '2025-11-01',
        sourceType: 'invoice',
        lines: [
          ['1100', 250, 0],
          ['4000', 0, 250],
        ],
      },
      {
        ref: 'JE-8',
        date: '2026-02-01',
        sourceType: 'payment',
        lines: [
          ['1000', 250, 0],
          ['1100', 0, 250],
        ],
      },
    ];
    const bs = await (
      await makeService(ledgerQuery(accounts, withAr))
    ).balanceSheet('c1', AS_OF, '2025-12-31');
    const ar = bs.sections.find((s) => s.key === 'receivables')!.lines[0];
    expect(ar).toMatchObject({
      accountCode: '1100',
      amount: 0,
      priorAmount: 250,
      change: -250,
      changePct: -100,
    });
    expect(bs.comparison).toMatchObject({ asOfDate: '2025-12-31' });
    const cash = bs.sections.find((s) => s.key === 'cashAndBank')!.lines[0];
    expect(cash.priorAmount).toBe(5700);
    expect(cash.changePct).toBeCloseTo(((6350 - 5700) / 5700) * 100, 1);
  });
});

describe('Reports v2 — P&L non-operating subtypes', () => {
  it('reports an Interest-subtype 4xxx account as other income without moving any total', async () => {
    const books: PostingFixture[] = [
      {
        ref: 'JE-1',
        date: '2026-02-01',
        sourceType: 'invoice',
        lines: [
          ['1000', 10000, 0],
          ['4000', 0, 10000],
        ],
      },
      {
        ref: 'JE-2',
        date: '2026-02-02',
        sourceType: 'journal_entry',
        lines: [
          ['1010', 300, 0],
          ['4100', 0, 300],
        ],
      },
      {
        ref: 'JE-3',
        date: '2026-02-03',
        sourceType: 'journal_entry',
        lines: [
          ['6000', 1000, 0],
          ['1000', 0, 1000],
        ],
      },
    ];
    const pl = await (
      await makeService(ledgerQuery(CHART, books))
    ).profitLoss('c1', '2026-01-01', '2026-12-31');
    expect(pl.otherIncome.map((l) => l.accountCode)).toEqual(['4100']);
    expect(pl.income.map((l) => l.accountCode)).toEqual(['4000']);
    // The bottom line and the all-inclusive totals do not move.
    expect(pl.revenue).toBe(10300);
    expect(pl.expenses).toBe(1000);
    expect(pl.netIncome).toBe(9300);
    expect(pl.netOperatingIncome).toBe(9000);
    expect(pl.netOtherIncome).toBe(300);
  });
});

/**
 * 2.1 — the document joins moved into a shared builder. The drill-down's SQL
 * and output must be exactly what they were: this is the literal the
 * statement-line drill-down ran before the extraction.
 */
const PRE_EXTRACTION_ENTRIES_SQL = `SELECT g.id, g.date::text AS date, g.reference, g.memo,
              g.debit::numeric AS debit, g.credit::numeric AS credit,
              g.source_type AS "sourceType", g.source_id AS "sourceId",
              COALESCE(inv.invoice_number, bl.bill_number, cm.credit_memo_number,
                       vc.vendor_credit_number, po.po_number,
                       pay.payment_number, bp.reference,
                       dinv.invoice_number, dl.reference_no)   AS "documentNumber",
              COALESCE(ic.name, cc.name, pc.name,
                       bv.company_name, vv.company_name,
                       pv.company_name, bpv.company_name,
                       dc.name)                                AS "counterpartyName"
         FROM general_ledger g
         LEFT JOIN invoices inv       ON inv.id = g.source_id
                                     AND g.source_type IN ('invoice','invoice_void')
         LEFT JOIN customers ic       ON ic.id = inv.customer_id
         LEFT JOIN bills bl           ON bl.id = g.source_id
                                     AND g.source_type IN ('bill','bill_void')
         LEFT JOIN vendors bv         ON bv.id = bl.vendor_id
         LEFT JOIN credit_memos cm    ON cm.id = g.source_id
                                     AND g.source_type IN ('credit_memo','credit_memo_void','credit_memo_refund')
         LEFT JOIN customers cc       ON cc.id = cm.customer_id
         LEFT JOIN vendor_credits vc  ON vc.id = g.source_id
                                     AND g.source_type IN ('vendor_credit','vendor_credit_void')
         LEFT JOIN vendors vv         ON vv.id = vc.vendor_id
         LEFT JOIN purchase_orders po ON po.id = g.source_id
                                     AND g.source_type IN ('purchase_order','po_receipt')
         LEFT JOIN vendors pv         ON pv.id = po.vendor_id
         LEFT JOIN payments pay       ON pay.id = g.source_id
                                     AND g.source_type = 'payment'
         LEFT JOIN customers pc       ON pc.id = pay.customer_id
         LEFT JOIN bill_payments bp   ON bp.id = g.source_id
                                     AND g.source_type = 'bill_payment'
         LEFT JOIN vendors bpv        ON bpv.id = bp.vendor_id
         LEFT JOIN deliveries dl      ON dl.id = g.source_id
                                     AND g.source_type LIKE 'delivery%'
         LEFT JOIN invoices dinv      ON dinv.id = dl.invoice_id
         LEFT JOIN customers dc       ON dc.id = dl.customer_id
        WHERE g.company_id = $1 AND g.account_id = $2 AND g.date >= $3 AND g.date <= $4
        -- id breaks ties: one posting writes its lines with one timestamp,
        -- and page 2 must continue page 1 exactly.
        ORDER BY g.date DESC, g.created_at DESC, g.id DESC
        LIMIT $5 OFFSET $6`;

describe('Reports v2 — 2.1 statementLineEntries is unchanged by the extraction', () => {
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const STUB_ROW = {
    id: 'g1',
    date: '2026-03-01',
    reference: 'JE-009',
    memo: 'Invoice INV-1',
    debit: '0',
    credit: '1234.5678',
    sourceType: 'invoice',
    sourceId: 'inv-1',
    documentNumber: 'INV-2026-0001',
    counterpartyName: 'Acme Ltd',
  };
  const query = () =>
    jest.fn(async (sql: string) => {
      if (
        sql.includes('FROM accounts a') &&
        sql.includes('a.account_number = $2')
      )
        return [
          {
            id: 'a1',
            accountCode: '4000',
            accountName: 'Sales Revenue',
            accountType: 'revenue',
            subType: 'Sales',
          },
        ];
      if (sql.includes('COUNT(*)::int AS cnt'))
        return [{ cnt: 1, dr: '0', cr: '1234.5678' }];
      if (sql.includes('LIMIT $5 OFFSET $6')) return [STUB_ROW];
      return [];
    });

  it('runs exactly the SQL it ran before', async () => {
    const q = query();
    await (
      await makeService(q)
    ).statementLineEntries('c1', '4000', '2026-01-01', '2026-12-31', 1, 50);
    const rowsSql = q.mock.calls
      .map((c) => c[0] as string)
      .find((s) => s.includes('LIMIT $5 OFFSET $6'))!;
    expect(norm(rowsSql)).toBe(norm(PRE_EXTRACTION_ENTRIES_SQL));
  });

  it('returns exactly the response it returned before', async () => {
    const r = await (
      await makeService(query())
    ).statementLineEntries('c1', '4000', '2026-01-01', '2026-12-31', 1, 50);
    expect(r).toEqual({
      accountCode: '4000',
      accountName: 'Sales Revenue',
      accountType: 'revenue',
      range: { startDate: '2026-01-01', endDate: '2026-12-31' },
      lineAmount: 1234.57,
      entries: [
        {
          id: 'g1',
          date: '2026-03-01',
          reference: 'JE-009',
          memo: 'Invoice INV-1',
          debit: 0,
          credit: 1234.57,
          amount: 1234.57,
          sourceType: 'invoice',
          sourceId: 'inv-1',
          sourceLabel: 'Invoice',
          documentNumber: 'INV-2026-0001',
          counterpartyName: 'Acme Ltd',
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    });
  });
});

describe('Reports v2 — 2.2 account register', () => {
  const books: PostingFixture[] = [
    {
      ref: 'JE-01',
      date: '2025-12-15',
      sourceType: 'journal_entry',
      lines: [
        ['1000', 1000, 0],
        ['3000', 0, 1000],
      ],
    },
    ...Array.from(
      { length: 7 },
      (_, i): PostingFixture => ({
        ref: `JE-1${i}`,
        date: `2026-02-0${i + 1}`,
        sourceType: i % 2 ? 'payment' : 'journal_entry',
        party: i % 2 ? 'Acme Ltd' : undefined,
        lines:
          i % 2
            ? [
                ['1000', 100 * (i + 1), 0],
                ['1100', 0, 100 * (i + 1)],
              ]
            : [
                ['6000', 10 * (i + 1), 0],
                ['1000', 0, 10 * (i + 1)],
              ],
      }),
    ),
  ];
  const run = async (order: 'asc' | 'desc', page: number, limit = 3) =>
    (await makeService(ledgerQuery(CHART, books))).accountRegister(
      'c1',
      '1000',
      '2026-01-01',
      '2026-12-31',
      page,
      limit,
      order,
    );

  it('opens on everything before the range and closes on opening + the period', async () => {
    const r = await run('asc', 1, 200);
    expect(r.openingBalance).toBe(1000);
    const sum = r.entries.reduce((t, x) => t + x.amount, 0);
    expect(r.closingBalance).toBeCloseTo(r.openingBalance + sum, 10);
    expect(r.entries[r.entries.length - 1].runningBalance).toBe(
      r.closingBalance,
    );
    expect(r.openingBasis).toBe('cumulative');
  });

  it('keeps the running balance continuous across a page boundary, in either order', async () => {
    const all = (await run('asc', 1, 200)).entries;
    const pages = [
      ...(await run('asc', 1)).entries,
      ...(await run('asc', 2)).entries,
      ...(await run('asc', 3)).entries,
    ];
    expect(pages.map((x) => x.runningBalance)).toEqual(
      all.map((x) => x.runningBalance),
    );
    // Page 2 starts where page 1 ended.
    const p1 = (await run('asc', 1)).entries;
    const p2 = (await run('asc', 2)).entries;
    expect(p2[0].runningBalance).toBeCloseTo(
      p1[p1.length - 1].runningBalance + p2[0].amount,
      10,
    );
    // Newest first, the balance after each row is the same number.
    const desc = (await run('desc', 1, 200)).entries;
    expect(desc.map((x) => x.runningBalance)).toEqual(
      [...all].reverse().map((x) => x.runningBalance),
    );
  });

  it('names the counterparty behind each row', async () => {
    const r = await run('asc', 1, 200);
    expect(
      r.entries.find((x) => x.sourceType === 'payment')!.counterpartyName,
    ).toBe('Acme Ltd');
  });

  it('opens a P&L account at the start of its fiscal year, not at inception', async () => {
    const r = await (
      await makeService(ledgerQuery(CHART, books))
    ).accountRegister('c1', '6000', '2026-02-04', '2026-12-31');
    expect(r.openingBasis).toBe('fiscalYearToDate');
    // 10 + 30 from 1 and 3 February, nothing from 2025.
    expect(r.openingBalance).toBe(40);
  });

  it('refuses an unknown account rather than reporting no activity', async () => {
    const svc = await makeService(ledgerQuery(CHART, books));
    await expect(
      svc.accountRegister('c1', '9999', '2026-01-01', '2026-12-31'),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_FOUND' },
    });
  });
});

describe('Reports v2 — 2.3 retained earnings', () => {
  const books: PostingFixture[] = [
    {
      ref: 'JE-1',
      date: '2024-03-01',
      sourceType: 'invoice',
      lines: [
        ['1000', 400, 0],
        ['4000', 0, 400],
      ],
    },
    {
      ref: 'JE-2',
      date: '2025-06-01',
      sourceType: 'invoice',
      lines: [
        ['1000', 1000, 0],
        ['4000', 0, 1000],
      ],
    },
    {
      ref: 'JE-3',
      date: '2025-07-01',
      sourceType: 'journal_entry',
      lines: [
        ['6000', 300.005, 0],
        ['1000', 0, 300.005],
      ],
    },
    {
      ref: 'JE-4',
      date: '2025-12-31',
      sourceType: 'journal_entry',
      lines: [
        ['3000', 200, 0],
        ['3100', 0, 200],
      ],
    },
    {
      ref: 'JE-5',
      date: '2026-03-01',
      sourceType: 'invoice',
      lines: [
        ['1000', 500, 0],
        ['4000', 0, 500],
      ],
    },
  ];

  it('totals to the balance sheet Retained Earnings line exactly', async () => {
    const svc = await makeService(ledgerQuery(CHART, books));
    const re = await svc.retainedEarnings('c1', '2026-10-26');
    const bs = await svc.balanceSheet('c1', '2026-10-26');
    expect(re.total).toBe(
      bs.equity.find((l) => l.accountCode === '3100')!.amount,
    );
    // 1000 − 300.005 = 699.995, rounded half-up once.
    expect(re.byFiscalYear.map((y) => [y.fiscalYear, y.netIncome])).toEqual([
      [2024, 400],
      [2025, 700],
    ]);
    expect(re.postedTo3100).toBe(200);
    expect(re.fiscalYearStart).toBe('2026-01-01');
  });

  it('buckets by the company fiscal year', async () => {
    const re = await (
      await makeService(ledgerQuery(CHART, books, { fyMonth: 7 }))
    ).retainedEarnings('c1', '2026-10-26');
    // July years: FY2023 holds March 2024; FY2024 holds June 2025; FY2025 holds
    // July 2025 and March 2026.
    expect(re.byFiscalYear.map((y) => y.fiscalYear)).toEqual([
      2023, 2024, 2025,
    ]);
    expect(re.byFiscalYear[0]).toMatchObject({
      startDate: '2023-07-01',
      endDate: '2024-06-30',
      netIncome: 400,
    });
  });
});

describe('Reports v2 — 2.5 trial balance modes', () => {
  const svcFor = (books: PostingFixture[], fyMonth?: number) =>
    makeService(ledgerQuery(CHART, books, { fyMonth }));

  it('leaves the response untouched when no mode is asked for', async () => {
    const svc = await svcFor(CASH_BOOKS);
    const r: any = await svc.trialBalance('c1', '2026-01-01', '2026-12-31');
    expect(Object.keys(r)).toEqual([
      'range',
      'rows',
      'totalDebits',
      'totalCredits',
      'isBalanced',
    ]);
    expect(Object.keys(r.rows[0])).toEqual([
      'accountCode',
      'accountName',
      'debit',
      'credit',
    ]);
  });

  it('balances a closing trial balance with a prior-years earnings row', async () => {
    const books: PostingFixture[] = [
      ...CASH_BOOKS,
      {
        ref: 'JE-90',
        date: '2025-12-20',
        sourceType: 'invoice',
        lines: [
          ['1000', 900, 0],
          ['4000', 0, 900],
        ],
      },
    ];
    const r: any = await (
      await svcFor(books)
    ).trialBalance('c1', '1970-01-01', '2026-12-31', 'closing');
    expect(r.isBalanced).toBe(true);
    expect(r.totalDebits).toBe(r.totalCredits);
    const re = r.rows.find((x: any) => x.synthetic);
    expect(re).toMatchObject({ accountCode: '', credit: 900, group: 'equity' });
    // Revenue is the fiscal year to date only.
    expect(r.rows.find((x: any) => x.accountCode === '4000').credit).toBe(6000);
    // 34500 from CASH_BOOKS plus the 900 sale above.
    expect(r.groups.find((g: any) => g.key === 'cashAndBank').debit).toBe(
      35400,
    );
  });

  it('balances every column pair of a working trial balance', async () => {
    const r: any = await (
      await svcFor(CASH_BOOKS)
    ).trialBalance('c1', '2026-04-01', '2026-06-30', 'working');
    expect(r.balanced).toEqual({ opening: true, period: true, closing: true });
    expect(r.isBalanced).toBe(true);
    const cash = r.rows.find((x: any) => x.accountCode === '1000');
    // Opening cash 10000 − 0; April–June: +7000 −1500 −2000 +4000.
    expect(cash).toMatchObject({
      openingDebit: 10000,
      periodDebit: 7500,
      closingDebit: 17500,
    });
    expect(r.warnings).toEqual([]);
  });

  it('lists untouched accounts of the chart only when asked, in every mode', async () => {
    const svc = await svcFor(CASH_BOOKS);
    for (const mode of ['movement', 'closing', 'working'] as const) {
      const plain: any = await svc.trialBalance(
        'c1',
        '2026-01-01',
        '2026-12-31',
        mode,
      );
      const all: any = await svc.trialBalance(
        'c1',
        '2026-01-01',
        '2026-12-31',
        mode,
        {
          includeZero: true,
        },
      );
      const codes = (r: any) => r.rows.map((x: any) => x.accountCode);
      // Rent (6000) and bank interest (4100) are never posted to.
      expect(codes(plain)).not.toContain('6000');
      expect(codes(all)).toEqual(expect.arrayContaining(['4100', '6000']));
      expect(all.rows.find((x: any) => x.accountCode === '6000')).toMatchObject(
        {
          debit: 0,
          credit: 0,
        },
      );
      expect([all.totalDebits, all.totalCredits, all.isBalanced]).toEqual([
        plain.totalDebits,
        plain.totalCredits,
        true,
      ]);
      // A group can appear for the zero rows it now heads, at zero.
      for (const g of all.groups) {
        const was = plain.groups.find((p: any) => p.key === g.key);
        expect(g).toEqual(was ?? { ...g, debit: 0, credit: 0 });
      }
    }
  });

  it('foots the same totals whether or not dust rows are shown', async () => {
    // Two accounts move by less than half a paisa: hidden by default, shown
    // with includeZero. Neither choice may move a column total.
    const books: PostingFixture[] = [
      ...CASH_BOOKS,
      {
        ref: 'JE-D1',
        date: '2026-05-05',
        sourceType: 'journal_entry',
        lines: [
          ['6300', 0.004, 0],
          ['1010', 0, 0.004],
        ],
      },
      {
        ref: 'JE-D2',
        date: '2026-05-06',
        sourceType: 'journal_entry',
        lines: [
          ['6000', 0.0045, 0],
          ['1000', 0, 0.0045],
        ],
      },
    ];
    const svc = await svcFor(books);
    for (const mode of ['movement', 'closing', 'working'] as const) {
      const plain: any = await svc.trialBalance(
        'c1',
        '2026-01-01',
        '2026-12-31',
        mode,
      );
      const all: any = await svc.trialBalance(
        'c1',
        '2026-01-01',
        '2026-12-31',
        mode,
        {
          includeZero: true,
        },
      );
      expect([all.totalDebits, all.totalCredits, all.isBalanced]).toEqual([
        plain.totalDebits,
        plain.totalCredits,
        plain.isBalanced,
      ]);
      expect(plain.isBalanced).toBe(true);
    }
  });

  it('warns when a working range crosses a fiscal year', async () => {
    const r: any = await (
      await svcFor(CASH_BOOKS, 4)
    ).trialBalance('c1', '2026-01-01', '2026-06-30', 'working');
    expect(r.warnings.map((w: any) => w.code)).toEqual(['CROSSES_FISCAL_YEAR']);
    expect(r.isBalanced).toBe(true);
  });

  it('flags an overdrawn bank, a contra asset and uncleared opening balance equity', async () => {
    const chart = [
      ...CHART,
      {
        code: '1510',
        name: 'Accumulated Depreciation',
        type: 'asset',
        subType: 'Fixed Asset',
      },
    ];
    const books: PostingFixture[] = [
      {
        ref: 'JE-1',
        date: '2026-01-02',
        sourceType: 'opening_balance',
        lines: [
          ['1000', 500, 0],
          ['3900', 0, 500],
        ],
      },
      {
        ref: 'JE-2',
        date: '2026-01-03',
        sourceType: 'journal_entry',
        lines: [
          ['6000', 800, 0],
          ['1010', 0, 800],
        ],
      },
      {
        ref: 'JE-3',
        date: '2026-01-04',
        sourceType: 'journal_entry',
        lines: [
          ['6000', 50, 0],
          ['1510', 0, 50],
        ],
      },
    ];
    const r: any = await (
      await makeService(ledgerQuery(chart, books))
    ).trialBalance('c1', '2026-01-01', '2026-12-31', 'closing');
    const flags = (code: string) =>
      r.rows.find((x: any) => x.accountCode === code).flags;
    expect(flags('1010')).toEqual(['abnormal_balance']);
    expect(flags('1510')).toEqual(['contra_assumed']);
    expect(flags('3900')).toEqual(['obe_nonzero']);
    expect(flags('1000')).toEqual([]);
  });
});

describe('Reports v2 — 2.6 cash-flow line entries', () => {
  const svc = () =>
    makeService(ledgerQuery(CHART, CASH_BOOKS, { lookThrough: LOOK_THROUGH }));

  it('lists the cash rows behind a line, and they add up to it', async () => {
    const cf = await (await svc()).cashFlow('c1', '2026-01-01', '2026-12-31');
    for (const section of [cf.operating, cf.investing, cf.financing]) {
      for (const line of section.lines) {
        const r = await (
          await svc()
        ).cashFlowLineEntries(
          'c1',
          line.lineKey!,
          '2026-01-01',
          '2026-12-31',
          1,
          200,
        );
        expect(r.lineAmount).toBe(line.amount);
        expect(
          r.entries.reduce((t, x) => t + x.allocatedAmount, 0),
        ).toBeCloseTo(line.amount, 2);
      }
    }
  });

  it('shows the investing share of a split bill payment', async () => {
    const r = await (
      await svc()
    ).cashFlowLineEntries('c1', 'inv.fixed_assets', '2026-01-01', '2026-12-31');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      amount: -5000,
      allocatedAmount: -4000,
      allocationPct: 80,
      cashAccountCode: '1010',
    });
  });

  it('refuses a line key the statement does not have', async () => {
    await expect(
      (await svc()).cashFlowLineEntries(
        'c1',
        'op.nope',
        '2026-01-01',
        '2026-12-31',
      ),
    ).rejects.toMatchObject({
      response: { code: 'UNKNOWN_LINE_KEY' },
    });
  });
});

describe('Reports v2 — 2.7 account movement', () => {
  const books: PostingFixture[] = [
    {
      ref: 'JE-1',
      date: '2026-01-10',
      sourceType: 'invoice',
      party: 'Acme',
      lines: [
        ['1100', 1000, 0],
        ['4000', 0, 1000],
      ],
    },
    {
      ref: 'JE-2',
      date: '2026-01-20',
      sourceType: 'invoice',
      party: 'Beta',
      lines: [
        ['1100', 500, 0],
        ['4000', 0, 500],
      ],
    },
    {
      ref: 'JE-3',
      date: '2026-02-05',
      sourceType: 'invoice',
      party: 'Acme',
      lines: [
        ['1100', 3000, 0],
        ['4000', 0, 3000],
      ],
    },
    {
      ref: 'JE-4',
      date: '2026-02-15',
      sourceType: 'invoice',
      party: 'Gamma',
      lines: [
        ['1100', 250.555, 0],
        ['4000', 0, 250.555],
      ],
    },
    {
      ref: 'JE-5',
      date: '2026-02-20',
      sourceType: 'journal_entry',
      lines: [
        ['1100', 100, 0],
        ['4000', 0, 100],
      ],
    },
  ];

  it('compares with the preceding period of equal length and breaks the change down completely', async () => {
    const r = await (
      await makeService(ledgerQuery(CHART, books))
    ).accountMovement('c1', '4000', '2026-02-01', '2026-02-28');
    // February is a whole month, so January is the comparison.
    expect(r.compareRange).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(r.current).toBe(3350.56);
    expect(r.prior).toBe(1500);
    expect(r.change).toBe(1850.56);
    const names = r.byCounterparty.map((x) => x.name);
    expect(names[0]).toBe('Acme');
    expect(names).toContain('Unattributed');
    expect(r.byCounterparty.reduce((t, x) => t + x.change, 0)).toBeCloseTo(
      r.change,
      10,
    );
    expect(r.bySourceType.reduce((t, x) => t + x.change, 0)).toBeCloseTo(
      r.change,
      10,
    );
  });

  it('folds parties beyond the limit into Other without losing any of the change', async () => {
    const r = await (
      await makeService(ledgerQuery(CHART, books))
    ).accountMovement(
      'c1',
      '4000',
      '2026-02-01',
      '2026-02-28',
      undefined,
      undefined,
      1,
    );
    expect(r.byCounterparty.map((x) => x.name)).toEqual(['Acme', 'Other']);
    expect(r.byCounterparty.reduce((t, x) => t + x.change, 0)).toBeCloseTo(
      r.change,
      10,
    );
  });
});
