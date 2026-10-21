import * as ExcelJS from 'exceljs';
import { TemplateItem, buildItemsWorkbook } from './template';
import { readImportFile } from './read-sheet';
import { ExistingItemSnapshot, planImport } from './plan-import';
import { IMPORT_COLUMNS, ON_HAND_HEADER } from './import-columns';

const items: TemplateItem[] = [
  {
    sku: '00123',
    name: 'Brass lamp',
    description: 'Hand finished',
    category: 'Lighting',
    unitOfMeasure: 'pcs',
    unitCost: '450.2500',
    sellingPrice: '799.0000',
    reorderPoint: '2.0000',
    reorderQuantity: '10.0000',
    minStock: '1.0000',
    maxStock: '20.0000',
    barcodeData: '8964000123456',
    isActive: true,
    quantityOnHand: '7.0000',
  },
  {
    sku: 'SOF-3',
    name: 'Three-seater sofa',
    description: null,
    category: null,
    unitOfMeasure: 'unit',
    unitCost: '85000.0000',
    sellingPrice: '125000.0000',
    reorderPoint: '0.0000',
    reorderQuantity: '0.0000',
    minStock: '0.0000',
    maxStock: '0.0000',
    barcodeData: null,
    isActive: false,
    quantityOnHand: '0.0000',
  },
];

describe('buildItemsWorkbook', () => {
  it('hands out an empty Items sheet with every column, and instructions', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildItemsWorkbook()) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Items', 'Instructions']);
    const sheet = wb.getWorksheet('Items')!;
    expect(sheet.getRow(1).values).toEqual([undefined, ...IMPORT_COLUMNS.map((c) => c.header)]);
    // No example row: one there would be imported as a real item.
    expect(sheet.actualRowCount).toBe(1);
  });

  it('round-trips: an export imported straight back changes nothing', async () => {
    const sheet = await readImportFile(await buildItemsWorkbook(items));
    expect(sheet.ignored).toEqual([ON_HAND_HEADER]);

    const existing: ExistingItemSnapshot[] = items.map((i, n) => ({
      ...i,
      id: `item-${n}`,
      hasMovements: i.quantityOnHand !== '0.0000',
    }));
    const plan = planImport(sheet.rows, existing, { role: 'admin' });
    expect(plan.rows.map((r) => [r.sku, r.action, r.errors, r.warnings])).toEqual([
      ['00123', 'unchanged', [], []],
      ['SOF-3', 'unchanged', [], []],
    ]);
  });

  it('never exports the on-hand quantity as an opening quantity', async () => {
    const sheet = await readImportFile(await buildItemsWorkbook(items));
    expect(sheet.rows.every((r) => r.cells.openingQuantity == null || r.cells.openingQuantity === '')).toBe(true);
  });
});
