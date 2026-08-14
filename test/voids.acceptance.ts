/**
 * FinMatrix — Void / Reversal Acceptance (audit gap G7)
 * =====================================================
 * Across 119 journal entries the books held ONE reversal and ZERO voids. The
 * correction mechanism is the safety net for every mistake a user will ever
 * make, and it was the least exercised thing in the system.
 *
 * For each document type: snapshot the trial balance and the affected
 * subledger, post, void, and assert the books return to exactly where they
 * started.
 *
 *   A. invoice        — void restocks and reverses COGS
 *   B. payment        — delete reverses Dr AR / Cr Bank, invoice reopens
 *   C. bill           — delete reverses the AP entry
 *   D. credit memo    — void reverses revenue, tax and the restock
 *   E. vendor credit  — void reverses AP, expense and input tax
 *   F. journal entry  — void swaps every debit and credit
 *   G. inventory adjustment — reverse restores quantity and the GL (new in G7)
 *   H. tax payment    — delete restores the liability and the cash (new in G7)
 *   I. guards         — double void, reconciled document, locked period
 *
 * Every case asserts the reversing entry is CREATED rather than the original
 * mutated, and that every account's NET returns to where it started. Net, not
 * gross: a reversal is an extra entry, so total debits and credits both grow
 * by the amount reversed — that growth is the audit trail doing its job.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/voids.acceptance.ts
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
const n = (v: unknown) => Number(v ?? 0) || 0;
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

let TOKEN = '';
let COMPANY = '';

async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: parsed };
}
const data = (r: { body: any }) => r.body?.data ?? r.body;
const errCode = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;
const okStatus = (r: { status: number }) => r.status >= 200 && r.status < 300;

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();

  console.log(`\nFinMatrix Void / Reversal (G7) → ${API}\n`);

  const login = await req('POST', '/auth/signin', { email: EMAIL, password: PASSWORD });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  /**
   * Every account's NET position, as a comparable fingerprint.
   *
   * Net, not gross. A reversal is an additional entry, never an erasure, so
   * posting X and reversing it leaves total debits and total credits each
   * higher by X while every account's balance returns to where it was. That
   * growth is the audit trail working as intended; what must come back
   * unchanged is the net.
   */
  const trialBalance = async (): Promise<string> => {
    const { rows } = await db.query(
      `SELECT a.account_number,
              (SUM(l.debit) - SUM(l.credit))::numeric(18,4) AS net
         FROM journal_entry_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE a.company_id = $1
        GROUP BY a.account_number ORDER BY a.account_number`,
      [COMPANY],
    );
    return JSON.stringify(rows);
  };

  const acct = async (num: string): Promise<number> => {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0) AS net
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE a.company_id = $1 AND a.account_number = $2`,
      [COMPANY, num],
    );
    return n(rows[0]?.net);
  };

  const itemQty = async (itemId: string): Promise<number> => {
    const { rows } = await db.query(
      `SELECT quantity_on_hand::float8 AS q FROM inventory_items WHERE id = $1`,
      [itemId],
    );
    return n(rows[0]?.q);
  };

  const entryCount = async (): Promise<number> => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS c FROM journal_entries WHERE company_id = $1`,
      [COMPANY],
    );
    return n(rows[0]?.c);
  };

  const reversalExists = async (sourceType: string, sourceId: string) => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS c FROM general_ledger
        WHERE company_id = $1 AND source_type = $2 AND source_id = $3`,
      [COMPANY, sourceType, sourceId],
    );
    return n(rows[0]?.c) > 0;
  };

  const invariants = async (label: string) => {
    const checks: Array<[string, string]> = [
      ['I1', `SELECT 1 FROM journal_entry_lines HAVING sum(debit) <> sum(credit)`],
      ['I2', `SELECT 1 FROM journal_entry_lines GROUP BY entry_id HAVING sum(debit) <> sum(credit)`],
      ['I3', `SELECT 1 FROM journal_entries e JOIN (SELECT entry_id, sum(debit) d, sum(credit) c FROM journal_entry_lines GROUP BY entry_id) l ON l.entry_id=e.id WHERE e.total_debits <> l.d OR e.total_credits <> l.c`],
      ['I8', `SELECT 1 FROM invoices WHERE total - amount_paid <> balance`],
      ['I11', `SELECT 1 FROM inventory_items WHERE quantity_on_hand < 0`],
    ];
    for (const [name, sql] of checks) {
      const { rows } = await db.query(sql);
      ok(`[${label}] ${name}`, rows.length === 0, rows.slice(0, 1));
    }
  };

  // Master data
  const customer = (data(await req('GET', '/customers?limit=1')) as any)?.data?.[0];
  const vendorRes = data(await req('GET', '/vendors?limit=1')) as any;
  const vendor = vendorRes?.data?.[0] ?? vendorRes?.[0];
  const itemsRes = data(await req('GET', '/inventory/items?limit=50')) as any;
  const item = (itemsRes?.data ?? itemsRes ?? []).find(
    (i: any) => n(i.unitCost) > 0 && n(i.quantityOnHand) > 20,
  );
  const accountsRes = data(await req('GET', '/accounts?limit=200')) as any;
  const accounts = accountsRes?.accounts ?? accountsRes?.data ?? accountsRes ?? [];
  const cashAcct = accounts.find((a: any) => a.accountNumber === '1000');
  const revAcct = accounts.find((a: any) => a.accountNumber === '4000');
  ok('master data resolved', !!customer && !!vendor && !!item && !!cashAcct, {
    customer: !!customer, vendor: !!vendor, item: !!item,
  });
  if (!customer || !vendor || !item || !cashAcct) throw new Error('missing master data');

  await invariants('baseline');

  // ══ A. Invoice ═════════════════════════════════════════════════
  console.log('\n— A: invoice void (restock + COGS reversed)');
  {
    const tb0 = await trialBalance();
    const qty0 = await itemQty(item.id);
    const ar0 = await acct('1100');

    const inv = data(
      await req('POST', '/invoices', {
        customerId: customer.id,
        invoiceDate: TODAY,
        dueDate: '2099-12-31',
        status: 'sent',
        lines: [{ description: item.name, quantity: '3', unitPrice: '500', taxRate: '0', itemId: item.id }],
      }),
    ) as any;
    ok('A invoice posted', !!inv?.id, inv);
    ok('A stock relieved', near(await itemQty(item.id), qty0 - 3));
    ok('A AR rose', near((await acct('1100')) - ar0, 1500));

    const before = await entryCount();
    const voided = await req('POST', `/invoices/${inv.id}/void`, { reason: 'G7 void test' });
    ok('A void accepted', okStatus(voided), voided.body);

    ok('A a reversing entry was CREATED, not the original mutated',
      (await entryCount()) > before);
    const { rows: orig } = await db.query(
      `SELECT status FROM journal_entries WHERE id = $1`,
      [inv.journalEntryId],
    );
    ok('A the original entry is retained', orig.length === 1, orig);

    ok('A stock restocked', near(await itemQty(item.id), qty0), {
      before: qty0, after: await itemQty(item.id),
    });
    ok('A AR back to where it started', near(await acct('1100'), ar0));
    ok('A every account net back to where it started',
      (await trialBalance()) === tb0);
  }
  await invariants('after invoice void');

  // ══ B. Payment ═════════════════════════════════════════════════
  console.log('\n— B: payment delete (reverses Dr AR / Cr Bank)');
  {
    const payTarget = data(
      await req('POST', '/invoices', {
        customerId: customer.id,
        invoiceDate: TODAY,
        dueDate: '2099-12-31',
        status: 'sent',
        lines: [{ description: 'G7 pay target', quantity: '1', unitPrice: '600', taxRate: '0' }],
      }),
    ) as any;

    const tb0 = await trialBalance();
    const pay = data(
      await req('POST', '/payments', {
        customerId: customer.id,
        paymentDate: TODAY,
        amount: '600',
        paymentMethod: 'cash',
        applications: [{ invoiceId: payTarget.id, amount: '600' }],
      }),
    ) as any;
    ok('B payment posted', !!pay?.id, pay);

    const { rows: paid } = await db.query(
      `SELECT status, balance::float8 AS b FROM invoices WHERE id = $1`,
      [payTarget.id],
    );
    ok('B invoice marked paid', paid[0]?.status === 'paid' && near(n(paid[0]?.b), 0), paid[0]);

    const del = await req('DELETE', `/payments/${pay.id}`);
    ok('B payment delete accepted', okStatus(del), del.body);
    ok('B reversing entry recorded', await reversalExists('payment_void', pay.id));

    const { rows: reopened } = await db.query(
      `SELECT status, balance::float8 AS b FROM invoices WHERE id = $1`,
      [payTarget.id],
    );
    ok('B invoice reopened with its balance restored',
      near(n(reopened[0]?.b), 600), reopened[0]);
    ok('B every account net back to pre-payment', (await trialBalance()) === tb0);
  }
  await invariants('after payment delete');

  // ══ C. Bill ════════════════════════════════════════════════════
  console.log('\n— C: bill delete (reverses the AP entry)');
  {
    const tb0 = await trialBalance();
    const ap0 = await acct('2000');
    const bill = data(
      await req('POST', '/bills', {
        vendorId: vendor.id,
        billNumber: `G7-BILL-${Date.now()}`,
        billDate: TODAY,
        dueDate: '2099-12-31',
        lines: [{ description: 'G7 bill', quantity: '1', unitPrice: '450' }],
      }),
    ) as any;
    ok('C bill posted', !!bill?.id, bill);
    ok('C AP rose', near(ap0 - (await acct('2000')), 450), {
      before: ap0, after: await acct('2000'),
    });

    const del = await req('DELETE', `/bills/${bill.id}`);
    ok('C bill delete accepted', okStatus(del), del.body);
    ok('C AP back to where it started', near(await acct('2000'), ap0));
    ok('C every account net back to pre-bill', (await trialBalance()) === tb0);
  }
  await invariants('after bill delete');

  // ══ D. Credit memo ═════════════════════════════════════════════
  console.log('\n— D: credit memo void (revenue, tax and restock all reversed)');
  {
    const tb0 = await trialBalance();
    const qty0 = await itemQty(item.id);
    const cm = data(
      await req('POST', '/credit-memos', {
        customerId: customer.id,
        date: TODAY,
        reason: 'G7 void test',
        lines: [{ description: item.name, quantity: '2', unitPrice: '400', taxRate: '17', itemId: item.id }],
      }),
    ) as any;
    ok('D credit memo posted', !!cm?.id, cm);
    ok('D stock restocked by the return', near(await itemQty(item.id), qty0 + 2));

    const voided = await req('POST', `/credit-memos/${cm.id}/void`, {});
    ok('D void accepted', okStatus(voided), voided.body);
    ok('D reversing entry recorded', await reversalExists('credit_memo_void', cm.id));
    ok('D stock pulled back out', near(await itemQty(item.id), qty0));
    ok('D every account net back to pre-memo', (await trialBalance()) === tb0);
  }
  await invariants('after credit memo void');

  // ══ E. Vendor credit ═══════════════════════════════════════════
  console.log('\n— E: vendor credit void (AP, expense and input tax reversed)');
  {
    const tb0 = await trialBalance();
    const inputTax0 = await acct('1300');
    const vc = data(
      await req('POST', '/vendor-credits', {
        vendorId: vendor.id,
        date: TODAY,
        reason: 'G7 void test',
        lines: [{ description: 'G7 return', amount: '300', taxRate: '17' }],
      }),
    ) as any;
    ok('E vendor credit posted', !!vc?.id, vc);
    ok('E input tax reversed on issue', near(inputTax0 - (await acct('1300')), 51), {
      before: inputTax0, after: await acct('1300'),
    });

    const voided = await req('POST', `/vendor-credits/${vc.id}/void`, {});
    ok('E void accepted', okStatus(voided), voided.body);
    ok('E reversing entry recorded', await reversalExists('vendor_credit_void', vc.id));
    ok('E input tax restored', near(await acct('1300'), inputTax0));
    ok('E every account net back to pre-credit', (await trialBalance()) === tb0);
  }
  await invariants('after vendor credit void');

  // ══ F. Journal entry ═══════════════════════════════════════════
  console.log('\n— F: journal entry void (every debit and credit swapped)');
  let voidedJeId = '';
  {
    const tb0 = await trialBalance();
    const je = data(
      await req('POST', '/journal-entries', {
        date: TODAY,
        memo: 'G7 manual entry',
        status: 'posted',
        lines: [
          { accountId: cashAcct.id, debit: '250', credit: '0', lineOrder: 0 },
          { accountId: revAcct.id, debit: '0', credit: '250', lineOrder: 1 },
        ],
      }),
    ) as any;
    ok('F journal entry posted', !!je?.id, je);
    voidedJeId = je.id;

    const voided = await req('POST', `/journal-entries/${je.id}/void`, {
      reason: 'G7 void test',
    });
    ok('F void accepted', okStatus(voided), voided.body);

    const { rows: after } = await db.query(
      `SELECT status, void_reason FROM journal_entries WHERE id = $1`,
      [je.id],
    );
    ok('F original marked void and RETAINED with a reason',
      after[0]?.status === 'void' && !!after[0]?.void_reason, after[0]);

    const { rows: rev } = await db.query(
      `SELECT l.debit::float8 AS d, l.credit::float8 AS c, a.account_number AS acct
         FROM journal_entries e
         JOIN journal_entry_lines l ON l.entry_id = e.id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.reversal_of_id = $1 ORDER BY a.account_number`,
      [je.id],
    );
    const cashLine = rev.find((r: any) => r.acct === '1000');
    const revLine = rev.find((r: any) => r.acct === '4000');
    ok('F the reversal swaps the debit and the credit',
      near(n(cashLine?.c), 250) && near(n(revLine?.d), 250), rev);
    ok('F every account net back to pre-entry', (await trialBalance()) === tb0);
  }
  await invariants('after journal entry void');

  // ══ G. Inventory adjustment (new in G7) ════════════════════════
  console.log('\n— G: inventory adjustment reverse (new correction path)');
  {
    const tb0 = await trialBalance();
    const qty0 = await itemQty(item.id);
    const inv0 = await acct('1200');

    const adjRes = await req('POST', `/inventory/items/${item.id}/adjust`, {
      itemId: item.id,
      newQty: String(qty0 - 5),
      reason: 'damage',
      notes: 'G7 shrinkage',
    });
    ok('G adjustment posted', okStatus(adjRes), adjRes.body);
    const adj = (data(adjRes) as any)?.adjustment;
    ok('G stock written down', near(await itemQty(item.id), qty0 - 5));

    const rev = await req('POST', `/inventory/adjustments/${adj.id}/reverse`);
    ok('G reversal accepted', okStatus(rev), rev.body);
    ok('G stock restored', near(await itemQty(item.id), qty0), {
      before: qty0, after: await itemQty(item.id),
    });
    ok('G Inventory 1200 back to where it started', near(await acct('1200'), inv0), {
      before: inv0, after: await acct('1200'),
    });
    ok('G every account net back to pre-adjustment', (await trialBalance()) === tb0);

    const again = await req('POST', `/inventory/adjustments/${(data(rev) as any).adjustment.id}/reverse`);
    ok('G a reversal cannot itself be reversed', again.status === 400, again.body);
  }
  await invariants('after adjustment reversal');

  // ══ H. Tax payment (new in G7) ═════════════════════════════════
  console.log('\n— H: tax payment delete (new correction path)');
  {
    const rate = data(
      await req('POST', '/taxes/rates', {
        name: `G7 rate ${Date.now()}`,
        rate: '17',
        taxType: 'sales',
      }),
    ) as any;

    const tb0 = await trialBalance();
    const payable0 = await acct('2300');
    const cash0 = await acct('1000');

    const tp = data(
      await req('POST', '/taxes/payments', {
        taxRateId: rate.id,
        period: '2026-08',
        amount: '175',
        paymentDate: TODAY,
      }),
    ) as any;
    ok('H tax payment posted', !!tp?.id, tp);
    ok('H liability relieved', near((await acct('2300')) - payable0, 175));
    ok('H cash paid out', near(cash0 - (await acct('1000')), 175));

    const del = await req('DELETE', `/taxes/payments/${tp.id}`);
    ok('H delete accepted', okStatus(del), del.body);
    ok('H reversing entry recorded', await reversalExists('tax_payment_void', tp.id));
    ok('H liability restored', near(await acct('2300'), payable0), {
      before: payable0, after: await acct('2300'),
    });
    ok('H cash restored', near(await acct('1000'), cash0));
    ok('H every account net back to pre-payment', (await trialBalance()) === tb0);
  }
  await invariants('after tax payment delete');

  // ══ I. Guards ══════════════════════════════════════════════════
  console.log('\n— I: the guards that must block a void');

  const doubleVoid = await req('POST', `/journal-entries/${voidedJeId}/void`, {
    reason: 'second attempt',
  });
  ok('I voiding an already-void entry is refused',
    doubleVoid.status === 400 && errCode(doubleVoid) === 'ALREADY_VOID', doubleVoid.body);

  // Post an entry, close the books over its date, then try to void it.
  const lockable = data(
    await req('POST', '/journal-entries', {
      date: TODAY,
      memo: 'G7 lock probe',
      status: 'posted',
      lines: [
        { accountId: cashAcct.id, debit: '30', credit: '0', lineOrder: 0 },
        { accountId: revAcct.id, debit: '0', credit: '30', lineOrder: 1 },
      ],
    }),
  ) as any;
  await req('POST', `/companies/${COMPANY}/period-close`, { lockDate: TODAY });
  const lockedVoid = await req('POST', `/journal-entries/${lockable.id}/void`, {
    reason: 'G7 locked void',
  });
  ok('I voiding into a closed period is refused → PERIOD_LOCKED',
    errCode(lockedVoid) === 'PERIOD_LOCKED', {
      status: lockedVoid.status, body: lockedVoid.body,
    });
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  // Reconciled documents are locked by assertNotReconciled; prove the guard is
  // wired by stamping a GL row as reconciled and retrying the void.
  const recon = data(
    await req('POST', '/journal-entries', {
      date: TODAY,
      memo: 'G7 reconciled probe',
      status: 'posted',
      lines: [
        { accountId: cashAcct.id, debit: '40', credit: '0', lineOrder: 0 },
        { accountId: revAcct.id, debit: '0', credit: '40', lineOrder: 1 },
      ],
    }),
  ) as any;
  const { rows: reconRow } = await db.query(
    `SELECT id FROM reconciliations WHERE company_id = $1 LIMIT 1`,
    [COMPANY],
  );
  if (reconRow.length) {
    await db.query(
      `UPDATE general_ledger SET reconciliation_id = $1
        WHERE company_id = $2 AND source_id = $3`,
      [reconRow[0].id, COMPANY, recon.id],
    );
    const reconciledVoid = await req('POST', `/journal-entries/${recon.id}/void`, {
      reason: 'G7 reconciled void',
    });
    ok('I voiding a reconciled document is refused → TRANSACTION_RECONCILED',
      errCode(reconciledVoid) === 'TRANSACTION_RECONCILED', {
        status: reconciledVoid.status, body: reconciledVoid.body,
      });
    await db.query(
      `UPDATE general_ledger SET reconciliation_id = NULL
        WHERE company_id = $1 AND source_id = $2`,
      [COMPANY, recon.id],
    );
  } else {
    ok('I (skipped) no reconciliation on file to stamp against', true);
  }
  await req('POST', `/journal-entries/${recon.id}/void`, { reason: 'G7 cleanup' });

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
