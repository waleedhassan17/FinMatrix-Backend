import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { ImportField, MAX_IMPORT_ROWS, fieldForHeader } from './import-columns';
import { cellToText, isBlankCell } from './cell-value';

/** One data row, keyed by the import column each cell belongs to. */
export interface RawImportRow {
  /** The row number the user sees in Excel (1-based, header included). */
  rowNumber: number;
  cells: Partial<Record<ImportField, unknown>>;
}

export interface ImportSheet {
  sheetName: string;
  recognized: string[];
  ignored: string[];
  rows: RawImportRow[];
}

/** Rows searched for the header, so a title line or two above it is fine. */
const HEADER_SEARCH_ROWS = 10;
/**
 * Ceiling on the unzipped size of an .xlsx. A 5 MB upload is a few hundred
 * thousand cells of XML at most; anything that inflates past this is not an
 * item list, and exceljs would hold all of it in the dyno's memory.
 */
const MAX_UNZIPPED_BYTES = 60 * 1024 * 1024;

const fail = (code: string, message: string) =>
  new BadRequestException({ code, message });

/**
 * Read an uploaded .xlsx or .csv into rows keyed by import column.
 *
 * The file's first bytes decide what it is, not its name or declared type —
 * phones report spreadsheets as application/octet-stream more often than not.
 */
export async function readImportFile(buffer: Buffer): Promise<ImportSheet> {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x504b0304) {
    return readXlsx(buffer);
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    throw new UnsupportedMediaTypeException({
      code: 'IMPORT_UNSUPPORTED_FILE',
      message:
        'This is an old Excel 97–2003 (.xls) file. Open it in Excel, choose Save As → Excel Workbook (.xlsx), and upload that.',
    });
  }
  if (buffer.includes(0)) {
    throw new UnsupportedMediaTypeException({
      code: 'IMPORT_UNSUPPORTED_FILE',
      message: 'Upload an Excel (.xlsx) or CSV file.',
    });
  }
  return fromGrid('CSV', parseCsv(buffer.toString('utf8')));
}

// ── .xlsx ───────────────────────────────────────────────

async function readXlsx(buffer: Buffer): Promise<ImportSheet> {
  assertZipWithinLimits(buffer);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw fail(
      'IMPORT_UNREADABLE',
      'This file could not be opened as an Excel workbook. Save it again from Excel as .xlsx and retry.',
    );
  }

  const sheets = workbook.worksheets.filter(
    (ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden',
  );
  const sheet =
    sheets.find((ws) => ws.name.trim().toLowerCase() === 'items') ??
    sheets.find((ws) => findHeaderRow(gridOf(ws, HEADER_SEARCH_ROWS)) !== -1) ??
    sheets[0];
  if (!sheet) throw fail('IMPORT_EMPTY', 'This workbook has no sheets.');

  // Room for the header, a title line or two and blank spacer rows.
  if (sheet.actualRowCount > MAX_IMPORT_ROWS + HEADER_SEARCH_ROWS) {
    throw tooManyRows();
  }
  return fromGrid(sheet.name, gridOf(sheet));
}

type Grid = Array<{ rowNumber: number; values: unknown[] }>;

function gridOf(sheet: ExcelJS.Worksheet, maxRows = Infinity): Grid {
  const grid: Grid = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > maxRows) return;
    const values: unknown[] = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      values[col - 1] = cell.value;
    });
    grid.push({ rowNumber, values });
  });
  return grid;
}

/**
 * Sum the uncompressed sizes in the zip's central directory, without
 * inflating anything — the guard against a zip bomb dressed as a workbook.
 */
function assertZipWithinLimits(buffer: Buffer): void {
  // End-of-central-directory: signature 0x06054b50, in the last 64 KB + 22.
  const searchFrom = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw fail(
      'IMPORT_UNREADABLE',
      'This file is damaged and could not be opened as an Excel workbook.',
    );
  }

  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw fail(
        'IMPORT_UNREADABLE',
        'This file is damaged and could not be opened as an Excel workbook.',
      );
    }
    const uncompressed = buffer.readUInt32LE(offset + 24);
    // 0xFFFFFFFF means a ZIP64 size; no item list comes anywhere near 4 GB.
    if (uncompressed === 0xffffffff) total = Infinity;
    else total += uncompressed;
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
  if (total > MAX_UNZIPPED_BYTES) {
    throw fail(
      'IMPORT_FILE_TOO_LARGE',
      'This workbook is too large to import. Keep only the item list (no pictures or other sheets) and try again.',
    );
  }
}

// ── .csv ────────────────────────────────────────────────

/**
 * RFC 4180 CSV, every value kept as text — a CSV "00123" stays "00123" rather
 * than becoming the number 123. The delimiter is sniffed from the first line:
 * Excel writes `;` instead of `,` in locales that use a decimal comma.
 */
export function parseCsv(text: string): Grid {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );

  const grid: Grid = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let rowNumber = 1;

  const endRow = () => {
    row.push(field);
    if (row.some((v) => v.trim() !== '')) grid.push({ rowNumber, values: row });
    row = [];
    field = '';
    rowNumber++;
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      endRow();
      if (grid.length > MAX_IMPORT_ROWS + HEADER_SEARCH_ROWS)
        throw tooManyRows();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return grid;
}

// ── shared ──────────────────────────────────────────────

/** A header cell's text — header cells may be rich text when partly bolded. */
function headerLabel(value: unknown): string {
  try {
    return cellToText(value) ?? '';
  } catch {
    return '';
  }
}

function findHeaderRow(grid: Grid): number {
  return grid.findIndex(
    (r, i) =>
      i < HEADER_SEARCH_ROWS &&
      r.values.some((v) => fieldForHeader(headerLabel(v)) === 'sku'),
  );
}

function fromGrid(sheetName: string, grid: Grid): ImportSheet {
  const headerIndex = findHeaderRow(grid);
  if (headerIndex === -1) {
    throw fail(
      'IMPORT_NO_HEADER',
      'No "SKU" column was found. The first row of the sheet should hold the column names — download the template to see them.',
    );
  }

  const header = grid[headerIndex].values;
  const fieldAt = new Map<number, ImportField>();
  const recognized: string[] = [];
  const ignored: string[] = [];
  header.forEach((raw, col) => {
    const label = headerLabel(raw);
    if (!label) return;
    const field = fieldForHeader(label);
    if (field && ![...fieldAt.values()].includes(field)) {
      fieldAt.set(col, field);
      recognized.push(label);
    } else {
      // A column the import doesn't read (e.g. "On hand (read-only)"), or a
      // second copy of one it already has — the first copy wins.
      ignored.push(label);
    }
  });

  const rows: RawImportRow[] = [];
  for (const { rowNumber, values } of grid.slice(headerIndex + 1)) {
    const cells: Partial<Record<ImportField, unknown>> = {};
    let blank = true;
    for (const [col, field] of fieldAt) {
      const value = values[col];
      if (!isBlankCell(value)) blank = false;
      cells[field] = value;
    }
    if (blank) continue;
    rows.push({ rowNumber, cells });
    if (rows.length > MAX_IMPORT_ROWS) throw tooManyRows();
  }

  if (rows.length === 0) {
    throw fail(
      'IMPORT_EMPTY',
      'The sheet has column names but no items under them.',
    );
  }
  return { sheetName, recognized, ignored, rows };
}

const tooManyRows = () =>
  fail(
    'IMPORT_TOO_MANY_ROWS',
    `A file can hold at most ${MAX_IMPORT_ROWS.toLocaleString('en-US')} items. Split it into smaller files and import them one after another.`,
  );
