import AdmZip from 'adm-zip';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readExport } from '../../uploads/export-reader';
import { decodeText, parseIif, readUpload, sniffDelimiter } from '../../readers/read-upload';
import { SourceGrid } from '../../readers/read-upload';
import { parseAmount } from '../../parsers/amount.parser';
import { buildCanonical } from './canonical';
import { REPORT_PROFILES } from './profiles';
import { QUICKBOOKS_DESKTOP_PROFILE, QUICKBOOKS_ONLINE_PROFILE } from './profiles/quickbooks';
import { XERO_PROFILE, ZOHO_BOOKS_PROFILE } from './profiles/xero-zoho';
import { isStarterSheet, parseSourceReport, recogniseReport, reportDate, splitAccountCell } from './report-engine';

const sheet = (name: string, rows: unknown[][]): SourceGrid => ({
  name,
  rows: rows.map((cells, i) => ({ rowNumber: i + 1, cells: cells as any[] })),
});
const parse = (g: SourceGrid, preferred?: string) => {
  const r = recogniseReport(g, REPORT_PROFILES, preferred);
  if (!r) throw new Error(`not recognised: ${g.name}`);
  return parseSourceReport(g, r);
};

describe('report engine', () => {
  it('reads an account cell however a system prints it', () => {
    expect(splitAccountCell('1000 · Checking')).toMatchObject({ number: '1000', name: 'Checking' });
    expect(splitAccountCell('1000 - Cash in Hand')).toMatchObject({ number: '1000', name: 'Cash in Hand' });
    expect(splitAccountCell('Utilities:Gas & Electric')).toMatchObject({ number: null, name: 'Gas & Electric', path: 'Utilities:Gas & Electric' });
    expect(splitAccountCell('6100 · Utilities:6110 · Gas')).toMatchObject({ number: '6110', name: 'Gas' });
  });

  it('finds the report date in its title, in every form', () => {
    expect(reportDate(['As of September 30, 2026'], 'mdy')).toBe('2026-09-30');
    expect(reportDate(['As at 30/09/2026'], 'dmy')).toBe('2026-09-30');
    expect(reportDate(['', 'Sep 30, 26'], 'mdy')).toBe('2026-09-30');
    expect(reportDate(['July 1 - September 30, 2026'], 'mdy')).toBe('2026-09-30');
    expect(reportDate(['As on 30-Sep-2026'], 'dmy')).toBe('2026-09-30');
    expect(reportDate(['Trial Balance'], 'mdy')).toBeNull();
  });

  it('QuickBooks: a trial balance with no title over the account column, a footer that is not an account', () => {
    const r = parse(
      sheet('Trial Balance', [
        ['Co'],
        ['Trial Balance'],
        ['As of September 30, 2026'],
        [],
        ['', 'Debit', 'Credit'],
        ['Checking', 1500, null],
        ['Utilities:Electricity', 200, null],
        ['Sales', null, 1700],
        ['TOTAL', 1700, 1700],
        [],
        ['Wednesday, Oct 01, 2026 09:15 AM GMT+05:00'],
      ]),
      'quickbooks_online',
    );
    expect(r.source).toBe('quickbooks_online');
    expect(r.kind).toBe('trial_balance');
    expect(r.lines.map((l) => l.key)).toEqual(['Checking', 'Utilities:Electricity', 'Sales']);
    expect(r.problems).toEqual([]);
  });

  it('QuickBooks: aged detail grouped by aging bucket, each total proven', () => {
    const rows = [
      ['Co'],
      ['A/R Aging Detail'],
      ['As of September 30, 2026'],
      [],
      ['', 'Date', 'Transaction Type', 'Num', 'Customer', 'Due Date', 'Past Due', 'Amount', 'Open Balance'],
      ['Current'],
      ['', '09/20/2026', 'Invoice', '1001', 'Ali Traders', '10/20/2026', 0, 500, 500],
      ['Total for Current', '', '', '', '', '', '', 500, 500],
      ['1 - 30 days past due'],
      ['', '08/20/2026', 'Invoice', '1002', 'Bismillah Store', '09/19/2026', 11, 300, 250],
      ['', '08/25/2026', 'Credit Memo', '1003', 'Bismillah Store', '08/25/2026', 36, -50, -50],
      ['Total for 1 - 30 days past due', '', '', '', '', '', '', 250, 200],
      ['TOTAL', '', '', '', '', '', '', 750, 700],
    ];
    const r = parse(sheet('A/R Aging Detail', rows), 'quickbooks_online');
    expect(r.kind).toBe('aged_receivables');
    expect(r.lines.map((l) => [l.key, l.values.doc, l.values.amount])).toEqual([
      ['Ali Traders', '1001', '500'],
      ['Bismillah Store', '1002', '250'],
      ['Bismillah Store', '1003', '-50'],
    ]);
    expect(r.totals.map((t) => t.scope)).toEqual(['group', 'group', 'report']);
    expect(r.problems).toEqual([]);
    // A changed line no longer matches its bucket's printed total.
    rows[9][8] = 260;
    expect(parse(sheet('A/R Aging Detail', rows), 'quickbooks_online').problems.join(' ')).toMatch(/Total for 1 - 30 days past due.*add up to 210\.00/);
  });

  it('subtotals under headings are proven against their own lines, the grand total against all', () => {
    const r = parse(
      sheet('Inventory Valuation Summary', [
        ['Co'],
        ['Inventory Valuation Summary'],
        ['As of Sep 30, 2026'],
        [],
        ['', 'Item Description', 'On Hand', 'Avg Cost', 'Asset Value'],
        ['Inventory'],
        ['RICE', 'Rice', 10, 100, 1000],
        ['ATTA', 'Atta', 5, 40, 200],
        ['Total Inventory', '', null, null, 1200],
        ['TOTAL', '', null, null, 1200],
      ]),
      'quickbooks_desktop',
    );
    expect(r.lines).toHaveLength(2);
    expect(r.totals.map((t) => t.scope)).toEqual(['group', 'report']);
    expect(r.problems).toEqual([]);
  });

  it('a sheet written with decimal commas reads 1.500 as fifteen hundred', () => {
    const r = parse(
      sheet('TB', [
        ['Account ID', 'Account Description', 'Debit Amt', 'Credit Amt'],
        ['1000', 'Cash', '1.500,00', ''],
        ['3000', 'Capital', '', '1.500,00'],
        ['', 'Total:', '1.500,00', '1.500,00'],
      ]),
    );
    expect(r.lines.map((l) => l.values.debit ?? l.values.credit)).toEqual(['1500', '1500']);
    expect(r.problems).toEqual([]);
  });

  it('never takes a starter-like or ordinary sheet for a QuickBooks list', () => {
    const customers = sheet('Customers', [
      ['Customer code', 'Name', 'Phone'],
      ['C1', 'Ali', '0300'],
    ]);
    expect(recogniseReport(customers, REPORT_PROFILES, 'quickbooks_desktop')).toBeNull();
  });
});

describe('canonical sheets from QuickBooks', () => {
  it('numbers unnumbered accounts (controls get FinMatrix\'s own) and codes no parties', () => {
    const chart = parse(
      sheet('Account List', [
        ['Co'],
        ['Account List'],
        [],
        ['Account', 'Type', 'Detail Type'],
        ['Checking', 'Bank', 'Checking'],
        ['Accounts Receivable (A/R)', 'Accounts receivable (A/R)', 'Accounts Receivable (A/R)'],
        ['Inventory Asset', 'Other Current Assets', 'Inventory'],
        ['Owner Equity', 'Equity', "Owner's Equity"],
      ]),
      'quickbooks_online',
    );
    const tb = parse(
      sheet('Trial Balance', [
        ['Trial Balance'],
        ['As of September 30, 2026'],
        ['', 'Debit', 'Credit'],
        ['Checking', 100, null],
        ['Accounts Receivable (A/R)', 50, null],
        ['Inventory Asset', 25, null],
        ['Owner Equity', null, 175],
        ['TOTAL', 175, 175],
      ]),
      'quickbooks_online',
    );
    const out = buildCanonical([chart, tb], QUICKBOOKS_ONLINE_PROFILE, { openingDate: '2026-09-30', accepted: () => false, existingAccounts: ['1000', '1100', '1200', '2000', '3100'] });
    const accounts = out.grids.find((g) => g.name.startsWith('Accounts'))!.rows.slice(1).map((r) => [r.cells[0], r.cells[1], r.cells[3]]);
    expect(accounts).toEqual([
      ['18001', 'Checking', 'Bank'],
      ['1100', 'Accounts Receivable (A/R)', 'Accounts Receivable'],
      ['1200', 'Inventory Asset', 'Inventory'],
      ['38001', 'Owner Equity', 'Owner Equity'],
    ]);
    const tbRows = out.grids.find((g) => g.name.startsWith('Trial Balance'))!.rows.slice(1).map((r) => r.cells[0]);
    expect(tbRows).toEqual(['18001', '1100', '1200', '38001']);
    // The receivables balance has no aged receivables yet: asked for.
    expect(out.issues.map((i) => i.code)).toContain('SOURCE_REPORTS_MISSING');
  });

  it('a customer credit beyond its open invoices is held on an advances account only when accepted', () => {
    const chart = parse(sheet('ACCNT', [['NAME', 'ACCNTTYPE', 'ACCNUM'], ['Accounts Receivable', 'AR', '1100'], ['Equity', 'EQUITY', '3000'], ['Purchase Orders', 'NONPOSTING', '']]), 'quickbooks_desktop');
    const tb = parse(sheet('Trial Balance', [['', 'Sep 30, 26'], ['', 'Debit', 'Credit'], ['1100 · Accounts Receivable', null, 40], ['3000 · Equity', 40, null], ['TOTAL', 40, 40]]), 'quickbooks_desktop');
    const ar = parse(
      sheet('A_R Aging Detail', [
        ['A/R Aging Detail'],
        ['As of September 30, 2026'],
        ['', 'Type', 'Date', 'Num', 'Name', 'Due Date', 'Open Balance'],
        ['Current'],
        ['', 'Invoice', '09/01/2026', 'I1', 'Ali:Job 1', '09/30/2026', 60],
        ['', 'Payment', '09/10/2026', 'P1', 'Ali', '09/10/2026', -100],
        ['Total Current', '', '', '', '', '', -40],
        ['TOTAL', '', '', '', '', '', -40],
      ]),
      'quickbooks_desktop',
    );
    const run = (accepted: boolean) =>
      buildCanonical([chart, tb, ar], QUICKBOOKS_DESKTOP_PROFILE, { openingDate: '2026-09-30', accepted: (k) => accepted && k === 'customer-credits', existingAccounts: [] });
    const asked = run(false);
    expect(asked.issues.find((i) => i.code === 'SOURCE_NET_CREDIT')?.message).toMatch(/Ali 40\.00/);
    expect(asked.warnings.join(' ')).toMatch(/Ali:Job 1/);
    const held = run(true);
    expect(held.issues.filter((i) => i.severity === 'blocking')).toEqual([]);
    const tbOut = held.grids.find((g) => g.name.startsWith('Trial Balance'))!.rows.slice(1).map((r) => r.cells);
    expect(tbOut).toEqual([
      ['1100', 'Accounts Receivable', null, null],
      ['3000', 'Equity', '40.00', null],
      ['2400', 'Customer Advances (from QuickBooks Desktop)', null, '40.00'],
    ]);
    // The non-posting account carries nothing and is left out.
    expect(held.grids.find((g) => g.name.startsWith('Accounts'))!.rows.some((r) => r.cells[1] === 'Purchase Orders')).toBe(false);
  });
});

describe('Xero and Zoho Books', () => {
  const xeroAgedRows = () => [
    ['Aged Receivables Detail'],
    ['Indus Co'],
    ['As at 30 September 2026'],
    [],
    ['Invoice Date', 'Invoice Number', 'Invoice Reference', 'Due Date', 'Current', '< 1 Month', '1 Month', '2 Months', 'Older', 'Total'],
    ['Ali Traders'],
    ['01 Sep 2026', 'INV-0001', '', '01 Oct 2026', 500, null, null, null, null, 500],
    ['10 Aug 2026', 'INV-0002', '', '09 Sep 2026', null, 250, null, null, null, 250],
    ['Total Ali Traders', '', '', '', 500, 250, null, null, null, 750],
    ['Bismillah Store'],
    ['05 Jul 2026', 'INV-0003', '', '04 Aug 2026', null, null, 300, null, null, 300],
    ['Total Bismillah Store', '', '', '', null, null, 300, null, null, 300],
    ['Total', '', '', '', 500, 250, 300, null, null, 1050],
  ];

  it('Xero aged detail: the contact is the heading above its invoices, and every contact total is proven', () => {
    const rows = xeroAgedRows();
    const r = parse(sheet('Aged Receivables Detail', rows), 'xero');
    expect(r.source).toBe('xero');
    expect(r.kind).toBe('aged_receivables');
    expect(r.asOf).toBe('2026-09-30');
    expect(r.lines.map((l) => [l.key, l.values.doc, l.values.amount])).toEqual([
      ['Ali Traders', 'INV-0001', '500'],
      ['Ali Traders', 'INV-0002', '250'],
      ['Bismillah Store', 'INV-0003', '300'],
    ]);
    expect(r.problems).toEqual([]);
    rows[7][9] = 260;
    expect(parse(sheet('Aged Receivables Detail', rows), 'xero').problems.join(' ')).toMatch(/Total Ali Traders/);
  });

  it('Xero trial balance: "Sales (200)" gives the code, and the year-to-date pair is the one proven', () => {
    const r = parse(
      sheet('Trial Balance', [
        ['Trial Balance'],
        ['Indus Co'],
        ['As at 30 September 2026'],
        [],
        ['Account', 'Account Code', 'Account Type', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'],
        ['Assets'],
        ['Business Bank (090)', '', 'Bank', 900, null, 900, null],
        ['Revenue'],
        ['Sales (200)', '', 'Revenue', null, 300, null, 900],
        ['Total', '', '', 900, 300, 900, 900],
      ]),
      'xero',
    );
    expect(r.kind).toBe('trial_balance');
    expect(r.lines.map((l) => [l.values.number ?? null, l.name ?? l.key, l.values.ytdDebit ?? null, l.values.ytdCredit ?? null])).toEqual([
      ['090', 'Business Bank', '900', null],
      ['200', 'Sales', null, '900'],
    ]);
    // The month's columns do not balance (900 against 300); the year to date does.
    expect(r.problems).toEqual([]);
  });

  it('Zoho Books: a contact list says who is a customer and who a supplier', () => {
    const contacts = parse(
      sheet('Contacts', [
        ['Display Name', 'Contact Type', 'EmailID', 'Phone'],
        ['Ali Traders', 'customer', 'a@x.pk', '0300'],
        ['Karachi Mills', 'vendor', '', ''],
      ]),
      'zoho_books',
    );
    expect(contacts.kind).toBe('contact_list');
    expect(contacts.lines.map((l) => [l.key, l.values.contactType])).toEqual([
      ['Ali Traders', 'customer'],
      ['Karachi Mills', 'vendor'],
    ]);
  });

  it('Zoho Books: customers and vendors exported separately are each their own list, not a duplicate', () => {
    const head = ['Display Name', 'Company Name', 'EmailID', 'Phone'];
    const customers = parse(sheet('Customers', [head, ['Ali Traders', 'Ali Traders', '', ''], ['Quiet Customer', '', '', '']]), 'zoho_books');
    const vendors = parse(sheet('Vendors', [head, ['Karachi Mills', '', '', '']]), 'zoho_books');
    expect([customers.kind, vendors.kind]).toEqual(['customer_list', 'vendor_list']);
    const out = buildCanonical([customers, vendors], ZOHO_BOOKS_PROFILE, { openingDate: '2026-09-30', accepted: () => false, existingAccounts: [] });
    expect(out.issues.map((i) => i.code)).not.toContain('SOURCE_REPORT_DUPLICATE');
    expect(out.grids.find((g) => g.name.startsWith('Customers'))!.rows.slice(1).map((r) => r.cells[1])).toEqual(['Ali Traders', 'Quiet Customer']);
    expect(out.grids.find((g) => g.name.startsWith('Vendors'))!.rows.slice(1).map((r) => r.cells[1])).toEqual(['Karachi Mills']);
  });

  it('Xero: a contact with nothing open, on a list that does not say customer or supplier, is named, not guessed', () => {
    const contacts = parse(sheet('Contacts', [['*ContactName', 'EmailAddress', 'AccountNumber'], ['Ali Traders', '', ''], ['Hamza Brothers', '', '']]), 'xero');
    const ar = parse(sheet('Aged Receivables Detail', xeroAgedRows()), 'xero');
    const out = buildCanonical([contacts, ar], XERO_PROFILE, { openingDate: '2026-09-30', accepted: () => false, existingAccounts: [] });
    const customers = out.grids.find((g) => g.name.startsWith('Customers'))!.rows.slice(1).map((r) => r.cells[1]);
    expect(customers).toEqual(expect.arrayContaining(['Ali Traders', 'Bismillah Store']));
    expect(customers).not.toContain('Hamza Brothers');
    expect(out.warnings.join(' ')).toMatch(/Hamza Brothers/);
  });

  it('Zoho Books: the backup\'s invoice list is recognised and skipped, never read as open invoices', () => {
    const r = recogniseReport(
      sheet('Invoice', [
        ['Invoice Date', 'Invoice ID', 'Invoice Number', 'Invoice Status', 'Customer Name', 'Due Date', 'Total', 'Balance'],
        ['2026-09-01', '4600', 'INV-1', 'Paid', 'Ali Traders', '2026-10-01', 500, 0],
      ]),
      [ZOHO_BOOKS_PROFILE],
      'zoho_books',
    );
    expect(r?.spec.kind).toBe('transactions');
  });

  it('only a sheet laid out as a starter sheet counts as one — sharing three titles is not enough', () => {
    const starter = sheet('Open Invoices', [['Customer code or name', 'Invoice number', 'Invoice date', 'Due date', 'Original amount', 'Amount due']]);
    expect(isStarterSheet(starter)).toBe(true);
    const xero = sheet('Aged', [['Invoice Date', 'Invoice Number', 'Invoice Reference', 'Due Date', 'Current', '< 1 Month', '1 Month', '2 Months', 'Older', 'Total']]);
    expect(isStarterSheet(xero)).toBe(false);
  });
});

describe('a password-protected ZIP', () => {
  /** A real ZIP with every entry marked encrypted, as Zoho Books' backups are. */
  const locked = () => {
    const zip = new AdmZip();
    zip.addFile('Chart_of_Accounts.csv', Buffer.from('Account Name,Account Code,Account Type\nCash,1000,Cash\n'));
    const buf = zip.toBuffer();
    for (let i = 0; i < buf.length - 4; i++) {
      const sig = buf.readUInt32LE(i);
      if (sig === 0x04034b50) buf.writeUInt16LE(buf.readUInt16LE(i + 6) | 1, i + 6);
      if (sig === 0x02014b50) buf.writeUInt16LE(buf.readUInt16LE(i + 8) | 1, i + 8);
    }
    return buf;
  };

  it('is refused in plain words when uploaded directly', async () => {
    await expect(readUpload(locked(), 'backup.zip', { maxBytes: 25_000_000, maxRows: 1000 })).rejects.toThrow(/password-protected.*upload the files inside/);
  });

  it('is refused in plain words on the large-file route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-locked-'));
    const path = join(dir, 'backup.zip');
    writeFileSync(path, locked());
    try {
      await expect(readExport(path, 'backup.zip', { maxRows: 1000, inMemoryBytes: 25_000_000, maxXmlBytes: 1e8 })).rejects.toThrow(/password-protected.*upload the files inside/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reading text exports', () => {
  it('decodes UTF-16 and Windows-1252, and refuses binary', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name,Balance\nAli,100\n', 'utf16le')]);
    expect(decodeText(utf16)).toBe('Name,Balance\nAli,100\n');
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
    expect(decodeText(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
  });

  it('finds the delimiter even below one-cell title lines', () => {
    expect(sniffDelimiter('Company\nTrial Balance\nAccount\tDebit\tCredit\nCash\t1\t\n')).toBe('\t');
    expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';');
  });

  it('reads IIF lists as one sheet each, skipping transactions', () => {
    const iif = ['!HDR\tPROD', 'HDR\tQuickBooks', '!ACCNT\tNAME\tACCNTTYPE\tACCNUM', 'ACCNT\tChecking\tBANK\t1000', '!TRNS\tDATE', 'TRNS\t9/1/2026', '!CUST\tNAME', 'CUST\tAli'].join('\r\n');
    const sheets = parseIif(iif, 1000, 'lists.iif');
    expect(sheets.map((s) => [s.name, s.rows.length])).toEqual([
      ['ACCNT', 2],
      ['CUST', 2],
    ]);
  });

  it('a UTF-16, tab-separated export goes through readUpload', async () => {
    const text = 'Company\nTrial Balance\n\tDebit\tCredit\nChecking\t100\t\n';
    const out = await readUpload(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), 'Trial Balance.txt');
    expect(out.sheets[0].rows.find((r) => r.cells[0] === 'Checking')?.cells).toEqual(['Checking', '100', '']);
  });
});

describe('amounts as other countries write them', () => {
  it.each([
    ['$1,500.00', '1500'],
    ['($1,500.00)', '-1500'],
    ['£2,000.50', '2000.5'],
    ['USD 1,200', '1200'],
    ['1.500,00', '1500'],
    ['1 500,00', '1500'],
    ['1,20,000', '120000'],
  ])('%s → %s', (input, value) => {
    const r = parseAmount(input);
    expect(r.ok && r.amount?.value).toBe(value);
  });
});
