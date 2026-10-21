/**
 * FinMatrix — item photos and the Excel item import.
 * ===========================================================================
 *
 *   A. A photo uploaded to an item is straightened, stripped of its metadata
 *      and served as two JPEGs from signed links that need no login, carry
 *      Cross-Origin-Resource-Policy: cross-origin, refuse a tampered
 *      signature, and stop working when the photo is replaced or removed.
 *      Every inventory response that returns the item carries the links —
 *      the list, opening stock — and the batch lookup used by quotation PDFs
 *      answers only for this company's items.
 *   B. The template and the export download as .xlsx. A preview writes
 *      nothing and says, row by row, what would happen.
 *   C. The owner's commit creates and updates the valid rows, skips the bad
 *      ones, and posts opening stock as ONE journal entry that moves GL 1200,
 *      the movements and qty × cost by exactly the confirmed value. It refuses
 *      a value the owner did not confirm, a future date and a locked period.
 *      Committing the same file again changes nothing.
 *   D. Staff can import the catalogue, but their opening quantities are
 *      ignored with a warning and post nothing.
 *   E. (IMPORT_PERF=1) 1,000 new items with opening stock import in one
 *      request well inside Heroku's 30 s.
 *
 * Each run makes its own items, so it holds on books that already contain
 * data.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/inventory-media-import.acceptance.ts
 */
export {};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');
import sharp from 'sharp';
import * as ExcelJS from 'exceljs';

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const RUN = Date.now().toString().slice(-8);
const PERF = process.env.IMPORT_PERF === '1';

/** Today in the business zone. */
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
}).format(new Date());
const TOMORROW = new Date(Date.parse(TODAY) + 86_400_000).toISOString().slice(0, 10);

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
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;
const n = (v: unknown) => Number(v ?? 0) || 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let TOKEN = '';
let COMPANY = '';

async function send(method: string, path: string, body?: BodyInit, json = false, token?: string) {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  const auth = token ?? TOKEN;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { method, headers, body });
    if (res.status === 429 && attempt < 3) {
      const ms = path.startsWith('/auth') ? 65_000 : 15_000 * (attempt + 1);
      console.log(`    (throttled on ${path} — waiting ${Math.round(ms / 1000)}s)`);
      await wait(ms);
      continue;
    }
    return res;
  }
}
async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await send(method, path, body === undefined ? undefined : JSON.stringify(body), true, token);
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: parsed };
}
async function upload(path: string, form: FormData, token?: string) {
  const res = await send('POST', path, form, false, token);
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: parsed };
}
const data = (r: { body: any }) => r.body?.data ?? r.body;
const codeOf = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;

const fileForm = (field: string, buf: Buffer, name: string, type: string, extra: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.append(field, new Blob([buf as unknown as BlobPart], { type }), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
};
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** An .xlsx with the given header and rows on a sheet called Items. */
async function workbook(header: string[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Items');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: DB });
  await db.connect();

  console.log(`\nFinMatrix — item photos and Excel import → ${API}\n`);
  const login = await req('POST', '/auth/signin', { email: EMAIL, password: PASSWORD });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  if (!TOKEN) throw new Error(`login failed: ${JSON.stringify(login.body)}`);

  /** GL 1200, Σ movement value and Σ qty × cost — the three things that must move together. */
  const books = async () => {
    const { rows } = await db.query(
      `SELECT
         (SELECT COALESCE(SUM(g.debit - g.credit), 0) FROM general_ledger g
            JOIN accounts a ON a.id = g.account_id
           WHERE g.company_id = $1 AND a.account_number = '1200') AS gl,
         (SELECT COALESCE(SUM(value_change), 0) FROM inventory_movements WHERE company_id = $1) AS moves,
         (SELECT COALESCE(SUM(quantity_on_hand * unit_cost), 0) FROM inventory_items WHERE company_id = $1) AS valuation,
         (SELECT COUNT(*) FROM inventory_items WHERE company_id = $1) AS items,
         (SELECT COUNT(*) FROM journal_entries WHERE company_id = $1) AS entries`,
      [COMPANY],
    );
    return {
      gl: n(rows[0].gl),
      moves: n(rows[0].moves),
      valuation: n(rows[0].valuation),
      items: n(rows[0].items),
      entries: n(rows[0].entries),
    };
  };

  // ═══════════════════════════════════════════════════════════════
  console.log('— A. photos');
  const made = await req('POST', '/inventory/items', {
    sku: `PH-${RUN}`,
    name: `Photo sofa ${RUN}`,
    unitCost: '1000',
    sellingPrice: '1500',
  });
  const item = data(made);
  ok('A0 an item is created, with null photo links', made.status === 201 && item.imageUrl === null, made.body);

  // A landscape bitmap tagged "rotate 90° to display" — a portrait phone photo.
  const phonePhoto = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 180, g: 90, b: 30 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'TestPhone' } } })
    .toBuffer();
  const up = await upload(`/inventory/items/${item.id}/image`, fileForm('image', phonePhoto, 'sofa.jpg', 'image/jpeg'));
  const withPhoto = data(up);
  ok(
    'A1 uploading a photo returns the item with both signed links',
    up.status === 201 && /\/media\/item-images\/.+\/display\.jpg\?exp=\d+&sig=/.test(withPhoto?.imageUrl ?? '') &&
      /thumb\.jpg\?/.test(withPhoto?.thumbnailUrl ?? ''),
    up.body,
  );

  const thumbRes = await fetch(withPhoto.thumbnailUrl);
  const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
  const thumbMeta = await sharp(thumbBuf).metadata();
  ok(
    'A2 the thumbnail loads with no login, as a cross-origin JPEG',
    thumbRes.status === 200 &&
      thumbRes.headers.get('content-type') === 'image/jpeg' &&
      thumbRes.headers.get('cross-origin-resource-policy') === 'cross-origin',
    { status: thumbRes.status, headers: Object.fromEntries(thumbRes.headers) },
  );
  ok(
    'A3 it is upright (EXIF applied), at most 480 px, and carries no metadata',
    thumbMeta.width === 320 && thumbMeta.height === 480 && !thumbMeta.exif && !thumbMeta.orientation,
    { w: thumbMeta.width, h: thumbMeta.height, exif: !!thumbMeta.exif },
  );
  const displayRes = await fetch(withPhoto.imageUrl);
  const displayMeta = await sharp(Buffer.from(await displayRes.arrayBuffer())).metadata();
  ok('A4 the display rendition keeps the full 800 × 1200', displayMeta.width === 800 && displayMeta.height === 1200, displayMeta);

  const tampered = withPhoto.thumbnailUrl.replace(/sig=(.)/, (_: string, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`);
  const forged = await fetch(tampered);
  ok('A5 a tampered signature is refused', forged.status === 403, forged.status);
  const swapped = await fetch(withPhoto.thumbnailUrl.replace('/thumb.jpg', '/display.jpg'));
  ok('A6 a thumbnail signature does not open the display rendition', swapped.status === 403, swapped.status);

  const list = data(await req('GET', `/inventory/items?q=PH-${RUN}`));
  const listed = (Array.isArray(list) ? list : []).find((i: any) => i.id === item.id);
  ok('A7 the item list carries the same links', listed?.thumbnailUrl === withPhoto.thumbnailUrl, listed);

  const pdf = await upload(
    `/inventory/items/${item.id}/image`,
    fileForm('image', Buffer.from('%PDF-1.7'), 'brochure.pdf', 'application/pdf'),
  );
  ok('A8 a PDF is refused as a photo', pdf.status === 415, pdf.body);
  const disguised = await upload(
    `/inventory/items/${item.id}/image`,
    fileForm('image', Buffer.from('not really a jpeg'), 'x.jpg', 'image/jpeg'),
  );
  ok('A9 bytes that are not an image are refused even when labelled JPEG', disguised.status === 415 && codeOf(disguised) === 'IMAGE_UNREADABLE', disguised.body);

  const opened = await req('POST', `/inventory/items/${item.id}/opening-stock`, { quantity: '2', asOfDate: TODAY });
  ok('A10 opening stock answers with the item, links included', !!data(opened)?.item?.thumbnailUrl, opened.body);

  const stranger = '11111111-2222-4333-8444-555555555555';
  const batch = data(await req('GET', `/inventory/item-images?ids=${item.id},${stranger}`));
  ok(
    'A11 the batch lookup answers for this company’s item and nothing else',
    batch?.images?.[item.id]?.thumbnailUrl === withPhoto.thumbnailUrl && !(stranger in (batch?.images ?? {})),
    batch,
  );
  const badIds = await req('GET', `/inventory/item-images?ids=not-a-uuid`);
  ok('A12 a malformed id list is a 400', badIds.status === 400 && codeOf(badIds) === 'INVALID_IDS', badIds.body);

  const replacement = await sharp({
    create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const replaced = data(
    await upload(`/inventory/items/${item.id}/image`, fileForm('image', replacement, 'sofa.png', 'image/png')),
  );
  const oldAfterReplace = await fetch(withPhoto.thumbnailUrl);
  ok(
    'A13 replacing the photo issues new links and retires the old ones',
    replaced?.thumbnailUrl && replaced.thumbnailUrl !== withPhoto.thumbnailUrl && oldAfterReplace.status === 404,
    { status: oldAfterReplace.status },
  );

  const removed = data(await req('DELETE', `/inventory/items/${item.id}/image`));
  const afterRemove = await fetch(replaced.thumbnailUrl);
  ok(
    'A14 removing the photo clears the links and the file stops being served',
    removed?.imageUrl === null && removed?.thumbnailUrl === null && afterRemove.status === 404,
    { removed, status: afterRemove.status },
  );
  const { rows: leftover } = await db.query(
    `SELECT COUNT(*) AS c FROM inventory_item_images WHERE item_id = $1`,
    [item.id],
  );
  ok('A15 no image rows are left behind', n(leftover[0].c) === 0, leftover);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— B. template and preview');
  const tpl = await send('GET', '/inventory/import/template');
  const tplBuf = Buffer.from(await tpl.arrayBuffer());
  ok(
    'B1 the template downloads as an .xlsx',
    tpl.status === 200 && tpl.headers.get('content-type') === XLSX && tplBuf.readUInt32BE(0) === 0x504b0304,
    tpl.status,
  );
  const exported = await send('GET', '/inventory/import/template?prefill=true');
  const exportBook = new ExcelJS.Workbook();
  await exportBook.xlsx.load((await exported.arrayBuffer()) as ArrayBuffer);
  const exportSkus: string[] = [];
  exportBook.getWorksheet('Items')!.eachRow((r, i) => {
    if (i > 1) exportSkus.push(String(r.getCell(1).value));
  });
  ok('B2 the export lists the company’s items', exportSkus.includes(`PH-${RUN}`), exportSkus.length);

  const before = await books();
  const header = ['SKU', 'Name', 'Unit cost', 'Selling price', 'Category', 'Opening quantity'];
  const file = await workbook(header, [
    [`IMP-${RUN}-A`, 'Walnut chair', 8500, 12500, 'Chairs', 4], // create + opening 34,000
    [`imp-${RUN}-b`, 'Brass lamp', 450.25, 799, 'Lighting', null], // create, no stock
    [`PH-${RUN}`, '', null, 1750, 'Sofas', 5], // update; has stock → opening ignored
    [`IMP-${RUN}-C`, '', 100, 150, null, null], // error: a new item needs a name
    [`IMP-${RUN}-A`, 'Again', 1, 1, null, null], // error: repeated SKU
  ]);
  const preview = await upload('/inventory/import/preview', fileForm('file', file, 'items.xlsx', XLSX));
  const pv = data(preview);
  ok(
    'B3 the preview counts creates, updates and errors',
    preview.status === 200 &&
      pv?.summary?.create === 2 &&
      pv?.summary?.update === 1 &&
      pv?.summary?.error === 2 &&
      pv?.summary?.openingStock?.items === 1 &&
      near(n(pv?.summary?.openingStock?.value), 34000),
    pv?.summary ?? preview.body,
  );
  const ph = pv?.rows?.find((r: any) => r.sku === `PH-${RUN}`);
  ok(
    'B4 a row for an item with stock lists its changes and warns its opening quantity is ignored',
    ph?.action === 'update' &&
      ph.changes.some((c: any) => c.field === 'sellingPrice') &&
      /already has stock history/.test(ph.warnings[0] ?? ''),
    ph,
  );
  ok(
    'B5 error rows say why, by Excel row number',
    pv?.rows?.find((r: any) => r.rowNumber === 5)?.errors?.[0] === 'Name is required for a new item.' &&
      /already on row 2/.test(pv?.rows?.find((r: any) => r.rowNumber === 6)?.errors?.[0] ?? ''),
    pv?.rows?.filter((r: any) => r.action === 'error'),
  );
  ok('B6 the preview wrote nothing', (await books()).items === before.items && (await books()).entries === before.entries);
  ok('B7 the patch never leaves the server', pv?.rows?.every((r: any) => !('patch' in r)));

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— C. owner commit');
  const unconfirmed = await upload('/inventory/import', fileForm('file', file, 'items.xlsx', XLSX, { openingStockDate: TODAY }));
  ok('C1 opening stock without a confirmed value is refused', unconfirmed.status === 409 && codeOf(unconfirmed) === 'IMPORT_PREVIEW_STALE', unconfirmed.body);
  const wrongValue = await upload(
    '/inventory/import',
    fileForm('file', file, 'items.xlsx', XLSX, { openingStockDate: TODAY, confirmOpeningStockValue: '33000' }),
  );
  ok('C2 a value other than the preview’s is refused', wrongValue.status === 409, wrongValue.body);
  const future = await upload(
    '/inventory/import',
    fileForm('file', file, 'items.xlsx', XLSX, { openingStockDate: TOMORROW, confirmOpeningStockValue: '34000' }),
  );
  ok('C3 a future date is refused', future.status === 400 && codeOf(future) === 'FUTURE_DATE', future.body);

  const { rows: lockRows } = await db.query(`SELECT books_locked_until FROM companies WHERE id = $1`, [COMPANY]);
  const originalLock = lockRows[0]?.books_locked_until ?? null;
  await db.query(`UPDATE companies SET books_locked_until = $2 WHERE id = $1`, [COMPANY, TODAY]);
  try {
    const locked = await upload(
      '/inventory/import',
      fileForm('file', file, 'items.xlsx', XLSX, { openingStockDate: TODAY, confirmOpeningStockValue: '34000' }),
    );
    ok('C4 a date inside a closed period is refused', locked.status === 400 && codeOf(locked) === 'PERIOD_LOCKED', locked.body);
  } finally {
    await db.query(`UPDATE companies SET books_locked_until = $2 WHERE id = $1`, [COMPANY, originalLock]);
  }
  ok('C5 none of the refusals wrote anything', (await books()).items === before.items && (await books()).entries === before.entries);

  const key = `imp-${RUN}-${Math.random().toString(36).slice(2)}`;
  const commitForm = () =>
    fileForm('file', file, 'items.xlsx', XLSX, { openingStockDate: TODAY, confirmOpeningStockValue: '34000.0000' });
  const committed = await (async () => {
    const res = await fetch(`${API}/inventory/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'x-company-id': COMPANY, 'Idempotency-Key': key },
      body: commitForm(),
    });
    return { status: res.status, body: await res.json() };
  })();
  const cm = data(committed);
  ok(
    'C6 the commit creates 2, updates 1 and skips the 2 bad rows',
    committed.status === 200 && cm?.applied?.created === 2 && cm?.applied?.updated === 1 && cm?.summary?.error === 2,
    cm?.applied ?? committed.body,
  );
  const after = await books();
  ok(
    'C7 GL 1200, the movements and qty × cost all rise by exactly 34,000',
    near(after.gl - before.gl, 34000) && near(after.moves - before.moves, 34000) && near(after.valuation - before.valuation, 34000),
    { gl: after.gl - before.gl, moves: after.moves - before.moves, valuation: after.valuation - before.valuation },
  );
  ok('C8 it is one journal entry', after.entries - before.entries === 1, after.entries - before.entries);
  const { rows: je } = await db.query(
    `SELECT e.reference, e.total_debits, e.memo,
            (SELECT COUNT(*) FROM journal_entry_lines l WHERE l.entry_id = e.id) AS lines
       FROM journal_entries e WHERE e.id = $1`,
    [cm?.applied?.journalEntryId],
  );
  ok(
    'C9 the entry debits Inventory per item and credits Opening Balance Equity once',
    je[0] && n(je[0].lines) === 2 && near(n(je[0].total_debits), 34000) && je[0].reference === cm.applied.journalReference,
    je[0],
  );
  const { rows: chair } = await db.query(
    `SELECT i.quantity_on_hand, i.unit_cost, m.source_type, m.value_change, m.reference
       FROM inventory_items i JOIN inventory_movements m ON m.item_id = i.id
      WHERE i.company_id = $1 AND i.sku = $2`,
    [COMPANY, `IMP-${RUN}-A`],
  );
  ok(
    'C10 the new chair holds 4 at 8,500 with one opening-stock movement',
    chair.length === 1 && n(chair[0].quantity_on_hand) === 4 && chair[0].source_type === 'opening_stock' && near(n(chair[0].value_change), 34000),
    chair,
  );
  const { rows: lamp } = await db.query(
    `SELECT sku, unit_cost FROM inventory_items WHERE company_id = $1 AND lower(sku) = lower($2)`,
    [COMPANY, `IMP-${RUN}-B`],
  );
  ok('C11 the lamp kept its SKU as typed and its 4-decimal cost', lamp[0]?.sku === `imp-${RUN}-b` && near(n(lamp[0]?.unit_cost), 450.25), lamp);

  const replay = await fetch(`${API}/inventory/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'x-company-id': COMPANY, 'Idempotency-Key': key },
    body: commitForm(),
  });
  ok('C12 a retried commit with the same key replays instead of running', replay.status === 200 && (await books()).entries === after.entries, replay.status);

  const again = await upload('/inventory/import', fileForm('file', file, 'items.xlsx', XLSX, { openingStockDate: TODAY }));
  const ag = data(again);
  ok(
    'C13 importing the same file again changes nothing',
    again.status === 200 && ag?.applied?.created === 0 && ag?.applied?.updated === 0 && ag?.summary?.openingStock?.items === 0,
    ag?.summary ?? again.body,
  );
  ok('C14 …and posts nothing', (await books()).entries === after.entries);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— D. staff');
  const staffUser = `imp${RUN}`;
  const staff = await req('POST', '/settings/users', {
    name: 'Import Staff',
    username: staffUser,
    password: 'Test1234!',
    role: 'staff',
  });
  if (staff.status === 201 || staff.status === 200) {
    const staffLogin = await req('POST', '/auth/signin', { email: staffUser, password: 'Test1234!' });
    const ST = data(staffLogin)?.tokens?.accessToken;
    const staffFile = await workbook(['SKU', 'Name', 'Unit cost', 'Opening quantity', 'Active'], [
      [`STF-${RUN}`, 'Staff side table', 2000, 3, 'Yes'],
      [`IMP-${RUN}-A`, '', null, null, 'No'],
    ]);
    const sp = data(await upload('/inventory/import/preview', fileForm('file', staffFile, 's.xlsx', XLSX), ST));
    ok(
      'D1 staff see their opening quantity and deactivation ignored, with warnings',
      sp?.openingStockAllowed === false &&
        sp?.summary?.openingStock?.items === 0 &&
        /Only the owner can record opening stock/.test(sp?.rows?.[0]?.warnings?.[0] ?? '') &&
        /Only the owner can activate or deactivate/.test(sp?.rows?.[1]?.warnings?.[0] ?? ''),
      sp,
    );
    const beforeStaff = await books();
    const sc = data(await upload('/inventory/import', fileForm('file', staffFile, 's.xlsx', XLSX), ST));
    const afterStaff = await books();
    ok(
      'D2 a staff import creates the item and posts nothing',
      sc?.applied?.created === 1 && afterStaff.entries === beforeStaff.entries && near(afterStaff.gl, beforeStaff.gl),
      sc?.applied,
    );
    const stillActive = await db.query(`SELECT is_active FROM inventory_items WHERE company_id = $1 AND sku = $2`, [
      COMPANY,
      `IMP-${RUN}-A`,
    ]);
    ok('D3 …and the owner’s item stays active', stillActive.rows[0]?.is_active === true);
    const staffPhoto = await upload(`/inventory/items/${sc?.rows?.[0]?.itemId}/image`, fileForm('image', phonePhoto, 'p.jpg', 'image/jpeg'), ST);
    ok('D4 staff can add a photo', staffPhoto.status === 201 && !!data(staffPhoto)?.thumbnailUrl, staffPhoto.body);
    await req('PATCH', `/settings/users/${data(staff)?.id}/deactivate`);
  } else {
    console.log(`    (no staff seat free — skipped D1–D4: ${codeOf(staff)})`);
  }

  // ═══════════════════════════════════════════════════════════════
  if (PERF) {
    console.log('\n— E. 1,000 items');
    const many = Array.from({ length: 1000 }, (_, i) => [`PERF-${RUN}-${i}`, `Perf item ${i}`, 10 + (i % 7), 20, 'Perf', 1 + (i % 3)]);
    const perfFile = await workbook(header, many);
    const value = many.reduce((s, r) => s + (r[2] as number) * (r[5] as number), 0);
    const startPerf = Date.now();
    const perf = await upload(
      '/inventory/import',
      fileForm('file', perfFile, 'perf.xlsx', XLSX, { openingStockDate: TODAY, confirmOpeningStockValue: String(value) }),
    );
    const ms = Date.now() - startPerf;
    ok(`E1 1,000 items with opening stock import in ${ms} ms (< 15 s)`, perf.status === 200 && data(perf)?.applied?.created === 1000 && ms < 15_000, data(perf)?.applied ?? perf.body);
    // Park them: re-import as inactive so they stay out of everyday lists.
    const park = await workbook(['SKU', 'Active'], many.map((r) => [r[0], 'No']));
    const t2 = Date.now();
    const parked = await upload('/inventory/import', fileForm('file', park, 'park.xlsx', XLSX));
    ok(`E2 …and 1,000 updates in ${Date.now() - t2} ms`, data(parked)?.applied?.updated === 1000, data(parked)?.applied ?? parked.body);
  }

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
