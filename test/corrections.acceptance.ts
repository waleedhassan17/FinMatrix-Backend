/**
 * FinMatrix — Correction Paths Acceptance (audit gap G3)
 * ======================================================
 * The four GL-wired modules that had NEVER processed a production
 * transaction: credit memos, vendor credits, inventory adjustments and tax
 * payments. These are the correction paths — the mechanism for fixing a
 * mistake — so they matter more than the happy path, not less.
 *
 * Asserts the EXACT debit/credit lines each produces against
 * journal_entry_lines, plus the subledger movement, then re-checks the ledger
 * invariants. Every assertion is delta-based so it holds on non-empty books.
 *
 *   A. Credit memo: Dr Revenue (net) / Dr Tax Payable (tax) / Cr AR (gross),
 *      restock Dr Inventory / Cr COGS at the cost frozen on the line
 *   B. Credit memo void with a DRIFTED average cost — the reversal must still
 *      cancel the original exactly (the bug this gap found)
 *   C. Vendor credit: Dr AP (gross) / Cr Expense (net) / Cr Input Tax 1300
 *      (the leg that did not exist before this gap)
 *   D. Inventory adjustment: write-down Dr shrinkage / Cr 1200, write-up
 *      reversed, quantity never moves without a journal entry, the REASON
 *      picks the shrinkage account, back-dating obeys the period lock, and a
 *      reversal mirrors whichever account the original used
 *   E. Tax payment: Dr Sales Tax Payable / Cr Cash, liability drops
 *   F. Weighted-average costing behaves as labelled, and fifo/lifo are now
 *      rejected rather than silently stored and ignored (gap G6)
 *   G. Reports recognise revenue at invoice date — accrual — and a cash-basis
 *      selection the reports cannot honour is rejected (gap G8)
 *
 * Invariants I1-I5, I8 and I11 are re-checked after every step.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/corrections.acceptance.ts
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`,
    );
  }
};
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const n = (v: unknown) => Number(v ?? 0) || 0;

let TOKEN = '';
let COMPANY = '';

async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  // The API throttles (THROTTLE_LIMIT requests per THROTTLE_TTL). Running the
  // accounting suites back to back trips it, and a 429 is not a test failure —
  // back off and retry rather than reporting rate limiting as a broken ledger.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      // /auth/signin is capped at 5 per minute by a route-level @Throttle —
      // brute-force protection worth keeping, and not something a test should
      // turn off. Wait out the whole window for auth; back off more gently for
      // everything else, which only trips the global limit.
      const wait = path.startsWith('/auth') ? 65_000 : 15_000 * (attempt + 1);
      console.log(`    (throttled on ${path} — waiting ${Math.round(wait / 1000)}s)`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, body: parsed };
  }
}
const data = (r: { body: any }) => r.body?.data ?? r.body;

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();

  console.log(`\nFinMatrix Correction Paths (G3) → ${API}\n`);

  // ── Sign in ────────────────────────────────────────────────────
  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');

  // ── Ledger helpers, read straight from the GL ──────────────────

  /** Net movement on an account, by account number, in normal-balance terms. */
  const acctBalance = async (num: string): Promise<number> => {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0) AS net
         FROM journal_entry_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE a.company_id = $1 AND a.account_number = $2`,
      [COMPANY, num],
    );
    return n(rows[0]?.net);
  };

  /** The debit/credit lines of the newest entry for a source document. */
  const linesFor = async (sourceType: string, sourceId: string) => {
    const { rows } = await db.query(
      `SELECT a.account_number AS acct, l.debit::float8 AS debit,
              l.credit::float8 AS credit
         FROM general_ledger g
         JOIN journal_entry_lines l
           ON l.entry_id = (SELECT id FROM journal_entries
                             WHERE reference = g.reference
                               AND company_id = g.company_id LIMIT 1)
         JOIN accounts a ON a.id = l.account_id
        WHERE g.company_id = $1 AND g.source_type = $2 AND g.source_id = $3
        GROUP BY a.account_number, l.debit, l.credit, l.id
        ORDER BY a.account_number`,
      [COMPANY, sourceType, sourceId],
    );
    return rows as Array<{ acct: string; debit: number; credit: number }>;
  };

  /** Assert an account was debited (or credited) by an exact amount. */
  const hasLine = (
    lines: Array<{ acct: string; debit: number; credit: number }>,
    acct: string,
    side: 'debit' | 'credit',
    amount: number,
  ) => lines.some((l) => l.acct === acct && near(l[side], amount));

  const invariants = async (label: string) => {
    const checks: Array<[string, string]> = [
      [
        'I1 global imbalance',
        `SELECT 1 FROM journal_entry_lines HAVING sum(debit) <> sum(credit)`,
      ],
      [
        'I2 unbalanced entry',
        `SELECT 1 FROM journal_entry_lines GROUP BY entry_id HAVING sum(debit) <> sum(credit)`,
      ],
      [
        'I3 header/line mismatch',
        `SELECT 1 FROM journal_entries e
           JOIN (SELECT entry_id, sum(debit) d, sum(credit) c
                   FROM journal_entry_lines GROUP BY entry_id) l ON l.entry_id = e.id
          WHERE e.total_debits <> l.d OR e.total_credits <> l.c`,
      ],
      [
        'I4 bad line shape',
        `SELECT 1 FROM journal_entry_lines
          WHERE (debit > 0 AND credit > 0) OR (debit = 0 AND credit = 0)
             OR debit < 0 OR credit < 0`,
      ],
      [
        'I5 accounting equation',
        `SELECT 1 FROM (
           SELECT a.company_id,
             sum(CASE WHEN a.type='asset' THEN l.debit-l.credit ELSE 0 END)::numeric(18,4) assets,
             ( sum(CASE WHEN a.type='liability' THEN l.credit-l.debit ELSE 0 END)
             + sum(CASE WHEN a.type='equity'    THEN l.credit-l.debit ELSE 0 END)
             + sum(CASE WHEN a.type='revenue'   THEN l.credit-l.debit ELSE 0 END)
             - sum(CASE WHEN a.type='expense'   THEN l.debit-l.credit ELSE 0 END))::numeric(18,4) lei
           FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
           GROUP BY a.company_id
         ) t WHERE assets <> lei`,
      ],
      ['I8 invoice math', `SELECT 1 FROM invoices WHERE total - amount_paid <> balance`],
      ['I11 negative stock', `SELECT 1 FROM inventory_items WHERE quantity_on_hand < 0`],
      // Inventory subledger must tie to its control account. Any path that
      // moves GL 1200 by one amount while moving qty x unit_cost by another
      // shows up here — which is exactly how freezing the credit-memo restock
      // cost was caught breaking the weighted average.
      [
        // Tolerance is the arithmetic bound of a 4dp average, not a fudge:
        // each item can be off by qty/2 x 10^-4 from the exact value the GL
        // holds. Matches I13 in qa/invariants.sql.
        'inventory subledger = GL 1200',
        `SELECT 1 FROM (
           SELECT (SELECT COALESCE(SUM(l.debit-l.credit),0)
                     FROM journal_entry_lines l JOIN accounts a ON a.id=l.account_id
                    WHERE a.company_id = '${COMPANY}' AND a.account_number='1200') AS gl,
                  (SELECT COALESCE(SUM(quantity_on_hand*unit_cost),0)
                     FROM inventory_items WHERE company_id = '${COMPANY}') AS val,
                  (SELECT COALESCE(SUM(quantity_on_hand),0) * 0.00005 + 0.01
                     FROM inventory_items WHERE company_id = '${COMPANY}') AS tol
         ) t WHERE abs(t.gl - t.val) > t.tol`,
      ],
    ];
    for (const [name, sql] of checks) {
      const { rows } = await db.query(sql);
      ok(`[${label}] ${name}`, rows.length === 0, rows.slice(0, 2));
    }
  };

  await invariants('baseline');

  // Master data
  const customer = (data(await req('GET', '/customers?limit=1')) as any)?.data?.[0]
    ?? (data(await req('GET', '/customers?limit=1')) as any)?.[0];
  const vendorRes = data(await req('GET', '/vendors?limit=1')) as any;
  const vendor = vendorRes?.data?.[0] ?? vendorRes?.[0];
  const itemsRes = data(await req('GET', '/inventory/items?limit=50')) as any;
  const items = itemsRes?.data ?? itemsRes ?? [];
  const item = items.find((i: any) => n(i.unitCost) > 0 && n(i.quantityOnHand) > 10);
  ok('master data resolved', !!customer && !!vendor && !!item, {
    customer: !!customer,
    vendor: !!vendor,
    item: !!item,
  });
  if (!customer || !vendor || !item) throw new Error('missing master data');

  // ══ A. Credit memo: tax reversed, restock at frozen cost ═══════
  console.log('\n— A: credit memo (net + tax + restock)');
  const cmQty = 2;
  const cmPrice = 300;
  const cmTaxRate = 17;
  const cmNet = cmQty * cmPrice;
  const cmTax = (cmNet * cmTaxRate) / 100;
  const cmGross = cmNet + cmTax;
  const itemCostAtIssue = n(item.unitCost);
  const restockValue = cmQty * itemCostAtIssue;

  const arBefore = await acctBalance('1100');
  const invBefore = await acctBalance('1200');
  const qtyBefore = n(item.quantityOnHand);

  const cmRes = await req('POST', '/credit-memos', {
    customerId: customer.id,
    date: TODAY,
    reason: 'G3 acceptance — customer return',
    lines: [
      {
        description: item.name,
        quantity: String(cmQty),
        unitPrice: String(cmPrice),
        taxRate: String(cmTaxRate),
        itemId: item.id,
      },
    ],
  });
  ok('A credit memo created', cmRes.status === 201, cmRes.body);
  const cm = data(cmRes);

  const cmLines = await linesFor('credit_memo', cm.id);
  ok('A Dr Sales Revenue 4000 (net)', hasLine(cmLines, '4000', 'debit', cmNet), cmLines);
  ok('A Dr Sales Tax Payable 2300 (tax)', hasLine(cmLines, '2300', 'debit', cmTax), cmLines);
  ok('A Cr Accounts Receivable 1100 (gross)', hasLine(cmLines, '1100', 'credit', cmGross), cmLines);
  ok('A Dr Inventory 1200 at COST, not sale price',
    hasLine(cmLines, '1200', 'debit', restockValue), { expected: restockValue, cmLines });
  ok('A Cr COGS 5000 at the same cost',
    hasLine(cmLines, '5000', 'credit', restockValue), cmLines);

  const arAfter = await acctBalance('1100');
  ok('A AR control drops by the gross', near(arBefore - arAfter, cmGross), {
    before: arBefore, after: arAfter,
  });
  const invAfterCm = await acctBalance('1200');
  ok('A Inventory control rises by the cost', near(invAfterCm - invBefore, restockValue));

  const itemAfterCm = data(await req('GET', `/inventory/items/${item.id}`)) as any;
  ok('A stock restocked by the returned quantity',
    near(n(itemAfterCm.quantityOnHand) - qtyBefore, cmQty));

  const { rows: frozen } = await db.query(
    `SELECT restock_unit_cost::float8 AS c FROM credit_memo_lines WHERE credit_memo_id = $1`,
    [cm.id],
  );
  ok('A restock cost frozen on the line', near(n(frozen[0]?.c), itemCostAtIssue), frozen);

  await invariants('after credit memo');

  // ══ B. Void after the average cost DRIFTS ══════════════════════
  // This is the defect this gap surfaced: the void used to re-read
  // item.unitCost, so a purchase in between made the reversal a different
  // size from the original and left residue behind.
  console.log('\n— B: credit memo void after the average cost drifts');

  // Drift the average the way it actually happens in production: receive
  // stock at a higher price. Going through the PO receipt (rather than
  // writing unit_cost directly) re-averages AND posts the matching Inventory
  // entry, so the valuation report keeps tying to GL 1200 and this suite
  // leaves the books consistent for whatever runs after it.
  const driftPo = data(await req('POST', '/purchase-orders', {
    vendorId: vendor.id,
    orderDate: TODAY,
    lines: [
      {
        description: item.name,
        orderedQty: '40',
        unitCost: String(Math.round(itemCostAtIssue * 3)),
        itemId: item.id,
      },
    ],
  })) as any;
  const recvRes = await req('POST', `/purchase-orders/${driftPo.id}/receive`, {
    lines: [{ lineId: driftPo.lines[0].id, receivedQty: '40' }],
  });
  ok('B receipt at a higher price accepted',
    recvRes.status === 200 || recvRes.status === 201, recvRes.body);

  const drifted = await db.query(
    `SELECT unit_cost::float8 AS c FROM inventory_items WHERE id = $1`,
    [item.id],
  );
  ok('B average cost has drifted', !near(n(drifted.rows[0]?.c), itemCostAtIssue), {
    atIssue: itemCostAtIssue, now: n(drifted.rows[0]?.c),
  });

  const invBeforeVoid = await acctBalance('1200');
  const cogsBeforeVoid = await acctBalance('5000');

  const voidRes = await req('POST', `/credit-memos/${cm.id}/void`, {});
  ok('B void accepted', voidRes.status === 200 || voidRes.status === 201, voidRes.body);

  const voidLines = await linesFor('credit_memo_void', cm.id);
  ok('B void reverses Inventory at the ORIGINAL cost',
    hasLine(voidLines, '1200', 'credit', restockValue),
    { expected: restockValue, voidLines });
  ok('B void re-recognises COGS at the ORIGINAL cost',
    hasLine(voidLines, '5000', 'debit', restockValue), voidLines);

  const invAfterVoid = await acctBalance('1200');
  const cogsAfterVoid = await acctBalance('5000');
  ok('B Inventory control returns to its pre-void value',
    near(invBeforeVoid - invAfterVoid, restockValue), {
      before: invBeforeVoid, after: invAfterVoid, expected: restockValue,
    });
  ok('B COGS returns to its pre-void value',
    near(cogsAfterVoid - cogsBeforeVoid, restockValue));
  // Measure the memo/void PAIR in isolation. Comparing the raw 1200 balance
  // across the whole section would also catch the adjustment deliberately
  // injected above to force the drift, so net the two documents' own lines.
  const netOn = (
    ls: Array<{ acct: string; debit: number; credit: number }>,
    acct: string,
  ) => ls.filter((l) => l.acct === acct).reduce((s, l) => s + l.debit - l.credit, 0);
  ok('B memo + void net to ZERO on Inventory',
    near(netOn(cmLines, '1200') + netOn(voidLines, '1200'), 0), {
      memo: netOn(cmLines, '1200'), void: netOn(voidLines, '1200'),
    });
  ok('B memo + void net to ZERO on COGS',
    near(netOn(cmLines, '5000') + netOn(voidLines, '5000'), 0), {
      memo: netOn(cmLines, '5000'), void: netOn(voidLines, '5000'),
    });

  await invariants('after credit memo void');

  // ══ C. Vendor credit: the input-tax leg ════════════════════════
  console.log('\n— C: vendor credit (net + input tax)');
  const vcNet = 1000;
  const vcTaxRate = 17;
  const vcTax = (vcNet * vcTaxRate) / 100;
  const vcGross = vcNet + vcTax;

  const apBefore = await acctBalance('2000');
  const inputTaxBefore = await acctBalance('1300');

  const vcRes = await req('POST', '/vendor-credits', {
    vendorId: vendor.id,
    date: TODAY,
    reason: 'G3 acceptance — returned to vendor',
    lines: [{ description: 'Returned goods', amount: String(vcNet), taxRate: String(vcTaxRate) }],
  });
  ok('C vendor credit created', vcRes.status === 201, vcRes.body);
  const vc = data(vcRes);
  ok('C totals split net/tax/gross',
    near(n(vc.subtotal), vcNet) && near(n(vc.taxAmount), vcTax) && near(n(vc.total), vcGross),
    { subtotal: vc.subtotal, tax: vc.taxAmount, total: vc.total });

  const vcLines = await linesFor('vendor_credit', vc.id);
  ok('C Dr Accounts Payable 2000 (gross)', hasLine(vcLines, '2000', 'debit', vcGross), vcLines);
  ok('C Cr expense/COGS (net)', vcLines.some((l) => near(l.credit, vcNet)), vcLines);
  ok('C Cr Sales Tax Recoverable 1300 (input tax reversed)',
    hasLine(vcLines, '1300', 'credit', vcTax), vcLines);

  const apAfter = await acctBalance('2000');
  ok('C AP control drops by the gross', near(apAfter - apBefore, vcGross), {
    before: apBefore, after: apAfter,
  });
  const inputTaxAfter = await acctBalance('1300');
  ok('C recoverable input tax falls by the tax',
    near(inputTaxBefore - inputTaxAfter, vcTax), {
      before: inputTaxBefore, after: inputTaxAfter,
    });

  await invariants('after vendor credit');

  // ══ D. Inventory adjustment ════════════════════════════════════
  console.log('\n— D: inventory adjustment (write-down and write-up)');
  const itemNow = data(await req('GET', `/inventory/items/${item.id}`)) as any;
  const unitCostNow = n(itemNow.unitCost);
  const qtyNow = n(itemNow.quantityOnHand);
  const shrinkBy = 4;
  const shrinkValue = shrinkBy * unitCostNow;

  const invBeforeAdj = await acctBalance('1200');
  // 5400, not 6400: the reason now picks the account, and this is a 'damage'
  // write-down. 6400 keeps only the entries posted before that was true.
  const adjExpBefore = await acctBalance('5400');
  const { rows: jeCountBefore } = await db.query(
    `SELECT count(*)::int AS c FROM journal_entries WHERE company_id = $1`,
    [COMPANY],
  );

  const adjRes = await req('POST', `/inventory/items/${item.id}/adjust`, {
    itemId: item.id,
    newQty: String(qtyNow - shrinkBy),
    reason: 'damage',
    notes: 'G3 acceptance — shrinkage',
  });
  ok('D write-down accepted', adjRes.status === 200 || adjRes.status === 201, adjRes.body);

  const invAfterAdj = await acctBalance('1200');
  const adjExpAfter = await acctBalance('5400');
  ok('D Cr Inventory 1200 by the shrinkage value',
    near(invBeforeAdj - invAfterAdj, shrinkValue), {
      before: invBeforeAdj, after: invAfterAdj, expected: shrinkValue,
    });
  ok('D Dr Inventory Shrinkage – Damage 5400 by the same',
    near(adjExpAfter - adjExpBefore, shrinkValue));

  const { rows: jeCountAfter } = await db.query(
    `SELECT count(*)::int AS c FROM journal_entries WHERE company_id = $1`,
    [COMPANY],
  );
  ok('D quantity never moves without a journal entry',
    jeCountAfter[0].c > jeCountBefore[0].c, {
      before: jeCountBefore[0].c, after: jeCountAfter[0].c,
    });

  const { rows: adjRows } = await db.query(
    `SELECT journal_entry_id FROM inventory_adjustments
      WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [COMPANY],
  );
  ok('D the adjustment row links to its journal entry',
    !!adjRows[0]?.journal_entry_id, adjRows);

  // Write-up must be the exact mirror.
  const invBeforeUp = await acctBalance('1200');
  const upRes = await req('POST', `/inventory/items/${item.id}/adjust`, {
    itemId: item.id,
    newQty: String(qtyNow),
    reason: 'correction',
    notes: 'G3 acceptance — found stock',
  });
  ok('D write-up accepted', upRes.status === 200 || upRes.status === 201, upRes.body);
  const invAfterUp = await acctBalance('1200');
  ok('D write-up is the exact mirror of the write-down',
    near(invAfterUp - invBeforeUp, shrinkValue), {
      delta: invAfterUp - invBeforeUp, expected: shrinkValue,
    });

  // ── D2. The reason picks the offsetting account ────────────────
  //
  // It used to reach the journal memo and nothing else, so damage, theft and
  // obsolescence were pooled in one 6400 line and none of them could be told
  // apart in the P&L.
  console.log('\n— D2: reason drives the shrinkage account');
  const legacy6400Before = await acctBalance('6400');
  const REASON_ACCOUNTS: Array<[string, string]> = [
    ['damage', '5400'],
    ['theft', '5410'],
    ['obsolescence', '5420'],
    ['physical_count', '5430'],
    ['correction', '5430'],
    ['other', '5430'],
  ];

  for (const [reason, acct] of REASON_ACCOUNTS) {
    const before = await acctBalance(acct);
    const cur = data(await req('GET', `/inventory/items/${item.id}`)) as any;
    const curQty = n(cur.quantityOnHand);
    const curCost = n(cur.unitCost);
    const value = curCost; // one unit

    const res = await req('POST', `/inventory/items/${item.id}/adjust`, {
      itemId: item.id,
      newQty: String(curQty - 1),
      reason,
      notes: `reason-account mapping — ${reason}`,
    });
    ok(`D2 ${reason} accepted`, res.status === 200 || res.status === 201, res.body);

    const after = await acctBalance(acct);
    ok(`D2 ${reason} debits ${acct} by the value`,
      near(after - before, value), { before, after, expected: value });

    const adj = (data(res) as any)?.adjustment;
    ok(`D2 ${reason} records the account it used`,
      adj?.offsetAccountNumber === acct, adj?.offsetAccountNumber);

    // Put the unit back so the next reason starts from the same place. Uses
    // 'correction', which is the honest reason for undoing a test fixture.
    await req('POST', `/inventory/items/${item.id}/adjust`, {
      itemId: item.id,
      newQty: String(curQty),
      reason: 'correction',
      notes: `restore after ${reason}`,
    });
  }

  // No reason maps to 6400 any more, so the legacy account must be untouched
  // by everything above — it only holds entries posted before this change.
  const legacy6400After = await acctBalance('6400');
  ok('D2 legacy 6400 is never written to again',
    near(legacy6400After, legacy6400Before),
    { before: legacy6400Before, after: legacy6400After });

  // ── D3. Dating ─────────────────────────────────────────────────
  console.log('\n— D3: adjustment dating');
  const itemD3 = data(await req('GET', `/inventory/items/${item.id}`)) as any;
  const qtyD3 = n(itemD3.quantityOnHand);

  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const futureRes = await req('POST', `/inventory/items/${item.id}/adjust`, {
    itemId: item.id,
    newQty: String(qtyD3 - 1),
    reason: 'damage',
    date: future,
  });
  ok('D3 a future-dated adjustment is rejected',
    futureRes.status === 400 &&
      (futureRes.body?.error?.code ?? futureRes.body?.code) === 'FUTURE_DATE',
    { status: futureRes.status, body: futureRes.body });

  const qtyAfterFuture = n((data(await req('GET', `/inventory/items/${item.id}`)) as any).quantityOnHand);
  ok('D3 the rejected future adjustment moved no stock',
    near(qtyAfterFuture, qtyD3), { before: qtyD3, after: qtyAfterFuture });

  // Back-dating into an OPEN prior period is legitimate and must land there.
  const backDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const backRes = await req('POST', `/inventory/items/${item.id}/adjust`, {
    itemId: item.id,
    newQty: String(qtyD3 - 1),
    reason: 'damage',
    date: backDate,
    notes: 'back-dated into an open period',
  });
  ok('D3 back-dating into an open period is accepted',
    backRes.status === 200 || backRes.status === 201, backRes.body);

  const backAdj = (data(backRes) as any)?.adjustment;
  ok('D3 the adjustment carries the back-date', backAdj?.date === backDate, backAdj?.date);

  const { rows: backJe } = await db.query(
    `SELECT date::text AS date FROM journal_entries WHERE id = $1`,
    [backAdj?.journalEntryId],
  );
  ok('D3 the journal entry lands in the back-dated period',
    backJe[0]?.date === backDate, backJe[0]?.date);

  const { rows: backMove } = await db.query(
    `SELECT date::text AS date FROM inventory_movements
      WHERE company_id = $1 AND source_id = $2`,
    [COMPANY, backAdj?.id],
  );
  ok('D3 the movement shares that date',
    backMove[0]?.date === backDate, backMove[0]?.date);

  await req('POST', `/inventory/items/${item.id}/adjust`, {
    itemId: item.id,
    newQty: String(qtyD3),
    reason: 'correction',
    notes: 'restore after back-date test',
  });

  // ── D4. Reversal follows the account the original used ─────────
  //
  // reverseAdjustment() used to reverse against 6400 whatever the original
  // did, which after D2 would strand value in two accounts and eventually
  // show up as I13 inventory-vs-GL drift.
  console.log('\n— D4: reversal mirrors the original account');
  const itemD4 = data(await req('GET', `/inventory/items/${item.id}`)) as any;
  const qtyD4 = n(itemD4.quantityOnHand);
  const costD4 = n(itemD4.unitCost);

  const theftBefore = await acctBalance('5410');
  const invBeforeTheft = await acctBalance('1200');
  const theftRes = await req('POST', `/inventory/items/${item.id}/adjust`, {
    itemId: item.id,
    newQty: String(qtyD4 - 2),
    reason: 'theft',
    notes: 'to be reversed',
  });
  ok('D4 theft write-down accepted',
    theftRes.status === 200 || theftRes.status === 201, theftRes.body);
  const theftAdj = (data(theftRes) as any)?.adjustment;

  const revRes = await req('POST', `/inventory/adjustments/${theftAdj?.id}/reverse`, {});
  ok('D4 reversal accepted', revRes.status === 200 || revRes.status === 201, revRes.body);

  const theftAfter = await acctBalance('5410');
  const invAfterTheft = await acctBalance('1200');
  ok('D4 5410 nets back to where it started',
    near(theftAfter, theftBefore), { before: theftBefore, after: theftAfter });
  ok('D4 Inventory 1200 nets back to where it started',
    near(invAfterTheft, invBeforeTheft), { before: invBeforeTheft, after: invAfterTheft });

  const revLines = await linesFor('inventory_adjustment_void', (data(revRes) as any)?.adjustment?.id);
  ok('D4 the reversal credits 5410, not the legacy 6400',
    hasLine(revLines, '5410', 'credit', 2 * costD4), revLines);
  ok('D4 the reversal touches no other shrinkage account',
    !revLines.some((l) => l.acct === '6400'), revLines);

  const qtyAfterRev = n((data(await req('GET', `/inventory/items/${item.id}`)) as any).quantityOnHand);
  ok('D4 the quantity is restored', near(qtyAfterRev, qtyD4), { before: qtyD4, after: qtyAfterRev });

  await invariants('after inventory adjustments');

  // ══ E. Tax payment ═════════════════════════════════════════════
  console.log('\n— E: tax payment (remit the liability)');
  const rateRes = await req('POST', '/taxes/rates', {
    name: `G3 GST ${Date.now()}`,
    rate: '17',
    taxType: 'sales',
    isActive: true,
  });
  const rate = data(rateRes);
  ok('E tax rate available', !!rate?.id, rateRes.body);

  const payableBefore = await acctBalance('2300');
  const cashBefore = await acctBalance('1000');
  const liabBefore = data(await req('GET', '/taxes/liability')) as any;
  const remit = 250;

  const tpRes = await req('POST', '/taxes/payments', {
    taxRateId: rate.id,
    period: '2026-08',
    amount: String(remit),
    paymentDate: TODAY,
    reference: 'G3-ACCEPTANCE',
  });
  ok('E tax payment recorded', tpRes.status === 201, tpRes.body);
  const tp = data(tpRes);

  const tpLines = await linesFor('tax_payment', tp.id);
  ok('E Dr Sales Tax Payable 2300', hasLine(tpLines, '2300', 'debit', remit), tpLines);
  ok('E Cr Cash 1000', hasLine(tpLines, '1000', 'credit', remit), tpLines);

  const payableAfter = await acctBalance('2300');
  const cashAfter = await acctBalance('1000');
  // 2300 is a liability: a debit reduces it, so its debit-minus-credit net rises.
  ok('E the payable is relieved by the amount remitted',
    near(payableAfter - payableBefore, remit), {
      before: payableBefore, after: payableAfter,
    });
  ok('E cash falls by the amount remitted', near(cashBefore - cashAfter, remit));

  const liabAfter = data(await req('GET', '/taxes/liability')) as any;
  ok('E liability report shows the extra remittance',
    near(n(liabAfter?.taxRemitted) - n(liabBefore?.taxRemitted), remit), {
      before: liabBefore?.taxRemitted, after: liabAfter?.taxRemitted,
    });
  ok('E the payment row links to its journal entry', !!tp.journalEntryId, tp);

  // ══ F. Weighted-average costing behaves as labelled (G6) ═══════
  // costMethod used to accept fifo/lifo while every code path valued stock at
  // the running weighted average. Prove the one remaining method is real.
  console.log('\n— F: weighted-average costing (G6)');

  const sku = `G6-AVG-${Date.now()}`;
  const newItem = data(await req('POST', '/inventory/items', {
    sku,
    name: 'G6 costing probe',
    unitOfMeasure: 'unit',
    costMethod: 'average',
    unitCost: '0',
    sellingPrice: '200',
  })) as any;
  ok('F item created with costMethod=average', !!newItem?.id, newItem);

  const badMethod = await req('POST', '/inventory/items', {
    sku: `${sku}-BAD`,
    name: 'G6 rejects fifo',
    unitOfMeasure: 'unit',
    costMethod: 'fifo',
    unitCost: '0',
    sellingPrice: '200',
  });
  ok('F the API now REJECTS fifo instead of silently storing it',
    badMethod.status === 400, badMethod.status);

  // Buy 10 @ 100, then 10 @ 120 → average must be 110.
  const avgPo = data(await req('POST', '/purchase-orders', {
    vendorId: vendor.id,
    orderDate: TODAY,
    lines: [{ description: 'first lot', orderedQty: '10', unitCost: '100', itemId: newItem.id }],
  })) as any;
  await req('POST', `/purchase-orders/${avgPo.id}/receive`, {
    lines: [{ lineId: avgPo.lines[0].id, receivedQty: '10' }],
  });
  const avgPo2 = data(await req('POST', '/purchase-orders', {
    vendorId: vendor.id,
    orderDate: TODAY,
    lines: [{ description: 'second lot', orderedQty: '10', unitCost: '120', itemId: newItem.id }],
  })) as any;
  await req('POST', `/purchase-orders/${avgPo2.id}/receive`, {
    lines: [{ lineId: avgPo2.lines[0].id, receivedQty: '10' }],
  });

  const priced = data(await req('GET', `/inventory/items/${newItem.id}`)) as any;
  ok('F 10 @ 100 + 10 @ 120 → unit cost 110 (average, not FIFO 100 / LIFO 120)',
    near(n(priced.unitCost), 110), { unitCost: priced.unitCost });
  ok('F on hand is 20', near(n(priced.quantityOnHand), 20), priced.quantityOnHand);

  // Sell 5 → COGS 550 (5 × 110). FIFO would be 500, LIFO 600.
  const cogsBeforeSale = await acctBalance('5000');
  const saleRes = await req('POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: TODAY,
    dueDate: TODAY,
    status: 'sent',
    lines: [{ description: 'G6 sale', quantity: '5', unitPrice: '200', taxRate: '0', itemId: newItem.id }],
  });
  ok('F sale posted', saleRes.status === 201, saleRes.body);
  const cogsAfterSale = await acctBalance('5000');
  ok('F selling 5 costs 550 — average, not FIFO 500 or LIFO 600',
    near(cogsAfterSale - cogsBeforeSale, 550), {
      delta: cogsAfterSale - cogsBeforeSale,
    });

  const afterSale = data(await req('GET', `/inventory/items/${newItem.id}`)) as any;
  ok('F remaining inventory is 15 × 110 = 1650',
    near(n(afterSale.quantityOnHand) * n(afterSale.unitCost), 1650), {
      qty: afterSale.quantityOnHand, cost: afterSale.unitCost,
    });

  // ══ G. Reports are accrual basis, and say so (G8) ══════════════
  // accounting_method accepted cash|accrual, was NULL everywhere, and
  // reports.service.ts never read it. Prove the basis the reports actually
  // use, so the setting cannot drift away from the behaviour again.
  console.log('\n— G: accrual-basis reporting (G8)');

  const { rows: methodRows } = await db.query(
    `SELECT accounting_method FROM companies WHERE id = $1`,
    [COMPANY],
  );
  ok('G company records its basis explicitly',
    methodRows[0]?.accounting_method === 'accrual', methodRows);

  const cashRejected = await req('PATCH', `/companies/${COMPANY}`, {
    accountingMethod: 'cash',
  });
  ok('G the API REJECTS a cash-basis selection it cannot honour',
    cashRejected.status === 400, cashRejected.status);

  // An issued but UNPAID invoice must appear in the period's P&L. On a cash
  // basis it would not — this is what makes the books accrual.
  const periodStart = TODAY.slice(0, 8) + '01';
  const plBefore = data(
    await req('GET', `/reports/profit-loss?startDate=${periodStart}&endDate=${TODAY}`),
  ) as any;

  const unpaid = await req('POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: TODAY,
    dueDate: '2099-12-31',
    status: 'sent',
    lines: [{ description: 'G8 unpaid', quantity: '1', unitPrice: '777', taxRate: '0' }],
  });
  ok('G unpaid invoice issued', unpaid.status === 201, unpaid.body);
  const unpaidInv = data(unpaid) as any;
  ok('G it really is unpaid', near(n(unpaidInv.amountPaid), 0), unpaidInv.amountPaid);

  const plAfter = data(
    await req('GET', `/reports/profit-loss?startDate=${periodStart}&endDate=${TODAY}`),
  ) as any;
  ok('G revenue is recognised at INVOICE date, with nothing collected',
    near(n(plAfter.revenue) - n(plBefore.revenue), 777), {
      before: plBefore.revenue, after: plAfter.revenue,
    });

  const bs = data(await req('GET', `/reports/balance-sheet?asOfDate=${TODAY}`)) as any;
  ok('G balance sheet still balances under the accrual basis',
    bs?.isBalanced === true, {
      assets: bs?.totalAssets,
      liabEquity: n(bs?.totalLiabilities) + n(bs?.totalEquity),
    });

  const tb = data(
    await req('GET', `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`),
  ) as any;
  ok('G trial balance still balances',
    near(n(tb?.totalDebits), n(tb?.totalCredits)), {
      dr: tb?.totalDebits, cr: tb?.totalCredits,
    });

  await invariants('final');

  await db.end();

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('SUITE ERROR:', e);
  process.exit(1);
});
