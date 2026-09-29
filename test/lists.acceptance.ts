/**
 * FinMatrix — the invoice and bill lists, over HTTP.
 * ==========================================================================
 * GET /invoices and GET /bills are what the app and web lists page and search
 * through. This checks what only HTTP can show:
 *
 *   A. The summary and pagination reach the client beside `data` — the
 *      response envelope used to drop them, so lists counted only the page
 *      they held — and `data` is still the bare array every client reads.
 *   B. Overdue is derived from the due date: a sent invoice nobody has paid,
 *      past due, lists and opens as overdue; the status filter follows what is
 *      displayed ("overdue" includes it, "sent" leaves it out); the summary's
 *      counts, outstanding and overdue agree with the rows.
 *   C. Paging: page 2 continues page 1 with no gaps or repeats.
 *   D. Search reaches past the first page: an old invoice is found by number
 *      and by its customer's name.
 *   E. Bills follow the same rules.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 npx ts-node -r tsconfig-paths/register test/lists.acceptance.ts
 */
export {};

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const RUN = Date.now().toString().slice(-8);

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`,
    );
  }
};
const near = (a: number, b: number) => Math.abs(a - b) <= 0.005;
const n = (v: unknown) => Number(v ?? 0) || 0;

let TOKEN = '';
let COMPANY = '';
async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
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

async function main() {
  console.log(`\nFinMatrix — invoice and bill lists → ${API}\n`);
  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  const customer = data(
    await req('POST', '/customers', { name: `Lists Customer ${RUN}` }),
  );
  const invoice = async (
    label: string,
    invoiceDate: string,
    dueDate: string,
    price: number,
    status = 'sent',
  ) => {
    const r = await req('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate,
      dueDate,
      status,
      lines: [
        {
          description: label,
          quantity: '1',
          unitPrice: String(price),
          taxRate: '0',
          lineKind: 'service',
        },
      ],
    });
    if (r.status >= 400)
      throw new Error(`invoice ${label}: ${JSON.stringify(r.body)}`);
    return data(r);
  };
  // Past due and unpaid; current; current and part-paid; a draft.
  const late = await invoice('late', day(-60), day(-30), 400);
  const current = await invoice('current', day(-5), day(25), 300);
  const part = await invoice('part', day(-4), day(26), 200);
  const draft = await invoice('draft', day(-3), day(27), 100, 'draft');
  const partPay = await req('POST', '/payments', {
    customerId: customer.id,
    paymentDate: day(0),
    paymentMethod: 'cash',
    amount: '50.00',
    applications: [{ invoiceId: part.id, amount: '50.00' }],
  });
  ok(
    'four invoices and a part-payment set up',
    partPay.status < 400,
    partPay.body,
  );

  // ── A. The envelope ───────────────────────────────────────────
  console.log('\n— A. summary and pagination reach the client');
  const all = await req('GET', `/invoices?customerId=${customer.id}`);
  ok(
    'A1 `data` is still the bare array of rows',
    Array.isArray(all.body?.data) && all.body.data.length === 4,
    all.body,
  );
  ok(
    'A2 the summary rides beside it',
    !!all.body?.summary && typeof all.body.summary.count === 'number',
  );
  ok(
    'A3 and the pagination',
    all.body?.pagination?.total === 4 && all.body?.pagination?.totalPages === 1,
    all.body?.pagination,
  );

  // ── B. Overdue, derived ───────────────────────────────────────
  console.log('\n— B. overdue is derived from the due date');
  const byId = Object.fromEntries(
    (all.body?.data ?? []).map((r: any) => [r.id, r]),
  );
  ok(
    'B1 the unpaid past-due invoice lists as overdue',
    byId[late.id]?.status === 'overdue',
    byId[late.id]?.status,
  );
  ok(
    'B2 current ones keep sent / partial; the draft stays draft',
    byId[current.id]?.status === 'sent' &&
      byId[part.id]?.status === 'partial' &&
      byId[draft.id]?.status === 'draft',
    [byId[current.id]?.status, byId[part.id]?.status, byId[draft.id]?.status],
  );
  const opened = data(await req('GET', `/invoices/${late.id}`));
  ok('B3 and opens as overdue', opened?.status === 'overdue', opened?.status);
  const overdueTab = await req(
    'GET',
    `/invoices?customerId=${customer.id}&status=overdue`,
  );
  ok(
    'B4 the overdue filter takes it',
    overdueTab.body?.data?.length === 1 &&
      overdueTab.body.data[0].id === late.id,
    overdueTab.body?.data?.map((r: any) => r.invoiceNumber),
  );
  const sentTab = await req(
    'GET',
    `/invoices?customerId=${customer.id}&status=sent`,
  );
  ok(
    'B5 the sent filter leaves it out',
    sentTab.body?.data?.length === 1 && sentTab.body.data[0].id === current.id,
    sentTab.body?.data?.map((r: any) => r.invoiceNumber),
  );
  const s = all.body?.summary ?? {};
  ok(
    'B6 counts by displayed status',
    s.count === 4 &&
      s.byStatus?.overdue?.count === 1 &&
      s.byStatus?.sent?.count === 1 &&
      s.byStatus?.partial?.count === 1 &&
      s.byStatus?.draft?.count === 1,
    s.byStatus,
  );
  ok(
    'B7 outstanding 400 + 300 + 150 = 850, overdue 400 — drafts owe nothing yet',
    near(n(s.outstanding), 850) && near(n(s.overdue), 400),
    { outstanding: s.outstanding, overdue: s.overdue },
  );
  ok(
    'B8 a status tab is a slice: the summary still counts every tab',
    overdueTab.body?.summary?.count === 4,
    overdueTab.body?.summary?.count,
  );

  // ── C. Paging ─────────────────────────────────────────────────
  console.log('\n— C. paging');
  const p1 = await req(
    'GET',
    `/invoices?customerId=${customer.id}&limit=3&page=1`,
  );
  const p2 = await req(
    'GET',
    `/invoices?customerId=${customer.id}&limit=3&page=2`,
  );
  const ids = [...(p1.body?.data ?? []), ...(p2.body?.data ?? [])].map(
    (r: any) => r.id,
  );
  ok(
    'C1 two pages of 3 hold all 4, each once',
    ids.length === 4 && new Set(ids).size === 4,
    ids.length,
  );
  ok(
    'C2 the pagination says so',
    p1.body?.pagination?.totalPages === 2 && p2.body?.pagination?.page === 2,
    p1.body?.pagination,
  );

  // ── D. Search past the first page ─────────────────────────────
  console.log('\n— D. search');
  const byNumber = await req(
    'GET',
    `/invoices?search=${encodeURIComponent(late.invoiceNumber)}&limit=5`,
  );
  ok(
    'D1 an invoice is found by its number, company-wide',
    (byNumber.body?.data ?? []).some((r: any) => r.id === late.id),
    byNumber.body?.data?.length,
  );
  const byName = await req(
    'GET',
    `/invoices?search=${encodeURIComponent(`Lists Customer ${RUN}`)}&limit=50`,
  );
  ok(
    "D2 and by its customer's name — all four, with a summary of just them",
    byName.body?.data?.length === 4 && byName.body?.summary?.count === 4,
    byName.body?.summary,
  );

  // ── E. Bills ──────────────────────────────────────────────────
  console.log('\n— E. bills');
  const vendor = data(
    await req('POST', '/vendors', { companyName: `Lists Vendor ${RUN}` }),
  );
  const bill = async (
    label: string,
    billDate: string,
    dueDate: string,
    amount: number,
  ) => {
    const r = await req('POST', '/bills', {
      vendorId: vendor.id,
      billNumber: `LST-${RUN}-${label}`,
      billDate,
      dueDate,
      status: 'open',
      lines: [{ description: label, amount: String(amount), taxRate: '0' }],
    });
    if (r.status >= 400)
      throw new Error(`bill ${label}: ${JSON.stringify(r.body)}`);
    return data(r);
  };
  const lateBill = await bill('LATE', day(-50), day(-20), 700);
  const dueBill = await bill('DUE', day(-2), day(28), 300);
  const bills = await req('GET', `/bills?vendorId=${vendor.id}`);
  ok(
    'E1 bills carry `data`, summary and pagination',
    Array.isArray(bills.body?.data) &&
      !!bills.body?.summary &&
      !!bills.body?.pagination,
  );
  const openTab = await req('GET', `/bills?vendorId=${vendor.id}&status=open`);
  ok(
    'E2 the open filter leaves out the bill that shows as overdue',
    openTab.body?.data?.length === 1 && openTab.body.data[0].id === dueBill.id,
    openTab.body?.data?.map((r: any) => r.billNumber),
  );
  const lateTab = await req(
    'GET',
    `/bills?vendorId=${vendor.id}&status=overdue`,
  );
  ok(
    'E3 the overdue filter takes it',
    lateTab.body?.data?.length === 1 && lateTab.body.data[0].id === lateBill.id,
    lateTab.body?.data?.map((r: any) => r.billNumber),
  );
  const bs = bills.body?.summary ?? {};
  ok(
    'E4 summary: 1000 outstanding, 700 of it overdue',
    near(n(bs.outstanding), 1000) &&
      near(n(bs.overdue), 700) &&
      bs.byStatus?.overdue?.count === 1 &&
      bs.byStatus?.open?.count === 1,
    bs,
  );
  const billSearch = await req(
    'GET',
    `/bills?search=${encodeURIComponent(`LST-${RUN}-LATE`)}`,
  );
  ok(
    'E5 a bill is found by its number',
    (billSearch.body?.data ?? []).some((r: any) => r.id === lateBill.id),
  );
  const opened2 = data(await req('GET', `/bills/${lateBill.id}`));
  ok(
    'E6 a bill opened on its own names its vendor, and shows as overdue',
    opened2?.vendorName === `Lists Vendor ${RUN}` &&
      opened2?.status === 'overdue',
    { vendorName: opened2?.vendorName, status: opened2?.status },
  );

  // ── F. Every paged list ───────────────────────────────────────
  // The invoice list stopping at 50 was one instance of a pattern: a list's
  // pagination and summary were dropped on the way out, so a client could
  // only ever see and count its first page. Each list here must hand out
  // every row exactly once across its pages, say how many there are, and —
  // where a client counts tabs — count them over everything, not a page.
  console.log('\n— F. every paged list reaches every row');
  const walk = async (path: string) => {
    const sep = path.includes('?') ? '&' : '?';
    const first = await req('GET', `${path}${sep}limit=50&page=1`);
    if (first.status === 403) return { skipped: true as const };
    const body = first.body ?? {};
    const pages: any[][] = [Array.isArray(body.data) ? body.data : []];
    const totalPages = body.pagination?.totalPages ?? 1;
    for (let pg = 2; pg <= Math.min(totalPages, 60); pg++) {
      const r = await req('GET', `${path}${sep}limit=50&page=${pg}`);
      pages.push(Array.isArray(r.body?.data) ? r.body.data : []);
    }
    const rows = pages.flat();
    return {
      skipped: false as const,
      body,
      rows, // Riders are keyed by the user they are.
      ids: rows.map((r) => r.id ?? r.userId),
    };
  };
  const lists: Array<{
    path: string;
    label: string;
    number?: string;
    summary?: boolean;
  }> = [
    {
      path: '/invoices',
      label: 'invoices',
      number: 'invoiceNumber',
      summary: true,
    },
    { path: '/bills', label: 'bills', number: 'billNumber', summary: true },
    {
      path: '/estimates',
      label: 'estimates',
      number: 'estimateNumber',
      summary: true,
    },
    {
      path: '/sales-orders',
      label: 'sales orders',
      number: 'orderNumber',
      summary: true,
    },
    {
      path: '/purchase-orders',
      label: 'purchase orders',
      number: 'poNumber',
      summary: true,
    },
    {
      path: '/credit-memos',
      label: 'credit memos',
      number: 'creditMemoNumber',
      summary: true,
    },
    {
      path: '/vendor-credits',
      label: 'vendor credits',
      number: 'vendorCreditNumber',
      summary: true,
    },
    { path: '/payments', label: 'payments', summary: true },
    { path: '/deliveries', label: 'deliveries', summary: true },
    { path: '/employees', label: 'employees' },
    { path: '/inventory/items', label: 'inventory items' },
    { path: '/inventory/movements', label: 'stock movements' },
    { path: '/delivery-personnel', label: 'riders' },
    { path: '/agencies', label: 'agencies' },
    { path: '/shadow-inventory', label: 'shadow inventory' },
    { path: '/taxes/payments', label: 'tax payments' },
    { path: '/taxes/rates', label: 'tax rates' },
    { path: '/notifications', label: 'notifications' },
  ];
  for (const l of lists) {
    const w = await walk(l.path);
    if (w.skipped) {
      console.log(
        `    (${l.label}: feature not enabled for this company — skipped)`,
      );
      continue;
    }
    const total = w.body.pagination?.total;
    ok(
      `F ${l.label}: rows and pagination arrive (${total ?? '?'} in all)`,
      Array.isArray(w.body.data) && typeof total === 'number',
      { keys: Object.keys(w.body) },
    );
    ok(
      `F ${l.label}: every page walked hands out each row once — ${w.ids.length} of ${total}`,
      w.ids.length === total && new Set(w.ids).size === w.ids.length,
      { got: w.ids.length, distinct: new Set(w.ids).size, total },
    );
    if (l.summary) {
      ok(
        `F ${l.label}: the summary counts all of them, not a page`,
        w.body.summary?.count === total,
        { summary: w.body.summary?.count, total },
      );
      const byStatus = w.body.summary?.byStatus ?? {};
      const [st, info] =
        (Object.entries(byStatus) as [string, any][]).find(
          ([, v]) => v.count > 0,
        ) ?? [];
      if (st && l.path !== '/payments') {
        const tab = await walk(`${l.path}?status=${st}`);
        ok(
          `F ${l.label}: the "${st}" tab holds exactly its ${info.count}`,
          !tab.skipped &&
            tab.rows.length === info.count &&
            tab.rows.every((r: any) => r.status === st),
          {
            got: tab.skipped ? 'skipped' : tab.rows.length,
            expected: info.count,
          },
        );
      }
    }
    if (l.number && w.rows.length > 0) {
      const oldest = w.rows[w.rows.length - 1];
      const found = await req(
        'GET',
        `${l.path}?search=${encodeURIComponent(oldest[l.number])}&limit=50`,
      );
      ok(
        `F ${l.label}: search reaches the oldest, ${oldest[l.number]}`,
        (found.body?.data ?? []).some((r: any) => r.id === oldest.id),
        found.body?.data?.length,
      );
    }
  }
  const payWalk = await walk('/payments');
  if (!payWalk.skipped) {
    const sum = payWalk.rows.reduce((t: number, p: any) => t + n(p.amount), 0);
    const held = payWalk.rows.reduce(
      (t: number, p: any) => t + n(p.unapplied),
      0,
    );
    ok(
      'F payments: the summary sums every receipt and what is held as credit',
      near(n(payWalk.body.summary?.amount), sum) &&
        near(n(payWalk.body.summary?.unapplied), held),
      { summary: payWalk.body.summary, sum, held },
    );
  }
  const onRoad = await walk(
    '/deliveries?statuses=pending,picked_up,in_transit,arrived',
  );
  if (!onRoad.skipped) {
    const expected = ['pending', 'picked_up', 'in_transit', 'arrived'].reduce(
      (t, s) => t + (onRoad.body.summary?.byStatus?.[s]?.count ?? 0),
      0,
    );
    ok(
      `F deliveries: a tab of several statuses holds exactly their ${expected}`,
      onRoad.rows.length === expected,
      { got: onRoad.rows.length, expected },
    );
  }
  // An item's own purchase orders, filtered by the server (the item page's
  // tab used to search the latest 100 orders' lines on the client).
  const poWalk = await walk('/purchase-orders');
  if (!poWalk.skipped) {
    const itemIds = new Map<string, number>();
    for (const po of poWalk.rows) {
      for (const id of new Set<string>(
        (po.lines ?? []).map((l: any) => l.itemId).filter(Boolean),
      )) {
        itemIds.set(id, (itemIds.get(id) ?? 0) + 1);
      }
    }
    const [itemId, expected] =
      [...itemIds.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (itemId) {
      const forItem = await walk(`/purchase-orders?itemId=${itemId}`);
      ok(
        `F purchase orders: ?itemId= returns every order with that item — ${expected}`,
        !forItem.skipped &&
          forItem.rows.length === expected &&
          forItem.rows.every((po: any) =>
            (po.lines ?? []).some((l: any) => l.itemId === itemId),
          ),
        { got: forItem.skipped ? 'skipped' : forItem.rows.length, expected },
      );
    }
  }

  // Delivery search on the server — the monitor's search box.
  const delWalk = await walk('/deliveries');
  const oldestDelivery = delWalk.skipped
    ? null
    : delWalk.rows[delWalk.rows.length - 1];
  if (oldestDelivery?.referenceNo) {
    const found = await req(
      'GET',
      `/deliveries?q=${encodeURIComponent(oldestDelivery.referenceNo)}&limit=50`,
    );
    ok(
      `F deliveries: search reaches the oldest, ${oldestDelivery.referenceNo}`,
      (found.body?.data ?? []).some((d: any) => d.id === oldestDelivery.id) &&
        found.body?.summary?.count === found.body?.pagination?.total,
      found.body?.pagination,
    );
  }

  // Report drill-downs page to the end: P&L line entries and aging documents.
  const drill = async (path: string, key: string) => {
    const seen: string[] = [];
    let total = -1;
    for (let pg = 1; pg <= 200; pg++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = data(await req('GET', `${path}${sep}limit=7&page=${pg}`));
      total = r?.total ?? 0;
      const got: any[] = r?.[key] ?? [];
      seen.push(...got.map((e) => e.id ?? e.documentId));
      if (!got.length || seen.length >= total) break;
    }
    return { seen, total };
  };
  const pl = await drill(
    `/reports/profit-loss/lines/4000/entries?startDate=2000-01-01&endDate=${day(0)}`,
    'entries',
  );
  ok(
    `F P&L drill-down: pages of 7 reach all ${pl.total} entries, each once`,
    pl.total > 7 &&
      pl.seen.length === pl.total &&
      new Set(pl.seen).size === pl.total,
    { got: pl.seen.length, distinct: new Set(pl.seen).size, total: pl.total },
  );
  const aging = data(await req('GET', '/reports/ar-aging'));
  const busiest = ((aging?.rows ?? []) as any[])[0];
  if (busiest) {
    const docs = await drill(
      `/reports/ar-aging/customers/${busiest.customerId}/documents`,
      'documents',
    );
    ok(
      `F aging drill-down: pages reach all ${docs.total} open invoices of ${busiest.customerName}`,
      docs.seen.length === docs.total && new Set(docs.seen).size === docs.total,
      { got: docs.seen.length, total: docs.total },
    );
  }

  // The account ledger and the audit log came back `{ data, pagination }`,
  // which the envelope cut to `data`: one page, no way to know of a second.
  const accounts = data(await req('GET', '/accounts'))?.accounts ?? [];
  const busiestAccount = accounts.find((a: any) => a.accountNumber === '4000');
  if (busiestAccount) {
    const ledger = await walk(`/accounts/${busiestAccount.id}/transactions`);
    const total = ledger.skipped ? -1 : ledger.body.pagination?.total;
    ok(
      `F account ledger: pagination arrives and every entry comes once — ${ledger.skipped ? 0 : ledger.ids.length} of ${total}`,
      !ledger.skipped &&
        typeof total === 'number' &&
        ledger.ids.length === total &&
        new Set(ledger.ids).size === total,
      { got: ledger.skipped ? 'skipped' : ledger.ids.length, total },
    );
  }
  const audit = await walk('/audit');
  if (!audit.skipped && audit.body.pagination) {
    ok(
      `F audit log: every entry comes once — ${audit.ids.length} of ${audit.body.pagination.total}`,
      audit.ids.length === audit.body.pagination.total &&
        new Set(audit.ids).size === audit.ids.length,
      { got: audit.ids.length, total: audit.body.pagination.total },
    );
  }

  // Customers and vendors nest their page under `data` (it survives the
  // envelope); a picker walks every page, so each row must come exactly once.
  const walkNested = async (path: string) => {
    const sep = path.includes('?') ? '&' : '?';
    const first = data(await req('GET', `${path}${sep}limit=50&page=1`));
    const rows: any[] = [...(first?.data ?? [])];
    const tp = first?.pagination?.totalPages ?? 1;
    for (let pg = 2; pg <= Math.min(tp, 60); pg++) {
      rows.push(
        ...(data(await req('GET', `${path}${sep}limit=50&page=${pg}`))?.data ??
          []),
      );
    }
    return { rows, total: first?.pagination?.total };
  };
  for (const path of ['/customers', '/vendors']) {
    const w = await walkNested(path);
    ok(
      `F ${path}: every page walked hands out each one once — ${w.rows.length} of ${w.total}`,
      w.rows.length === w.total &&
        new Set(w.rows.map((r: any) => r.id)).size === w.total,
      {
        got: w.rows.length,
        distinct: new Set(w.rows.map((r: any) => r.id)).size,
        total: w.total,
      },
    );
  }

  const approvals = await req('GET', '/inventory-approvals?limit=2');
  if (approvals.status !== 403) {
    ok(
      'F inventory approvals: `requests` is still the array, with its pagination beside it',
      Array.isArray(approvals.body?.data?.requests) &&
        typeof approvals.body?.data?.pagination?.total === 'number',
      approvals.body?.data && Object.keys(approvals.body.data),
    );
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
