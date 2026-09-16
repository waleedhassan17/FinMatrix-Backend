/**
 * FinMatrix — QA fixes acceptance (purchasing, stock, credit, advances, ledger)
 * ============================================================================
 * Replays every issue QA raised and asserts the books come out right:
 *
 *   A. Purchase order: draft is a requisition, manual tax, receipt stock at
 *      landed cost, convert-to-bill with an empty body includes tax, billing
 *      per receipt, GRNI clears to exactly zero, edits refused after receipt.
 *   B. Numbering never reuses a number; search finds every document type.
 *   C. Customer receipt: the unapplied part goes to 2400 Customer Advances,
 *      applying it later posts Dr 2400 / Cr 1100, deleting mirrors exactly.
 *   D. Repair script reclassifies a legacy receipt once and only once.
 *   E. Sales lines must be stock items or declared services; backorders need
 *      confirmation; shipping beyond on-hand is refused.
 *   F. Credit limit: 107,250 against 100,000 needs a 7,250 advance or the
 *      owner's audited override.
 *   G. General ledger keeps a voided journal's original beside its reversal
 *      and carries opening balances.
 *
 * Usage: boot the API against a scratch database, then
 *   API_BASE=http://localhost:3100/api/v1 DATABASE_URL=postgres://… \
 *   DB_NAME=<same database> npm run test:qa-fixes
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');
const { execFileSync } = require('child_process');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.BUSINESS_TIMEZONE || 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const RUN = Date.now().toString(36).toUpperCase();

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
    console.log(`  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  }
};
const n = (v: unknown) => Number(v ?? 0) || 0;
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

let TOKEN = '';
let COMPANY = '';

async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
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
const errCode = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;
const errDetails = (r: { body: any }) => r.body?.error?.details;
const okStatus = (r: { status: number }) => r.status >= 200 && r.status < 300;

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();
  console.log(`\nFinMatrix QA fixes → ${API}  (business date ${TODAY})\n`);

  const login = await req('POST', '/auth/signin', { email: EMAIL, password: PASSWORD });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('owner signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  const sql = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;
  /** Net debit − credit posted to an account by the given journal entries. */
  const netOn = async (accountNumber: string, entryIds: string[]) => {
    const rows = await sql(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE a.company_id = $1 AND a.account_number = $2 AND l.entry_id = ANY($3::uuid[])`,
      [COMPANY, accountNumber, entryIds],
    );
    return n(rows[0]?.net);
  };
  const entriesFor = async (sourceIds: string[]) =>
    (
      await sql(
        `SELECT DISTINCT je.id FROM journal_entries je
           JOIN general_ledger g ON g.reference = je.reference AND g.company_id = je.company_id
          WHERE je.company_id = $1 AND g.source_id = ANY($2::uuid[])`,
        [COMPANY, sourceIds],
      )
    ).map((r: any) => r.id);

  const [registered] = await sql(`SELECT sales_tax_registered FROM companies WHERE id = $1`, [COMPANY]);
  await sql(`UPDATE companies SET sales_tax_registered = false, books_locked_until = NULL WHERE id = $1`, [COMPANY]);

  const accounts = (data(await req('GET', '/accounts?limit=300')) as any);
  const accountList: any[] = accounts?.accounts ?? accounts?.data ?? accounts ?? [];
  const expenseAcct = accountList.find((a) => a.accountNumber === '6300');
  const cashAcct = accountList.find((a) => a.accountNumber === '1000');

  const vendor = data(await req('POST', '/vendors', { companyName: `QA Vendor ${RUN}`, paymentTerms: 'net30' }));
  const itemRes = await req('POST', '/inventory/items', {
    sku: `QA-${RUN}`,
    name: `QA Paint ${RUN}`,
    unitOfMeasure: 'unit',
    sellingPrice: '2000',
  });
  const item = data(itemRes);
  ok('master data created', !!vendor?.id && !!item?.id && !!expenseAcct && !!cashAcct, {
    vendor: vendor?.id, item: itemRes.status, expenseAcct: !!expenseAcct,
  });

  // ── A. Purchase order ────────────────────────────────────────────────────
  console.log('\nA. Purchase order: requisition, manual tax, receipt, billing per receipt');
  const freeText = await req('POST', '/purchase-orders', {
    vendorId: vendor.id,
    orderDate: TODAY,
    lines: [{ description: 'Paint finishing', orderedQty: '1', unitCost: '100', taxRate: '0' }],
  });
  ok('A1 free-text PO line without an account is refused', errCode(freeText) === 'EXPENSE_ACCOUNT_REQUIRED', freeText.body);

  const badTax = await req('POST', '/purchase-orders', {
    vendorId: vendor.id,
    orderDate: TODAY,
    lines: [{ description: 'x', orderedQty: '1', unitCost: '100', taxRate: '150', lineKind: 'item', itemId: item.id }],
  });
  ok('A2 tax 150% is refused', badTax.status === 400, badTax.body);

  const poRes = await req('POST', '/purchase-orders', {
    vendorId: vendor.id,
    orderDate: TODAY,
    lines: [
      { description: 'Paint finishing', orderedQty: '150', unitCost: '1245', taxRate: '17', lineKind: 'item', itemId: item.id },
      { description: 'Freight', orderedQty: '1', unitCost: '1000', taxRate: '12.5', lineKind: 'expense', accountId: expenseAcct.id },
    ],
  });
  const po = data(poRes);
  ok('A3 PO saves with a manual 12.5% tax', okStatus(poRes) && po?.status === 'draft', poRes.body);
  ok('A4 PO total includes tax (219,622.50)', near(n(po?.total), 219622.5), po?.total);
  const [itemLine, freightLine] = [...(po?.lines ?? [])].sort((a: any, b: any) => a.lineOrder - b.lineOrder);

  const receiveDraft = await req('POST', `/purchase-orders/${po.id}/receive`, {
    lines: [{ lineId: itemLine.id, receivedQty: '1' }],
  });
  ok('A5 a requisition cannot be received', errCode(receiveDraft) === 'PO_NOT_ISSUED', receiveDraft.body);

  ok('A6 requisition is sent to the vendor', okStatus(await req('PATCH', `/purchase-orders/${po.id}/status`, { status: 'sent' })));
  const recv1 = await req('POST', `/purchase-orders/${po.id}/receive`, {
    lines: [
      { lineId: itemLine.id, receivedQty: '147' },
      { lineId: freightLine.id, receivedQty: '1' },
    ],
  });
  ok('A7 receive 147', okStatus(recv1) && data(recv1)?.status === 'partial', recv1.body);
  const [stock1] = await sql(`SELECT quantity_on_hand, unit_cost FROM inventory_items WHERE id = $1`, [item.id]);
  ok('A8 stock rises on receipt, before any bill or payment', near(n(stock1.quantity_on_hand), 147), stock1);
  ok('A9 landed cost includes non-recoverable tax (1,456.65)', near(n(stock1.unit_cost), 1456.65), stock1);

  const edit = await req('PATCH', `/purchase-orders/${po.id}`, {
    vendorId: vendor.id,
    orderDate: TODAY,
    lines: [{ description: 'x', orderedQty: '1', unitCost: '1', lineKind: 'item', itemId: item.id }],
  });
  ok('A10 a PO with receipts cannot be edited', errCode(edit) === 'PO_HAS_RECEIPTS', edit.body);

  const bill1Res = await req('POST', `/purchase-orders/${po.id}/create-bill`, {});
  const bill1 = data(bill1Res)?.bill;
  ok('A11 convert to bill with an empty body works', okStatus(bill1Res) && !!bill1?.id, bill1Res.body);
  ok('A12 the bill includes tax (215,252.55)', near(n(bill1?.total), 215252.55), bill1?.total);
  ok('A13 billId kept for older clients', data(bill1Res)?.billId === bill1?.id);

  const again = await req('POST', `/purchase-orders/${po.id}/create-bill`, {});
  ok('A14 nothing left to bill', errCode(again) === 'NOTHING_TO_BILL', again.body);

  await req('POST', `/purchase-orders/${po.id}/receive`, {
    lines: [
      { lineId: itemLine.id, receivedQty: '150' },
      { lineId: freightLine.id, receivedQty: '1' },
    ],
  });
  const bill2Res = await req('POST', `/purchase-orders/${po.id}/create-bill`, {});
  const bill2 = data(bill2Res)?.bill;
  ok('A15 goods received later are billed on a second bill (4,369.95)', near(n(bill2?.total), 4369.95), bill2Res.body);
  ok('A16 fully received and billed PO closes', data(bill2Res)?.po?.status === 'closed', data(bill2Res)?.po?.status);

  const poEntries = await entriesFor([po.id, bill1.id, bill2.id]);
  ok('A17 GRNI (2050) nets to exactly zero for the PO', near(await netOn('2050', poEntries), 0, 0.0001), await netOn('2050', poEntries));
  ok('A18 AP (2000) credited with both bills incl. tax', near(await netOn('2000', poEntries), -(215252.55 + 4369.95)));

  const del = await req('DELETE', `/bills/${bill2.id}`);
  const poAfterDelete = data(await req('GET', `/purchase-orders/${po.id}`));
  ok('A19 deleting a PO bill makes its goods billable again', okStatus(del) && poAfterDelete?.status === 'received' && n(poAfterDelete?.unbilledValueGross) > 4000, poAfterDelete?.status);
  const bill3 = data(await req('POST', `/purchase-orders/${po.id}/create-bill`, {}))?.bill;
  const poEntries2 = await entriesFor([po.id, bill1.id, bill2.id, bill3?.id]);
  ok('A20 re-billed, GRNI still exactly zero', !!bill3?.id && near(await netOn('2050', poEntries2), 0, 0.0001));

  // ── B. Numbering and search ──────────────────────────────────────────────
  console.log('\nB. Numbering never reuses a number; search covers every document type');
  const numCustomer = data(await req('POST', '/customers', { name: `QA Numbering ${RUN}` }));
  const soBody = {
    customerId: numCustomer.id,
    orderDate: TODAY,
    lines: [{ description: 'Installation', quantity: '1', unitPrice: '100', lineKind: 'service' }],
  };
  const so1 = data(await req('POST', '/sales-orders', soBody));
  await req('DELETE', `/sales-orders/${so1.id}`);
  const so2Res = await req('POST', '/sales-orders', soBody);
  ok('B1 after deleting an order the next one gets a NEW number', okStatus(so2Res) && data(so2Res)?.orderNumber !== so1.orderNumber, [so1.orderNumber, data(so2Res)?.orderNumber]);

  const parallel = await Promise.all(
    Array.from({ length: 6 }, () =>
      req('POST', '/invoices', {
        customerId: numCustomer.id,
        invoiceDate: TODAY,
        dueDate: TODAY,
        status: 'draft',
        lines: [{ description: 'Service', quantity: '1', unitPrice: '10', lineKind: 'service' }],
      }),
    ),
  );
  const numbers = parallel.map((r) => data(r)?.invoiceNumber);
  ok('B2 six simultaneous invoices get six different numbers', parallel.every(okStatus) && new Set(numbers).size === 6, numbers);

  const suffix = String(po.poNumber).slice(-4);
  const search = data(await req('GET', `/search?q=${encodeURIComponent(po.poNumber)}`)) as any;
  ok('B3 search finds the purchase order by number', (search?.results?.purchaseOrders ?? []).some((o: any) => o.id === po.id), Object.keys(search?.results ?? {}));
  const bySuffix = data(await req('GET', `/search?q=${suffix}`)) as any;
  ok('B4 searching the digits returns labelled buckets per document type', Array.isArray(bySuffix?.results?.purchaseOrders) && Array.isArray(bySuffix?.results?.invoices));

  // ── C. Receipts and customer advances ────────────────────────────────────
  console.log('\nC. Unapplied receipts are advances; applying them moves no cash');
  const payer = data(await req('POST', '/customers', { name: `QA Allama ${RUN}` }));
  const serviceLine = (desc: string, qty: string, price: string, tax = '0') => ({
    description: desc, quantity: qty, unitPrice: price, taxRate: tax, lineKind: 'service',
  });
  const invA = data(await req('POST', '/invoices', {
    customerId: payer.id, invoiceDate: TODAY, dueDate: TODAY, status: 'sent',
    lines: [serviceLine('Old balance', '1', '1200')],
  }));
  const invB = data(await req('POST', '/invoices', {
    customerId: payer.id, invoiceDate: TODAY, dueDate: TODAY, status: 'sent',
    lines: [serviceLine('Roar-X Drinks service', '1500', '65', '10')],
  }));
  ok('C1 invoices raised (1,200 and 107,250)', near(n(invA?.total), 1200) && near(n(invB?.total), 107250), [invA?.total, invB?.total]);

  const rcptRes = await req('POST', '/payments', {
    customerId: payer.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '107250',
    applications: [{ invoiceId: invA.id, amount: '1200' }],
  });
  const rcpt = data(rcptRes);
  ok('C2 receipt gets an RCT number', /^RCT-\d{4}-\d{4}$/.test(rcpt?.paymentNumber ?? ''), rcpt?.paymentNumber);
  const rcptEntry = [rcpt.journalEntryId];
  ok('C3 Dr Cash 107,250', near(await netOn('1000', rcptEntry), 107250));
  ok('C4 Cr A/R only the 1,200 applied', near(await netOn('1100', rcptEntry), -1200));
  ok('C5 Cr Customer Advances 106,050', near(await netOn('2400', rcptEntry), -106050));

  const adv = data(await req('GET', `/payments/customer/${payer.id}/advances`));
  ok('C6 the advance is listed for the customer', near(n(adv?.total), 106050), adv);

  const crossCustomer = await req('POST', `/payments/${rcpt.id}/apply`, {
    applications: [{ invoiceId: parallel[0] && data(parallel[0])?.id, amount: '1' }],
  });
  ok('C7 an advance cannot settle another customer’s invoice', crossCustomer.status >= 400, crossCustomer.body);

  const applyRes = await req('POST', `/payments/${rcpt.id}/apply`, {
    applications: [{ invoiceId: invB.id, amount: '106050' }],
  });
  const applied = data(applyRes);
  const applicationEntry = (applied?.applications ?? []).find((a: any) => a.invoiceId === invB.id)?.journalEntryId;
  ok('C8 applying the advance succeeds', okStatus(applyRes) && !!applicationEntry, applyRes.body);
  ok('C9 application posts Dr 2400 106,050 / Cr 1100 106,050, no cash',
    near(await netOn('2400', [applicationEntry]), 106050) &&
      near(await netOn('1100', [applicationEntry]), -106050) &&
      near(await netOn('1000', [applicationEntry]), 0));
  const invBAfter = data(await req('GET', `/invoices/${invB.id}`));
  ok('C10 invoice now owes only 1,200', near(n(invBAfter?.balance), 1200), invBAfter?.balance);

  const delRcpt = await req('DELETE', `/payments/${rcpt.id}`);
  const allRcptEntries = await entriesFor([rcpt.id]);
  ok('C11 deleting the receipt reverses everything exactly',
    okStatus(delRcpt) &&
      near(await netOn('1000', allRcptEntries), 0) &&
      near(await netOn('1100', allRcptEntries), 0) &&
      near(await netOn('2400', allRcptEntries), 0),
    allRcptEntries.length);
  const invBReopened = data(await req('GET', `/invoices/${invB.id}`));
  ok('C12 invoices reopen', near(n(invBReopened?.balance), 107250), invBReopened?.balance);

  const held = data(await req('POST', '/payments', {
    customerId: payer.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '5000', holdAsAdvance: true,
  }));
  ok('C13 holdAsAdvance keeps the whole receipt as an advance', (held?.applications ?? []).length === 0 && near(await netOn('2400', [held.journalEntryId]), -5000));

  // ── D. Repair script ─────────────────────────────────────────────────────
  console.log('\nD. Repair reclassifies a legacy receipt once');
  // Make `held` look like a receipt recorded before advances existed: its
  // remainder credited to A/R, flag false.
  const [ar] = await sql(`SELECT id FROM accounts WHERE company_id = $1 AND account_number = '1100'`, [COMPANY]);
  const [adv2400] = await sql(`SELECT id FROM accounts WHERE company_id = $1 AND account_number = '2400'`, [COMPANY]);
  await sql(`UPDATE journal_entry_lines SET account_id = $1 WHERE entry_id = $2 AND account_id = $3`, [ar.id, held.journalEntryId, adv2400.id]);
  await sql(`UPDATE general_ledger SET account_id = $1 WHERE source_id = $2 AND account_id = $3`, [ar.id, held.id, adv2400.id]);
  await sql(`UPDATE accounts SET balance = balance - 5000 WHERE id = $1`, [ar.id]);
  await sql(`UPDATE accounts SET balance = balance - 5000 WHERE id = $1`, [adv2400.id]);
  await sql(`UPDATE payments SET advance_posted = false WHERE id = $1`, [held.id]);

  const runRepair = (apply: boolean) =>
    execFileSync(
      'npx',
      ['ts-node', '-r', 'tsconfig-paths/register', 'src/database/repair-customer-advances.ts', '--company', COMPANY, ...(apply ? ['--apply'] : [])],
      { env: { ...process.env, LOG_LEVEL: 'error' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const dry = runRepair(false);
  const [stillLegacy] = await sql(`SELECT advance_posted FROM payments WHERE id = $1`, [held.id]);
  ok('D1 dry run lists the receipt and changes nothing', dry.includes(held.paymentNumber) && stillLegacy.advance_posted === false, dry.slice(-400));
  runRepair(true);
  const reclass = await sql(
    `SELECT count(*)::int AS c FROM general_ledger WHERE company_id = $1 AND source_type = 'payment_advance_reclass' AND source_id = $2`,
    [COMPANY, held.id],
  );
  const [fixed] = await sql(`SELECT advance_posted FROM payments WHERE id = $1`, [held.id]);
  ok('D2 apply posts the reclass and marks the receipt', reclass[0].c === 2 && fixed.advance_posted === true, reclass[0]);
  runRepair(true);
  const reclassAgain = await sql(
    `SELECT count(*)::int AS c FROM general_ledger WHERE company_id = $1 AND source_type = 'payment_advance_reclass' AND source_id = $2`,
    [COMPANY, held.id],
  );
  ok('D3 a second apply is a no-op', reclassAgain[0].c === 2, reclassAgain[0]);

  // ── E. Sales lines, backorders, shipping ─────────────────────────────────
  console.log('\nE. Stock items only, backorders confirmed, no shipping without stock');
  const buyer = data(await req('POST', '/customers', { name: `QA Buyer ${RUN}` }));
  const roarX = await req('POST', '/sales-orders', {
    customerId: buyer.id, orderDate: TODAY,
    lines: [{ description: 'Roar-X Drinks', quantity: '1500', unitPrice: '65', taxRate: '10' }],
  });
  ok('E1 a typed product line is refused', errCode(roarX) === 'LINE_ITEM_REQUIRED', roarX.body);
  const service = await req('POST', '/sales-orders', {
    customerId: buyer.id, orderDate: TODAY,
    lines: [{ description: 'Delivery charges', quantity: '1', unitPrice: '500', lineKind: 'service' }],
  });
  ok('E2 a declared service line is accepted', okStatus(service), service.body);
  const shortBody = {
    customerId: buyer.id, orderDate: TODAY,
    lines: [{ description: item.name, quantity: '500', unitPrice: '2000', itemId: item.id, lineKind: 'item' }],
  };
  const short = await req('POST', '/sales-orders', shortBody);
  ok('E3 ordering beyond available stock asks for confirmation', short.status === 409 && errCode(short) === 'BACKORDER_CONFIRMATION_REQUIRED' && (errDetails(short)?.lines ?? []).length === 1, short.body);
  const backorder = data(await req('POST', '/sales-orders', { ...shortBody, acceptBackorder: true }));
  ok('E4 confirmed backorder saves', !!backorder?.id);
  const detail = data(await req('GET', `/sales-orders/${backorder.id}`));
  ok('E5 detail shows the backorder quantity', detail?.hasBackorder === true && n(detail?.lines?.[0]?.backorderQty) > 0, detail?.lines?.[0]);
  const shipTooMuch = await req('POST', `/sales-orders/${backorder.id}/fulfill`, {
    lines: [{ lineId: detail.lines[0].id, quantityFulfilled: '500' }],
  });
  ok('E6 shipping more than on hand is refused', errCode(shipTooMuch) === 'INSUFFICIENT_STOCK', shipTooMuch.body);

  const freeItem = data(await req('POST', '/inventory/items', { sku: `QA-Z-${RUN}`, name: `QA Zero ${RUN}`, unitOfMeasure: 'unit' }));
  const zeroCost = await req('POST', '/invoices', {
    customerId: buyer.id, invoiceDate: TODAY, dueDate: TODAY, status: 'sent',
    lines: [{ description: 'Zero cost item', quantity: '1', unitPrice: '10', itemId: freeItem.id, lineKind: 'item' }],
  });
  ok('E7 a zero-cost item with no stock cannot be invoiced', errCode(zeroCost) === 'INSUFFICIENT_STOCK', zeroCost.body);

  // ── F. Credit limit ──────────────────────────────────────────────────────
  console.log('\nF. Credit limit needs an advance for the excess, or the owner’s override');
  const limited = data(await req('POST', '/customers', { name: `QA Credit ${RUN}`, creditLimit: '100000' }));
  const creditSoRes = await req('POST', '/sales-orders', {
    customerId: limited.id, orderDate: TODAY,
    lines: [{ description: 'Roar-X supply service', quantity: '1500', unitPrice: '65', taxRate: '10', lineKind: 'service' }],
  });
  const creditSo = data(creditSoRes);
  ok('F1 the order warns it would pass the limit', creditSo?.creditCheck?.withinLimit === false && near(n(creditSo?.creditCheck?.requiredAdvance), 7250), creditSo?.creditCheck);
  const blocked = await req('POST', `/sales-orders/${creditSo.id}/convert-to-invoice`, {});
  ok('F2 invoicing it is refused with the advance needed (7,250)', errCode(blocked) === 'CREDIT_LIMIT_EXCEEDED' && near(n(errDetails(blocked)?.requiredAdvance), 7250), blocked.body);
  await req('POST', '/payments', { customerId: limited.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '7250', holdAsAdvance: true });
  const allowed = await req('POST', `/sales-orders/${creditSo.id}/convert-to-invoice`, {});
  ok('F3 after a 7,250 advance it converts', okStatus(allowed), allowed.body);

  const tight = data(await req('POST', '/customers', { name: `QA Tight ${RUN}`, creditLimit: '1000' }));
  const overBody = {
    customerId: tight.id, invoiceDate: TODAY, dueDate: TODAY, status: 'sent',
    lines: [{ description: 'Consulting', quantity: '1', unitPrice: '5000', lineKind: 'service' }],
  };
  const over = await req('POST', '/invoices', overBody);
  ok('F4 an invoice past the limit is refused', errCode(over) === 'CREDIT_LIMIT_EXCEEDED', over.body);
  const overridden = await req('POST', '/invoices', { ...overBody, creditOverride: { reason: 'Cheque received, clearing Friday' } });
  ok('F5 the owner can override with a reason', okStatus(overridden), overridden.body);
  const audit = await sql(
    `SELECT count(*)::int AS c FROM operational_audit_events WHERE company_id = $1 AND action = 'credit_limit_override' AND target_id = $2`,
    [COMPANY, tight.id],
  );
  ok('F6 the override is audited', audit[0].c >= 1, audit[0]);
  const credit = data(await req('GET', `/customers/${tight.id}`)) as any;
  ok('F7 customer detail reports exposure', near(n(credit?.credit?.exposure), 5000), credit?.credit);

  // ── G. General ledger ────────────────────────────────────────────────────
  console.log('\nG. General ledger: voided journals and opening balances');
  const jeRes = await req('POST', '/journal-entries', {
    date: TODAY, memo: `QA void ${RUN}`, status: 'posted',
    lines: [
      { accountId: expenseAcct.id, debit: '123.45', credit: '0' },
      { accountId: cashAcct.id, debit: '0', credit: '123.45' },
    ],
  });
  const je = data(jeRes);
  await req('POST', `/journal-entries/${je.id}/void`, { reason: 'QA reversal' });
  const ledger = data(await req('GET', `/ledger?startDate=${TODAY}&endDate=${TODAY}&account=6300`)) as any;
  const original = (ledger?.entries ?? []).find((e: any) => e.sourceId === je.id);
  ok('G1 the voided original stays in the ledger, flagged', !!original && original.voided === true, original);
  ok('G2 its reversal is there too', (ledger?.entries ?? []).some((e: any) => e.memo?.includes('QA reversal') || (e.credit === 123.45 && e.sourceId !== je.id)));
  const [before] = await sql(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
       FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND a.account_number = '1000' AND e.date < $2
        AND (e.status = 'posted' OR (e.status = 'void' AND EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_id = e.id)))`,
    [COMPANY, TODAY],
  );
  const cashLedger = data(await req('GET', `/ledger?startDate=${TODAY}&endDate=${TODAY}&account=1000`)) as any;
  ok('G3 opening balance brought forward', near(n(cashLedger?.openingBalances?.[0]?.balance), n(before.net)), [cashLedger?.openingBalances?.[0], before.net]);

  // Leave nothing behind that changes other suites: they pick "the first
  // customer", which must not suddenly carry a credit limit.
  await sql(`UPDATE customers SET credit_limit = 0 WHERE id = ANY($1::uuid[])`, [[limited.id, tight.id]]);
  await sql(`UPDATE companies SET sales_tax_registered = $2 WHERE id = $1`, [COMPANY, registered?.sales_tax_registered ?? false]);
  await db.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
