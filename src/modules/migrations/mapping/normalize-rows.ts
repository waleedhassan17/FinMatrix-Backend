import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { cellToText } from '../../inventory/import/cell-value';
import { parseAmount, parseQuantity } from '../parsers/amount.parser';
import { DateOrder, detectDateOrder, parseDate } from '../parsers/date.parser';
import { numberAsTyped } from '../parsers/readback';
import { cleanText } from '../parsers/text-normalize';
import { TargetSheet, TEMPLATE_ROW_MARKERS } from '../targets';
import { ColumnProposal } from './column-mapper';

export interface RowError {
  field: string | null;
  code: string;
  message: string;
}

export interface NormalizedRow {
  rowNumber: number;
  /** A "Total" line under the data (exports love them); never imported. */
  totalRow?: boolean;
  rowHash: string;
  /** The row as read, keyed by source header. JSON-safe. */
  raw: Record<string, unknown>;
  /** The row as understood, keyed by target field. Amounts are strings, dates ISO. */
  normalized: Record<string, unknown>;
  errors: RowError[];
}

export interface NormalizeOptions {
  /** How a/b/yyyy dates read, per field key, once decided. */
  dateOrder?: Record<string, DateOrder>;
  /** Canonical value for an enum field's source value, or null when unknown. */
  mapValue: (field: string, raw: unknown) => string | null;
}

export interface NormalizeResult {
  rows: NormalizedRow[];
  /** Date fields whose values could be read either way and have no order yet. */
  ambiguousDateFields: string[];
  /** Source rows skipped as instructions or examples from the starter workbook. */
  skippedTemplateRows: number;
}

const TOTAL_WORDS = new Set([
  'total',
  'totals',
  'grand total',
  'sub total',
  'subtotal',
  'net total',
  'کل',
  'ٹوٹل',
  'میزان',
]);

/**
 * The cell as the owner typed it, kept beside every parsed amount, quantity
 * and date as `<field>Text`. The second reader (parsers/readback.ts) reads
 * this text again and must agree with the parsed value; the certificate
 * shows it beside the figure FinMatrix holds. A number cell has no typed
 * text, so it is represented at the precision a spreadsheet displays.
 */
export function asTypedText(value: unknown): string | null {
  const v = rawCell(value);
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return numberAsTyped(v);
  return String(v);
}

/** JSON-safe copy of a raw cell: dates as ISO text, rich text flattened. */
export function rawCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    try {
      return cellToText(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

export function isTemplateRow(firstCell: unknown): boolean {
  const text = cleanText(rawCell(firstCell)) ?? '';
  return TEMPLATE_ROW_MARKERS.some((m) =>
    text.toUpperCase().startsWith(m.toUpperCase()),
  );
}

/**
 * Source rows → normalised records, one error per bad cell, nothing guessed.
 *
 * Every mapped cell goes through the parser for its field kind. An amount
 * that is not an amount, a date that is not a date and an unknown enum value
 * each become a row error with the field and the sentence the parser wrote;
 * a required field left blank is an error too. The row is kept with its
 * errors so the owner can fix it in place — it is only `rejected` if the
 * errors stand when the batch is validated.
 *
 * Date order is decided per field from the whole column (detectDateOrder);
 * when the column is ambiguous the field is reported and the rows wait for
 * the owner's answer instead of being parsed one way.
 */
export function normalizeRows(
  target: TargetSheet,
  rows: Array<{ rowNumber: number; cells: unknown[] }>,
  headerRowIndex: number,
  columns: ColumnProposal[],
  opts: NormalizeOptions,
): NormalizeResult {
  const mapped = columns.filter((c) => c.field);
  const fieldByKey = new Map(target.fields.map((f) => [f.key, f]));
  const dataRows = rows.slice(headerRowIndex + 1);

  // Decide the order of each date column up front.
  const dateOrder: Record<string, DateOrder> = { ...(opts.dateOrder ?? {}) };
  const ambiguousDateFields: string[] = [];
  for (const c of mapped) {
    const field = fieldByKey.get(c.field!);
    if (!field || field.kind !== 'date' || dateOrder[field.key]) continue;
    const verdict = detectDateOrder(
      dataRows.map((r) => rawCell(r.cells[c.column])),
    );
    if (verdict === 'dmy' || verdict === 'mdy') dateOrder[field.key] = verdict;
    else if (verdict === 'ambiguous') ambiguousDateFields.push(field.key);
  }

  const out: NormalizedRow[] = [];
  let skippedTemplateRows = 0;
  for (const row of dataRows) {
    if (row.cells.every((v) => rawCell(v) === null || rawCell(v) === ''))
      continue;
    if (isTemplateRow(row.cells[0])) {
      skippedTemplateRows += 1;
      continue;
    }
    const raw: Record<string, unknown> = {};
    columns.forEach((c) => {
      if (c.header.trim()) raw[c.header] = rawCell(row.cells[c.column]);
    });
    const normalized: Record<string, unknown> = {};
    const errors: RowError[] = [];

    for (const c of mapped) {
      const field = fieldByKey.get(c.field!)!;
      const value = row.cells[c.column];
      const blank = rawCell(value) === null || rawCell(value) === '';
      switch (field.kind) {
        case 'text':
        case 'code': {
          const text = blank ? null : cleanText(rawCell(value));
          normalized[field.key] = text;
          break;
        }
        case 'amount':
        case 'quantity': {
          normalized[`${field.key}Text`] = asTypedText(value);
          const r =
            field.kind === 'amount' ? parseAmount(value) : parseQuantity(value);
          if (!r.ok) {
            errors.push({
              field: field.key,
              code: 'INVALID_AMOUNT',
              message: `${field.header} ${r.error}`,
            });
            normalized[field.key] = null;
          } else if (
            r.amount &&
            new Decimal(r.amount.value).decimalPlaces() > 4
          ) {
            // The books hold four decimal places. Rounding here would make
            // the posted figure differ from the file by less than a paisa —
            // and every check is exact — so the owner fixes the cell instead.
            errors.push({
              field: field.key,
              code: 'INVALID_AMOUNT',
              message: `${field.header} has more than 4 decimal places (${r.amount.value}).`,
            });
            normalized[field.key] = null;
          } else {
            normalized[field.key] = r.amount?.value ?? null;
            if (r.amount?.side) normalized[`${field.key}Side`] = r.amount.side;
          }
          break;
        }
        case 'date': {
          normalized[`${field.key}Text`] = asTypedText(value);
          normalized[`${field.key}Order`] = dateOrder[field.key] ?? null;
          if (blank) {
            normalized[field.key] = null;
            break;
          }
          if (ambiguousDateFields.includes(field.key)) {
            normalized[field.key] = null;
            errors.push({
              field: field.key,
              code: 'AMBIGUOUS_DATE_FORMAT',
              message: `${field.header}: the file's dates could be day/month or month/day. Choose one for this file.`,
            });
            break;
          }
          const r = parseDate(value, dateOrder[field.key]);
          if (!r.ok) {
            normalized[field.key] = null;
            errors.push({
              field: field.key,
              code: 'ambiguous' in r ? 'AMBIGUOUS_DATE_FORMAT' : 'INVALID_DATE',
              message:
                'ambiguous' in r
                  ? `${field.header}: ${rawCell(value)} could be ${r.dmy} or ${r.mdy}.`
                  : `${field.header} ${r.error}`,
            });
          } else {
            normalized[field.key] = r.iso;
          }
          break;
        }
        case 'enum': {
          if (blank) {
            normalized[field.key] = null;
            break;
          }
          const canonical = opts.mapValue(field.key, rawCell(value));
          normalized[field.key] = canonical;
          if (!canonical) {
            errors.push({
              field: field.key,
              code: 'INVALID_VALUE',
              message: `${field.header}: "${rawCell(value)}" is not a value we know.`,
            });
          }
          break;
        }
      }
    }

    for (const field of target.fields) {
      if (!field.required) continue;
      const v = normalized[field.key];
      const hasColumn = mapped.some((c) => c.field === field.key);
      if (
        hasColumn &&
        (v === null || v === undefined || v === '') &&
        !errors.some((e) => e.field === field.key)
      ) {
        errors.push({
          field: field.key,
          code: 'MISSING_REQUIRED_VALUE',
          message: `${field.header} is required.`,
        });
      }
    }

    // Trial balance: a negative debit is a credit (and the other way round),
    // and a Dr/Cr suffix decides the side whichever column it was typed in.
    if (target.key === 'trial_balance') {
      let debit = normalized.debit
        ? new Decimal(String(normalized.debit))
        : null;
      let credit = normalized.credit
        ? new Decimal(String(normalized.credit))
        : null;
      if (normalized.debitSide === 'credit' && debit) {
        credit = (credit ?? new Decimal(0)).plus(debit);
        debit = null;
      }
      if (normalized.creditSide === 'debit' && credit) {
        debit = (debit ?? new Decimal(0)).plus(credit);
        credit = null;
      }
      if (debit && debit.lessThan(0)) {
        credit = (credit ?? new Decimal(0)).plus(debit.abs());
        debit = null;
      }
      if (credit && credit.lessThan(0)) {
        debit = (debit ?? new Decimal(0)).plus(credit.abs());
        credit = null;
      }
      normalized.debit = debit && !debit.isZero() ? debit.toFixed() : null;
      normalized.credit = credit && !credit.isZero() ? credit.toFixed() : null;
      delete normalized.debitSide;
      delete normalized.creditSide;
      if (!normalized.debit && !normalized.credit && !errors.length) {
        normalized.debit = '0';
      }
    }

    const codeField = target.fields.find(
      (f) => f.required && f.kind === 'code',
    );
    const codeBlank = codeField ? !normalized[codeField.key] : false;
    const totalRow =
      codeBlank &&
      Object.values(raw).some((v) =>
        TOTAL_WORDS.has(
          String(v ?? '')
            .trim()
            .toLowerCase()
            .replace(/[:\s]+/g, ' ')
            .trim(),
        ),
      );

    out.push({
      rowNumber: row.rowNumber,
      ...(totalRow ? { totalRow: true } : {}),
      rowHash: createHash('sha256')
        .update(JSON.stringify(Object.values(raw)))
        .digest('hex'),
      raw,
      normalized,
      errors,
    });
  }
  return { rows: out, ambiguousDateFields, skippedTemplateRows };
}
