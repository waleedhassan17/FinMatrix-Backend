/**
 * The columns of an inventory import file — one list shared by the template
 * the server hands out and the parser that reads it back, so the two cannot
 * drift apart.
 *
 * Headers are matched after normalising (lower-case, letters and digits only),
 * so "Unit Cost", "unit_cost" and "UNIT COST " are the same column and column
 * ORDER never matters. The aliases cover what shops already call these columns
 * in their own sheets.
 *
 * A shop's own sheet calls its stock "Quantity", "Qty", "Stock" or "On hand",
 * so those read as Opening quantity too (`looseAliases`). That cannot post
 * stock twice: opening stock is the owner's, only for items that have never
 * had stock, and shown in the preview to confirm with a date. The export's own
 * "On hand (read-only)" column normalises to "onhandreadonly", which is not an
 * alias of anything, so re-importing an export still never touches stock.
 * When a file has both, the column named for the field ("Opening quantity")
 * wins over a loose one ("Qty"), whatever their order.
 */
export type ImportField =
  | 'sku'
  | 'name'
  | 'description'
  | 'category'
  | 'unitOfMeasure'
  | 'unitCost'
  | 'sellingPrice'
  | 'reorderPoint'
  | 'reorderQuantity'
  | 'minStock'
  | 'maxStock'
  | 'barcodeData'
  | 'isActive'
  | 'openingQuantity';

export type ImportColumnKind = 'text' | 'decimal' | 'boolean';

export interface ImportColumn {
  field: ImportField;
  /** Exactly as written in the template's header row. */
  header: string;
  /** Normalised header spellings that map to this column (header included). */
  aliases: string[];
  /**
   * Looser spellings, read only when no column uses one of `aliases` — e.g.
   * "Qty" counts as Opening quantity unless "Opening quantity" is also there.
   */
  looseAliases?: string[];
  kind: ImportColumnKind;
  required?: boolean;
  maxLength?: number;
  /** Decimal places allowed — the DTO and the web form's limits. */
  decimals?: number;
  /** A count of things, so "12 pcs" reads as 12. Never set on an amount. */
  unitSuffix?: boolean;
  /** Template column width, in characters. */
  width: number;
  /** One line for the Instructions sheet. */
  note: string;
}

/**
 * Rows per file. A 1,000-row preview plans in about 150 ms and the commit only
 * writes rows that change, so this is set by what a person reviews in one go —
 * and high enough that a company's own export of its items imports back.
 */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const ON_HAND_HEADER = 'On hand (read-only)';

export const IMPORT_COLUMNS: ImportColumn[] = [
  {
    field: 'sku',
    header: 'SKU',
    aliases: ['sku', 'itemcode', 'code', 'productcode', 'skucode'],
    kind: 'text',
    required: true,
    maxLength: 64,
    width: 16,
    note: 'Required. Your code for the item. Matches an existing item (capital letters ignored); a new SKU creates a new item.',
  },
  {
    field: 'name',
    header: 'Name',
    aliases: ['name', 'itemname', 'productname', 'item'],
    kind: 'text',
    required: true,
    maxLength: 200,
    width: 32,
    note: 'Required for a new item. For an existing item, leave blank to keep the current name.',
  },
  {
    field: 'description',
    header: 'Description',
    aliases: ['description', 'details'],
    kind: 'text',
    maxLength: 5000,
    width: 36,
    note: 'Optional.',
  },
  {
    field: 'category',
    header: 'Category',
    aliases: ['category', 'group'],
    kind: 'text',
    maxLength: 100,
    width: 18,
    note: 'Optional, e.g. Sofas, Chairs, Lighting.',
  },
  {
    field: 'unitOfMeasure',
    header: 'Unit of measure',
    aliases: ['unitofmeasure', 'unit', 'uom'],
    kind: 'text',
    maxLength: 32,
    width: 16,
    note: 'Optional, e.g. pcs, set, sqft. A new item without one uses "unit".',
  },
  {
    field: 'unitCost',
    header: 'Unit cost',
    aliases: ['unitcost', 'cost', 'costprice', 'purchaseprice'],
    kind: 'decimal',
    decimals: 4,
    width: 14,
    note: 'What one unit costs you. Cannot be changed on an item that has stock on hand.',
  },
  {
    field: 'sellingPrice',
    header: 'Selling price',
    aliases: ['sellingprice', 'price', 'saleprice', 'salesprice', 'rate'],
    kind: 'decimal',
    decimals: 2,
    width: 14,
    note: 'Your price to customers.',
  },
  {
    field: 'reorderPoint',
    header: 'Reorder point',
    aliases: ['reorderpoint', 'reorderlevel'],
    kind: 'decimal',
    decimals: 4,
    unitSuffix: true,
    width: 14,
    note: 'Optional. Stock level at which the item shows as low.',
  },
  {
    field: 'reorderQuantity',
    header: 'Reorder quantity',
    aliases: ['reorderquantity', 'reorderqty'],
    kind: 'decimal',
    decimals: 4,
    unitSuffix: true,
    width: 16,
    note: 'Optional. How many you usually order.',
  },
  {
    field: 'minStock',
    header: 'Min stock',
    aliases: ['minstock', 'minimumstock'],
    kind: 'decimal',
    decimals: 4,
    unitSuffix: true,
    width: 12,
    note: 'Optional.',
  },
  {
    field: 'maxStock',
    header: 'Max stock',
    aliases: ['maxstock', 'maximumstock'],
    kind: 'decimal',
    decimals: 4,
    unitSuffix: true,
    width: 12,
    note: 'Optional. Cannot be below Min stock.',
  },
  {
    field: 'barcodeData',
    header: 'Barcode',
    aliases: ['barcode', 'barcodedata'],
    kind: 'text',
    maxLength: 128,
    width: 16,
    note: 'Optional.',
  },
  {
    field: 'isActive',
    header: 'Active',
    aliases: ['active', 'isactive', 'status'],
    kind: 'boolean',
    width: 10,
    note: 'Yes or No. Blank keeps an existing item as it is; a new item is active. Only the owner can change it.',
  },
  {
    field: 'openingQuantity',
    header: 'Opening quantity',
    aliases: ['openingquantity', 'openingqty', 'openingstock'],
    looseAliases: [
      'quantity',
      'qty',
      'stock',
      'instock',
      'onhand',
      'qtyonhand',
      'quantityonhand',
      'currentstock',
      'stockqty',
      'stockquantity',
      'closingstock',
    ],
    kind: 'decimal',
    decimals: 4,
    unitSuffix: true,
    width: 18,
    note:
      'Owner only, optional. Stock you already have, for items with no stock history yet. ' +
      'Needs a unit cost. Posted to Inventory / Opening Balance Equity on the date you choose when importing. ' +
      'Blank, 0 or "-" means no opening stock. A quantity that cannot be used (not a number, or no unit cost) ' +
      'is skipped with a note and the item is still imported, with 0 in stock. A negative quantity is refused: ' +
      'stock cannot be below 0. Also read from a column named Quantity, Qty, Stock or On hand.',
  },
];

export const COLUMN_BY_FIELD = new Map(IMPORT_COLUMNS.map((c) => [c.field, c]));

/** `" Unit Cost* "` → `"unitcost"`. Also drops a UTF-8 byte-order mark. */
export const normaliseHeader = (raw: string): string =>
  raw
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const FIELD_BY_ALIAS = new Map<string, ImportField>(
  IMPORT_COLUMNS.flatMap((c) => c.aliases.map((a) => [a, c.field] as const)),
);
const FIELD_BY_LOOSE_ALIAS = new Map<string, ImportField>(
  IMPORT_COLUMNS.flatMap((c) =>
    (c.looseAliases ?? []).map((a) => [a, c.field] as const),
  ),
);

/** The field a header names, or null for a column the import ignores. */
export const fieldForHeader = (raw: string): ImportField | null =>
  headerMatch(raw)?.field ?? null;

/**
 * The field a header names and how firmly: `exact` for one of the column's
 * own spellings, `loose` for a looser one ("Qty" for Opening quantity).
 */
export const headerMatch = (
  raw: string,
): { field: ImportField; strength: 'exact' | 'loose' } | null => {
  const key = normaliseHeader(raw);
  const exact = FIELD_BY_ALIAS.get(key);
  if (exact) return { field: exact, strength: 'exact' };
  const loose = FIELD_BY_LOOSE_ALIAS.get(key);
  return loose ? { field: loose, strength: 'loose' } : null;
};
