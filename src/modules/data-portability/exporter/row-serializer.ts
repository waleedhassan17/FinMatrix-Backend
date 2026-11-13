import { ExportColumn } from './export-entities';

/**
 * One cell of a backup file, as text.
 *
 * Money columns arrive from Postgres as strings at their stored four decimals
 * and are written exactly as stored — a backup is the books, not a report, so
 * nothing is rounded. Dates and timestamps are ISO-8601; JSON columns are
 * written as JSON; null is an empty cell. There is no float anywhere in this
 * path: a numeric cell is text from the driver to the file.
 */
export function serializeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return neutraliseFormula(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return JSON.stringify(value);
}

/**
 * A cell that begins with =, +, -, @ or a control character is a formula to
 * Excel and LibreOffice, which would run it when the owner opens the backup.
 * Text that starts that way gets a leading apostrophe, which spreadsheets
 * treat as "this is text" and hide. A figure is left alone: money columns
 * arrive as strings ("-1000.0000") and must stay numbers.
 */
export function neutraliseFormula(text: string): string {
  if (!/^[=+\-@\t\r]/.test(text)) return text;
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text}`;
}

export function serializeRow(
  row: Record<string, unknown>,
  columns: ExportColumn[],
): string[] {
  return columns.map((c) => serializeCell(row[c.property]));
}

/** Excel refuses a cell over 32,767 characters; a CSV has no such limit. */
export const XLSX_CELL_LIMIT = 32_767;

export function clampForXlsx(cell: string): string {
  return cell.length > XLSX_CELL_LIMIT ? cell.slice(0, XLSX_CELL_LIMIT) : cell;
}
