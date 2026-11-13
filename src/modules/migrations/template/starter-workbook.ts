import * as ExcelJS from 'exceljs';
import { TARGET_SHEETS, TargetSheet } from '../targets';

const REQUIRED_FILL = 'FFBFDBFE';
const HEADER_FILL = 'FFE2E8F0';
const NOTE_FONT = 'FF64748B';

/**
 * The starter workbook (§1.5): one sheet per target, in order. Row 1 holds the
 * exact headers; row 2 an English instruction per column; row 3 the same in
 * Urdu; row 4 a filled example. Rows 2–4 start with a marker in column A
 * (HOW TO FILL / طریقہ / EXAMPLE) and the reader skips any row that does —
 * so an owner who leaves them in place imports nothing they did not type.
 *
 * Codes and numbers are text columns, so Excel keeps "0300-1234567" and
 * "00123" exactly as typed. A Read me sheet comes last so it never displaces
 * a data sheet from the order a reader expects.
 */
export async function buildStarterWorkbook(opts: {
  companyName: string;
  cutoverDate: string;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FinMatrix';
  workbook.created = new Date();

  for (const target of TARGET_SHEETS)
    addSheet(workbook, target, opts.cutoverDate);
  addReadMe(workbook, opts);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function addSheet(
  workbook: ExcelJS.Workbook,
  target: TargetSheet,
  cutover: string,
) {
  const sheet = workbook.addWorksheet(target.name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = target.fields.map((f) => ({
    header: f.header,
    key: f.key,
    width: Math.max(14, Math.min(40, f.header.length + 8)),
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.height = 20;
  target.fields.forEach((f, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: f.required ? REQUIRED_FILL : HEADER_FILL },
    };
    cell.note = `${f.required ? 'Required. ' : ''}${f.description}`;
    if (f.kind === 'code' || f.kind === 'text')
      sheet.getColumn(i + 1).numFmt = '@';
  });

  const en = sheet.addRow(
    target.fields.map((f, i) =>
      i === 0 ? `HOW TO FILL: ${f.description}` : f.description,
    ),
  );
  const ur = sheet.addRow(
    target.fields.map((f, i) =>
      i === 0 ? `طریقہ: ${f.descriptionUr}` : f.descriptionUr,
    ),
  );
  for (const row of [en, ur]) {
    row.font = { italic: true, color: { argb: NOTE_FONT } };
    row.alignment = { wrapText: true, vertical: 'top' };
    row.height = 42;
  }
  ur.alignment = { wrapText: true, vertical: 'top', readingOrder: 'rtl' };

  const example = sheet.addRow(
    target.fields.map((f, i) => {
      const v =
        f.kind === 'date' && f.key.endsWith('Date') && f.example
          ? f.example
          : f.example;
      return i === 0 ? `EXAMPLE ${v}`.trim() : v;
    }),
  );
  example.font = { color: { argb: NOTE_FONT } };

  if (target.key === 'trial_balance') {
    sheet.getCell('A1').note =
      `Balances at the start of the cutover date (${cutover}), i.e. at the close of the day before. Debits must equal credits.`;
  }
}

function addReadMe(
  workbook: ExcelJS.Workbook,
  opts: { companyName: string; cutoverDate: string },
) {
  const sheet = workbook.addWorksheet('Read me');
  sheet.columns = [
    { key: 'a', width: 24 },
    { key: 'b', width: 110 },
  ];
  sheet.addRow([`Moving ${opts.companyName} to FinMatrix`]).font = {
    bold: true,
    size: 14,
  };
  sheet.addRow([]);
  for (const line of [
    `Fill in each sheet as at the start of your cutover date, ${opts.cutoverDate}: every balance, open invoice, open bill and stock quantity as it stood at the close of business on the day before. Anything dated ${opts.cutoverDate} or later is entered in FinMatrix, which closes the books before that day.`,
    'Row 1 of each sheet holds the column names — leave them exactly as they are. Rows 2–4 are instructions and an example; you may delete them or leave them, FinMatrix ignores them.',
    'Columns with a blue header are required. Column order does not matter, and extra columns are ignored.',
    'Amounts may be typed as 1,20,000 or 120,000 or Rs 1,20,000. Dates as dd/mm/yyyy or yyyy-mm-dd.',
    'The Trial Balance must balance: total debits = total credits. Open Invoices must add up to the receivables balance, Open Bills to the payables balance, and Stock (quantity × cost) to the inventory balance.',
    'Nothing is posted until FinMatrix has checked all of this and shown you a certificate to sign. You can also run it as a practice first.',
  ]) {
    sheet.addRow([`• ${line}`]);
  }
  sheet.addRow([]);
  sheet.addRow(['اردو']).font = { bold: true };
  for (const line of [
    `ہر شیٹ کو منتقلی کی تاریخ (${opts.cutoverDate}) کے مطابق بھریں۔`,
    'قطار 1 کے عنوانات تبدیل نہ کریں۔ قطاریں 2 سے 4 ہدایات اور مثال ہیں؛ انہیں چھوڑ دیں یا مٹا دیں۔',
    'نیلے عنوان والے کالم ضروری ہیں۔ کالموں کی ترتیب اہم نہیں۔',
    'رقم 1,20,000 یا 120,000 یا Rs 1,20,000 لکھ سکتے ہیں۔ تاریخ dd/mm/yyyy یا yyyy-mm-dd۔',
    'ٹرائل بیلنس برابر ہونا چاہیے۔ اوپن انوائسز، اوپن بلز اور اسٹاک ٹرائل بیلنس کے متعلقہ کھاتوں کے برابر ہوں۔',
  ]) {
    const row = sheet.addRow([`• ${line}`]);
    row.alignment = { readingOrder: 'rtl' };
  }
  sheet.addRow([]);
  const head = sheet.addRow(['Sheet', 'What goes in it']);
  head.font = { bold: true };
  for (const t of TARGET_SHEETS) {
    sheet.addRow([
      t.name,
      `${t.purpose} Columns: ${t.fields.map((f) => f.header + (f.required ? '*' : '')).join(', ')}.`,
    ]);
  }
}
