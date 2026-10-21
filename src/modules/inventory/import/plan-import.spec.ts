import { ExistingItemSnapshot, planImport } from './plan-import';
import { RawImportRow } from './read-sheet';

let nextRow = 2;
const row = (cells: RawImportRow['cells']): RawImportRow => ({ rowNumber: nextRow++, cells });

const item = (over: Partial<ExistingItemSnapshot> = {}): ExistingItemSnapshot => ({
  id: 'item-1',
  sku: 'CHR-001',
  name: 'Dining chair',
  description: null,
  category: 'Chairs',
  unitOfMeasure: 'pcs',
  unitCost: '8500.0000',
  sellingPrice: '12500.0000',
  reorderPoint: '0.0000',
  reorderQuantity: '0.0000',
  minStock: '0.0000',
  maxStock: '0.0000',
  barcodeData: null,
  isActive: true,
  quantityOnHand: '0.0000',
  hasMovements: false,
  ...over,
});

const owner = { role: 'admin' as const };
const staff = { role: 'staff' as const };

beforeEach(() => {
  nextRow = 2;
});

describe('planImport', () => {
  describe('matching', () => {
    it('matches an existing item by SKU, ignoring case and spaces, and keeps its spelling', () => {
      const plan = planImport([row({ sku: ' chr-001 ', sellingPrice: 13000 })], [item()], owner);
      expect(plan.rows[0]).toMatchObject({ action: 'update', itemId: 'item-1', sku: 'CHR-001' });
      expect(plan.rows[0].patch).toEqual({ sellingPrice: '13000' });
      expect(plan.rows[0].patch).not.toHaveProperty('sku');
    });

    it('refuses an SKU that two existing items share up to case', () => {
      const plan = planImport(
        [row({ sku: 'chr-001', name: 'x' })],
        [item(), item({ id: 'item-2', sku: 'chr-001' })],
        owner,
      );
      expect(plan.rows[0].action).toBe('error');
      expect(plan.rows[0].errors[0]).toMatch(/More than one item/);
    });

    it('flags a repeated SKU on the later row, naming the first', () => {
      const plan = planImport([row({ sku: 'A', name: 'One' }), row({ sku: 'a', name: 'Two' })], [], owner);
      expect(plan.rows.map((r) => r.action)).toEqual(['create', 'error']);
      expect(plan.rows[1].errors).toEqual(['SKU a is already on row 2 of this file.']);
    });

    it('requires an SKU', () => {
      const plan = planImport([row({ name: 'No code' })], [], owner);
      expect(plan.rows[0].errors).toEqual(['SKU is required.']);
    });
  });

  describe('creating', () => {
    it('fills the defaults a new item needs', () => {
      const plan = planImport([row({ sku: 'LMP-1', name: 'Brass lamp', unitCost: 450 })], [], owner);
      expect(plan.rows[0].action).toBe('create');
      expect(plan.rows[0].patch).toEqual({
        sku: 'LMP-1',
        name: 'Brass lamp',
        description: null,
        category: null,
        unitOfMeasure: 'unit',
        barcodeData: null,
        isActive: true,
        unitCost: '450',
        sellingPrice: '0',
        reorderPoint: '0',
        reorderQuantity: '0',
        minStock: '0',
        maxStock: '0',
      });
    });

    it('needs a name', () => {
      const plan = planImport([row({ sku: 'LMP-1' })], [], owner);
      expect(plan.rows[0].errors).toEqual(['Name is required for a new item.']);
    });
  });

  describe('updating', () => {
    it('leaves a blank cell alone and reports unchanged rows as such', () => {
      const plan = planImport(
        [row({ sku: 'CHR-001', name: '', description: null, sellingPrice: '12500.00' })],
        [item()],
        owner,
      );
      expect(plan.rows[0]).toMatchObject({ action: 'unchanged', changes: [], patch: {} });
    });

    it('lists each change with its before and after', () => {
      const plan = planImport([row({ sku: 'CHR-001', category: 'Dining', reorderPoint: 4 })], [item()], owner);
      expect(plan.rows[0].changes).toEqual([
        { field: 'category', label: 'Category', from: 'Chairs', to: 'Dining' },
        { field: 'reorderPoint', label: 'Reorder point', from: '0', to: '4' },
      ]);
    });

    it('locks the unit cost while stock is on hand', () => {
      const plan = planImport(
        [row({ sku: 'CHR-001', unitCost: 9000 })],
        [item({ quantityOnHand: '12.0000', hasMovements: true })],
        owner,
      );
      expect(plan.rows[0].action).toBe('error');
      expect(plan.rows[0].errors[0]).toMatch(/Unit cost can't change while 12.0000 are in stock/);
    });

    it('lets the unit cost change when nothing is in stock', () => {
      const plan = planImport([row({ sku: 'CHR-001', unitCost: 9000 })], [item()], owner);
      expect(plan.rows[0].patch).toEqual({ unitCost: '9000' });
    });

    it('checks max against min using the file and the item together', () => {
      const plan = planImport([row({ sku: 'CHR-001', maxStock: 3 })], [item({ minStock: '5.0000' })], owner);
      expect(plan.rows[0].errors).toEqual(["Max stock (3) can't be below min stock (5)."]);
    });

    it('reports an unreadable cell by column name', () => {
      const plan = planImport([row({ sku: 'CHR-001', sellingPrice: 'call us' })], [item()], owner);
      expect(plan.rows[0].errors).toEqual(['Selling price "call us" is not a number.']);
    });
  });

  describe('active', () => {
    it('lets the owner deactivate an item', () => {
      const plan = planImport([row({ sku: 'CHR-001', isActive: 'No' })], [item()], owner);
      expect(plan.rows[0].patch).toEqual({ isActive: false });
    });

    it('ignores the column for staff, with a warning, as the toggle is the owner’s', () => {
      const plan = planImport([row({ sku: 'CHR-001', isActive: 'No' })], [item()], staff);
      expect(plan.rows[0]).toMatchObject({ action: 'unchanged', patch: {} });
      expect(plan.rows[0].warnings[0]).toMatch(/Only the owner can activate or deactivate/);
    });

    it('says nothing when staff merely repeat the current value', () => {
      const plan = planImport([row({ sku: 'CHR-001', isActive: 'Yes' })], [item()], staff);
      expect(plan.rows[0].warnings).toEqual([]);
    });
  });

  describe('opening quantity', () => {
    it('values the owner’s opening stock at the new item’s cost', () => {
      const plan = planImport(
        [row({ sku: 'SOF-3', name: 'Sofa', unitCost: 85000, openingQuantity: 3 })],
        [],
        owner,
      );
      expect(plan.rows[0].openingStock).toEqual({ quantity: '3', unitCost: '85000', value: '255000.0000' });
      expect(plan.summary.openingStock).toEqual({ items: 1, quantity: '3', value: '255000.0000' });
    });

    it('applies to an existing item that has never had stock, at its current cost', () => {
      const plan = planImport([row({ sku: 'CHR-001', openingQuantity: 10 })], [item()], owner);
      expect(plan.rows[0]).toMatchObject({
        action: 'update',
        openingStock: { quantity: '10', value: '85000.0000' },
      });
    });

    it('is ignored, with a warning, for an item with stock history', () => {
      for (const history of [{ quantityOnHand: '2.0000' }, { hasMovements: true }]) {
        const plan = planImport([row({ sku: 'CHR-001', openingQuantity: 10 })], [item(history)], owner);
        expect(plan.rows[0]).toMatchObject({ action: 'unchanged', openingStock: null });
        expect(plan.rows[0].warnings[0]).toMatch(/already has stock history/);
      }
    });

    it('is ignored, with a warning, for staff', () => {
      const plan = planImport([row({ sku: 'N-1', name: 'New', unitCost: 10, openingQuantity: 5 })], [], staff);
      expect(plan.rows[0]).toMatchObject({ action: 'create', openingStock: null });
      expect(plan.rows[0].warnings[0]).toMatch(/Only the owner can record opening stock/);
      expect(plan.summary.openingStock.items).toBe(0);
    });

    it('needs a unit cost, since stock with no cost has no value', () => {
      const plan = planImport([row({ sku: 'N-1', name: 'New', openingQuantity: 5 })], [], owner);
      expect(plan.rows[0].action).toBe('error');
      expect(plan.rows[0].errors[0]).toMatch(/needs a unit cost above 0/);
    });

    it('treats a zero opening quantity as blank', () => {
      const plan = planImport([row({ sku: 'N-1', name: 'New', openingQuantity: 0 })], [], staff);
      expect(plan.rows[0].warnings).toEqual([]);
    });

    it('leaves error rows out of the totals', () => {
      const plan = planImport(
        [
          row({ sku: 'A', name: 'A', unitCost: 100, openingQuantity: 2 }),
          row({ sku: 'B', unitCost: 100, openingQuantity: 2 }),
        ],
        [],
        owner,
      );
      expect(plan.summary).toMatchObject({
        totalRows: 2,
        create: 1,
        error: 1,
        openingStock: { items: 1, quantity: '2', value: '200.0000' },
      });
    });
  });
});
