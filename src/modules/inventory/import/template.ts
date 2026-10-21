import * as ExcelJS from 'exceljs';
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  ON_HAND_HEADER,
} from './import-columns';

/** The item fields the workbook writes — a subset of InventoryItem. */
export interface TemplateItem {
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unitOfMeasure: string;
  unitCost: string;
  sellingPrice: string;
  reorderPoint: string;
  reorderQuantity: string;
  minStock: string;
  maxStock: string;
  barcodeData: string | null;
  isActive: boolean;
  quantityOnHand: string;
}

const HEADER_FILL = 'FFE2E8F0';
const REQUIRED_FILL = 'FFBFDBFE';
const READ_ONLY_FONT = 'FF64748B';

const NUMBER_FORMATS: Record<string, string> = {
  unitCost: '#,##0.00##',
  sellingPrice: '#,##0.00',
};

const EXAMPLE: Record<string, string | number> = {
  sku: 'CHR-001',
  name: 'Dining chair — walnut',
  description: 'Solid walnut frame, cushioned seat',
  category: 'Chairs',
  unitOfMeasure: 'pcs',
  unitCost: 8500,
  sellingPrice: 12500,
  reorderPoint: 4,
  reorderQuantity: 10,
  minStock: 2,
  maxStock: 30,
  barcodeData: '',
  isActive: 'Yes',
  openingQuantity: 12,
};

/**
 * The import template — or, given items, an export of them in the same
 * columns, so "download my items → change prices in Excel → import" is a
 * round trip.
 *
 * The Items sheet starts EMPTY in the template. An example row there would be
 * imported as a real item (with opening stock!) by anyone who fills in their
 * rows below it, so the example lives on the Instructions sheet instead.
 *
 * An export leaves Opening quantity blank and shows current stock in a greyed
 * "On hand (read-only)" column that the importer ignores by name.
 */
export async function buildItemsWorkbook(
  items?: TemplateItem[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FinMatrix';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Items', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    ...IMPORT_COLUMNS.map((c) => ({
      header: c.header,
      key: c.field,
      width: c.width,
    })),
    ...(items ? [{ header: ON_HAND_HEADER, key: 'onHand', width: 20 }] : []),
  ];

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  IMPORT_COLUMNS.forEach((c, i) => {
    header.getCell(i + 1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: c.required ? REQUIRED_FILL : HEADER_FILL },
    };
    header.getCell(i + 1).note = c.note;
  });

  // Text, so Excel keeps "00123" and long barcodes exactly as typed.
  sheet.getColumn('sku').numFmt = '@';
  sheet.getColumn('barcodeData').numFmt = '@';
  for (const [key, fmt] of Object.entries(NUMBER_FORMATS))
    sheet.getColumn(key).numFmt = fmt;

  for (const item of [...(items ?? [])].sort((a, b) =>
    a.sku.localeCompare(b.sku),
  )) {
    sheet.addRow({
      sku: item.sku,
      name: item.name,
      description: item.description ?? '',
      category: item.category ?? '',
      unitOfMeasure: item.unitOfMeasure,
      unitCost: Number(item.unitCost),
      sellingPrice: Number(item.sellingPrice),
      reorderPoint: Number(item.reorderPoint),
      reorderQuantity: Number(item.reorderQuantity),
      minStock: Number(item.minStock),
      maxStock: Number(item.maxStock),
      barcodeData: item.barcodeData ?? '',
      isActive: item.isActive ? 'Yes' : 'No',
      onHand: Number(item.quantityOnHand),
    });
  }

  if (items) {
    const onHand = sheet.getColumn('onHand');
    onHand.font = { color: { argb: READ_ONLY_FONT }, italic: true };
    header.getCell(onHand.number).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: HEADER_FILL },
    };
    header.getCell(onHand.number).note =
      'For reference only. The import ignores this column — it never changes stock.';
  }

  // A Yes/No dropdown on Active, down to the most rows a file may hold.
  const activeCol = sheet.getColumn('isActive').number;
  for (let r = 2; r <= MAX_IMPORT_ROWS + 1; r++) {
    sheet.getCell(r, activeCol).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"Yes,No"'],
      showErrorMessage: true,
      errorTitle: 'Active',
      error: 'Choose Yes or No.',
    };
  }

  addInstructions(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function addInstructions(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet('Instructions');
  sheet.columns = [
    { key: 'a', width: 22 },
    { key: 'b', width: 12 },
    { key: 'c', width: 100 },
  ];

  const title = sheet.addRow(['Importing items into FinMatrix']);
  title.font = { bold: true, size: 14 };
  sheet.addRow([]);
  for (const line of [
    'Fill in the Items sheet, one item per row, then upload the file from Inventory → Import.',
    'Each row is matched to an item by its SKU. A new SKU creates an item; an existing SKU updates it.',
    'A blank cell leaves an existing item’s value as it is. Only filled-in cells change anything.',
    'You will see a preview of every change before anything is saved, and rows with problems are listed so you can fix them.',
    `Up to ${MAX_IMPORT_ROWS.toLocaleString('en-US')} items per file. Column order does not matter, and extra columns are ignored.`,
    'Item photos are added on each item’s page, not through this file.',
  ]) {
    sheet.addRow([`• ${line}`]);
  }

  sheet.addRow([]);
  const head = sheet.addRow(['Column', 'Required', 'What to enter']);
  head.font = { bold: true };
  for (const c of IMPORT_COLUMNS) {
    const row = sheet.addRow([c.header, c.required ? 'Yes' : '', c.note]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  }

  sheet.addRow([]);
  sheet.addRow(['Example row']).font = { bold: true };
  sheet.addRow(IMPORT_COLUMNS.map((c) => c.header)).font = { bold: true };
  sheet.addRow(IMPORT_COLUMNS.map((c) => EXAMPLE[c.field] ?? ''));
}
