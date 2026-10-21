import Decimal from 'decimal.js';
import { COLUMN_BY_FIELD, IMPORT_COLUMNS, ImportField } from './import-columns';
import {
  CellError,
  cellToBoolean,
  cellToDecimal,
  cellToText,
} from './cell-value';
import { RawImportRow } from './read-sheet';

/** What the import knows about an item that already exists. */
export interface ExistingItemSnapshot {
  id: string;
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
  hasMovements: boolean;
}

export type ImportRole = 'admin' | 'staff';
export type ImportAction = 'create' | 'update' | 'unchanged' | 'error';

/** The item columns an import may write. */
export type ItemField = Exclude<ImportField, 'openingQuantity'>;
export type ItemPatch = Partial<Record<ItemField, string | boolean | null>>;

export interface FieldChange {
  field: ItemField;
  label: string;
  from: string | null;
  to: string | null;
}

export interface OpeningStockLine {
  quantity: string;
  unitCost: string;
  value: string;
}

export interface PlannedRow {
  rowNumber: number;
  sku: string;
  name: string;
  action: ImportAction;
  itemId: string | null;
  changes: FieldChange[];
  openingStock: OpeningStockLine | null;
  errors: string[];
  warnings: string[];
  /** The columns to write. Never sent to the client. */
  patch: ItemPatch;
}

export interface ImportSummary {
  totalRows: number;
  create: number;
  update: number;
  unchanged: number;
  error: number;
  withWarnings: number;
  openingStock: { items: number; quantity: string; value: string };
}

export interface ImportPlan {
  rows: PlannedRow[];
  summary: ImportSummary;
}

const DECIMAL_FIELDS = [
  'unitCost',
  'sellingPrice',
  'reorderPoint',
  'reorderQuantity',
  'minStock',
  'maxStock',
] as const satisfies readonly ItemField[];
const TEXT_FIELDS = [
  'name',
  'description',
  'category',
  'unitOfMeasure',
  'barcodeData',
] as const satisfies readonly ItemField[];

const label = (field: ImportField) => COLUMN_BY_FIELD.get(field)!.header;
const key = (sku: string) => sku.trim().toLowerCase();
const dec = (v: string | null | undefined) => new Decimal(v ?? '0');

/** A row's cells as typed values, plus a sentence for every cell that can't be read. */
function parseCells(row: RawImportRow) {
  const values: Partial<Record<ImportField, string | boolean | null>> = {};
  const errors: string[] = [];
  for (const column of IMPORT_COLUMNS) {
    if (!(column.field in row.cells)) continue;
    const raw = row.cells[column.field];
    try {
      let value: string | boolean | null;
      if (column.kind === 'decimal')
        value = cellToDecimal(raw, column.decimals ?? 4);
      else if (column.kind === 'boolean') value = cellToBoolean(raw);
      else value = cellToText(raw);

      if (
        typeof value === 'string' &&
        column.maxLength &&
        value.length > column.maxLength
      ) {
        throw new CellError(`is longer than ${column.maxLength} characters.`);
      }
      values[column.field] = value;
    } catch (err) {
      if (!(err instanceof CellError)) throw err;
      errors.push(`${column.header} ${err.message}`);
    }
  }
  return { values, errors };
}

const display = (v: string | boolean | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
};

/**
 * Decide, row by row, what an import file would do — without touching the
 * database. Preview shows this plan; commit recomputes it against locked rows
 * and applies it, so the two can never disagree about a rule.
 *
 * The rules, in the order a user meets them:
 *
 *   • A row is matched to an item by SKU, ignoring case and surrounding space.
 *     The import never renames an SKU, so the stored spelling is kept.
 *   • A blank cell leaves an existing value alone. An import cannot be used to
 *     wipe a description by accident — clearing a field is an edit on the item.
 *   • Unit cost is locked while stock is on hand (UNIT_COST_LOCKED, the same
 *     rule as the item form): it is the weighted average of what was paid, and
 *     changing it would move the stock's value with no journal entry.
 *   • Opening quantity is the owner's, and only for an item that has never had
 *     stock — the same one-time rule as the Opening Stock button. Anything else
 *     is ignored with a warning, never silently posted.
 *   • Activating or deactivating is the owner's too, as it is on the item page.
 */
export function planImport(
  rows: RawImportRow[],
  existing: ExistingItemSnapshot[],
  ctx: { role: ImportRole },
): ImportPlan {
  const bySku = new Map<string, ExistingItemSnapshot[]>();
  for (const item of existing) {
    const k = key(item.sku);
    bySku.set(k, [...(bySku.get(k) ?? []), item]);
  }
  const firstRowForSku = new Map<string, number>();

  const planned = rows.map((row): PlannedRow => {
    const { values, errors } = parseCells(row);
    const warnings: string[] = [];
    const sku = typeof values.sku === 'string' ? values.sku : '';
    const result: PlannedRow = {
      rowNumber: row.rowNumber,
      sku,
      name: typeof values.name === 'string' ? values.name : '',
      action: 'error',
      itemId: null,
      changes: [],
      openingStock: null,
      errors,
      warnings,
      patch: {},
    };

    if (!sku) {
      if (!errors.some((e) => e.startsWith(label('sku'))))
        errors.push('SKU is required.');
      return result;
    }
    const first = firstRowForSku.get(key(sku));
    if (first !== undefined) {
      errors.push(`SKU ${sku} is already on row ${first} of this file.`);
      return result;
    }
    firstRowForSku.set(key(sku), row.rowNumber);

    const matches = bySku.get(key(sku)) ?? [];
    if (matches.length > 1) {
      errors.push(
        `More than one item matches this SKU (${matches.map((m) => m.sku).join(', ')}). Give them distinct SKUs first.`,
      );
      return result;
    }
    const item = matches[0] ?? null;

    // Staff may not flip an item on or off — that is the owner's toggle.
    if (
      values.isActive !== undefined &&
      values.isActive !== null &&
      ctx.role !== 'admin'
    ) {
      const wouldChange = item
        ? values.isActive !== item.isActive
        : values.isActive === false;
      if (wouldChange) {
        warnings.push(
          'Only the owner can activate or deactivate an item, so Active was left as it is.',
        );
      }
      delete values.isActive;
    }

    if (item) planUpdate(result, item, values);
    else planCreate(result, values);

    planOpeningStock(result, item, values, ctx.role);

    if (errors.length > 0) {
      result.action = 'error';
      result.changes = [];
      result.openingStock = null;
      result.patch = {};
    } else if (!item) {
      result.action = 'create';
    } else {
      result.action =
        result.changes.length > 0 || result.openingStock
          ? 'update'
          : 'unchanged';
    }
    return result;
  });

  return { rows: planned, summary: summarise(planned) };
}

function planCreate(
  result: PlannedRow,
  values: Partial<Record<ImportField, string | boolean | null>>,
) {
  if (!values.name) {
    result.errors.push('Name is required for a new item.');
    return;
  }
  const patch: ItemPatch = {
    sku: result.sku,
    name: values.name as string,
    description: (values.description as string | null) ?? null,
    category: (values.category as string | null) ?? null,
    unitOfMeasure: (values.unitOfMeasure as string | null) ?? 'unit',
    barcodeData: (values.barcodeData as string | null) ?? null,
    isActive: (values.isActive as boolean | null | undefined) ?? true,
  };
  for (const field of DECIMAL_FIELDS)
    patch[field] = (values[field] as string | null) ?? '0';

  checkMinMax(
    result,
    dec(patch.minStock as string),
    dec(patch.maxStock as string),
  );
  result.patch = patch;
  for (const field of [
    ...TEXT_FIELDS,
    ...DECIMAL_FIELDS,
    'isActive',
  ] as ItemField[]) {
    const to = display(patch[field]);
    const isDecimal = (DECIMAL_FIELDS as readonly ItemField[]).includes(field);
    if (to !== null && !(isDecimal && dec(to).isZero())) {
      result.changes.push({ field, label: label(field), from: null, to });
    }
  }
}

function planUpdate(
  result: PlannedRow,
  item: ExistingItemSnapshot,
  values: Partial<Record<ImportField, string | boolean | null>>,
) {
  result.itemId = item.id;
  result.sku = item.sku;
  if (!result.name) result.name = item.name;

  for (const field of TEXT_FIELDS) {
    const next = values[field] as string | null | undefined;
    if (next === null || next === undefined) continue;
    if (next !== (item[field] ?? null)) {
      result.patch[field] = next;
      result.changes.push({
        field,
        label: label(field),
        from: item[field] ?? null,
        to: next,
      });
    }
  }

  for (const field of DECIMAL_FIELDS) {
    const next = values[field] as string | null | undefined;
    if (next === null || next === undefined) continue;
    const current = item[field];
    if (dec(next).equals(dec(current))) continue;

    if (field === 'unitCost' && dec(item.quantityOnHand).greaterThan(0)) {
      result.errors.push(
        `Unit cost can't change while ${item.quantityOnHand} are in stock — it is the average of what you paid. ` +
          'Leave the cell blank, or correct the quantity with a Stock Adjustment.',
      );
      continue;
    }
    result.patch[field] = next;
    result.changes.push({
      field,
      label: label(field),
      from: dec(current).toFixed(),
      to: next,
    });
  }

  const nextActive = values.isActive as boolean | null | undefined;
  if (
    nextActive !== null &&
    nextActive !== undefined &&
    nextActive !== item.isActive
  ) {
    result.patch.isActive = nextActive;
    result.changes.push({
      field: 'isActive',
      label: label('isActive'),
      from: display(item.isActive),
      to: display(nextActive),
    });
  }

  checkMinMax(
    result,
    dec((result.patch.minStock as string | undefined) ?? item.minStock),
    dec((result.patch.maxStock as string | undefined) ?? item.maxStock),
  );
}

function checkMinMax(result: PlannedRow, min: Decimal, max: Decimal) {
  if (max.greaterThan(0) && max.lessThan(min)) {
    result.errors.push(
      `Max stock (${max.toFixed()}) can't be below min stock (${min.toFixed()}).`,
    );
  }
}

function planOpeningStock(
  result: PlannedRow,
  item: ExistingItemSnapshot | null,
  values: Partial<Record<ImportField, string | boolean | null>>,
  role: ImportRole,
) {
  const raw = values.openingQuantity as string | null | undefined;
  if (!raw || dec(raw).isZero()) return;

  if (role !== 'admin') {
    result.warnings.push(
      'Only the owner can record opening stock, so the opening quantity was ignored.',
    );
    return;
  }
  if (item && (!dec(item.quantityOnHand).isZero() || item.hasMovements)) {
    result.warnings.push(
      'This item already has stock history, so the opening quantity was ignored. Use a Stock Adjustment to correct its quantity.',
    );
    return;
  }

  const cost = dec(
    (result.patch.unitCost as string | undefined) ?? item?.unitCost,
  );
  if (cost.lessThanOrEqualTo(0)) {
    result.errors.push(
      'An opening quantity needs a unit cost above 0 — stock with no cost has no value to record.',
    );
    return;
  }
  const value = dec(raw).times(cost);
  if (new Decimal(value.toFixed(4)).isZero()) {
    result.errors.push(
      'Opening quantity × unit cost rounds to zero, so there is nothing to record.',
    );
    return;
  }
  result.openingStock = {
    quantity: dec(raw).toFixed(),
    unitCost: cost.toFixed(),
    value: value.toFixed(4),
  };
}

function summarise(rows: PlannedRow[]): ImportSummary {
  let quantity = new Decimal(0);
  let value = new Decimal(0);
  let items = 0;
  const count = (a: ImportAction) => rows.filter((r) => r.action === a).length;
  for (const r of rows) {
    if (r.action === 'error' || !r.openingStock) continue;
    items++;
    quantity = quantity.plus(r.openingStock.quantity);
    value = value.plus(r.openingStock.value);
  }
  return {
    totalRows: rows.length,
    create: count('create'),
    update: count('update'),
    unchanged: count('unchanged'),
    error: count('error'),
    withWarnings: rows.filter((r) => r.warnings.length > 0).length,
    openingStock: {
      items,
      quantity: quantity.toFixed(),
      value: value.toFixed(4),
    },
  };
}
