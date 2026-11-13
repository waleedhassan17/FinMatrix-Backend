import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import { parseCsv } from '../../inventory/import/read-sheet';
import { MigrationFileKind } from '../entities/migration-file.entity';

/** One sheet (or CSV) as a grid of raw cells; exceljs values are kept as-is. */
export interface SourceGrid {
  /** Sheet name, or `entry/sheet` inside a ZIP, or the CSV's file name. */
  name: string;
  rows: Array<{ rowNumber: number; cells: unknown[] }>;
}

export interface UploadContents {
  kind: MigrationFileKind;
  sheets: SourceGrid[];
  /** For a Tally Data Interchange file: the XML text, parsed by its source profile. */
  /** Each Tally Data Interchange document, one per XML file, for its source profile. */
  xml?: string[];
}

export interface ReadLimits {
  maxBytes: number;
  /** Rows per sheet, header included. */
  maxRows: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxRows: 100_000,
};
/** Unzipped size of an .xlsx or ZIP we are willing to inflate. */
const MAX_UNZIPPED_BYTES = 400 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 50;

const fail = (code: string, message: string) =>
  new BadRequestException({ code, message });

/**
 * Read an uploaded file into sheets of raw cells. The bytes decide the type,
 * never the name: phones report spreadsheets as application/octet-stream.
 *
 *   .xlsx  → every visible sheet
 *   .csv   → one sheet named after the file
 *   .zip   → each .xlsx / .csv / .xml inside (one level), sheets prefixed
 *   .xml   → kept as text for the Tally profile
 */
export async function readUpload(
  buffer: Buffer,
  originalName: string,
  limits: ReadLimits = DEFAULT_READ_LIMITS,
): Promise<UploadContents> {
  if (buffer.length > limits.maxBytes) {
    throw fail(
      'MIGRATION_FILE_TOO_LARGE',
      `${originalName} is ${(buffer.length / 1_048_576).toFixed(1)} MB; the limit is ${Math.round(limits.maxBytes / 1_048_576)} MB. Split it into smaller files.`,
    );
  }
  const base = stripExt(originalName);
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x504b0304) {
    assertZipWithinLimits(buffer, originalName);
    return isXlsx(buffer)
      ? readXlsx(buffer, '', limits)
      : readZip(buffer, limits);
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    throw new UnsupportedMediaTypeException({
      code: 'MIGRATION_FILE_UNREADABLE',
      message: `${originalName} is an old Excel 97–2003 (.xls) file. Open it in Excel, choose Save As → Excel Workbook (.xlsx), and upload that.`,
    });
  }
  const head = buffer
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^﻿/, '')
    .trimStart();
  if (
    head.startsWith('<?xml') ||
    head.startsWith('<ENVELOPE') ||
    head.startsWith('<TALLYMESSAGE')
  ) {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    // A DOCTYPE can declare entities that expand without bound and pin the
    // server. Tally never writes one, so its presence means the file is not
    // a Tally export, whatever else it is.
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
      throw new UnsupportedMediaTypeException({
        code: 'MIGRATION_FILE_UNREADABLE',
        message: `${originalName} contains a DOCTYPE, which a Tally export never has. Export it again from Tally and upload that file.`,
      });
    }
    return { kind: 'xml', sheets: [], xml: [text] };
  }
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new UnsupportedMediaTypeException({
      code: 'MIGRATION_FILE_UNREADABLE',
      message: `${originalName} is not a spreadsheet, CSV, XML or ZIP file.`,
    });
  }
  const grid = parseCsv(buffer.toString('utf8'));
  if (grid.length > limits.maxRows)
    throw tooManyRows(originalName, limits.maxRows);
  return {
    kind: 'csv',
    sheets: [
      {
        name: base,
        rows: grid.map((r) => ({ rowNumber: r.rowNumber, cells: r.values })),
      },
    ],
  };
}

function stripExt(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

function isXlsx(buffer: Buffer): boolean {
  // The first local header of an OOXML package names [Content_Types].xml
  // (or _rels/.rels, or docProps) — a plain ZIP of CSVs does not.
  const firstName = buffer
    .subarray(30, 30 + buffer.readUInt16LE(26))
    .toString('latin1');
  return /^(\[Content_Types\]\.xml|_rels\/|docProps\/|xl\/)/.test(firstName);
}

async function readXlsx(
  buffer: Buffer,
  prefix: string,
  limits: ReadLimits,
): Promise<UploadContents> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw fail(
      'MIGRATION_FILE_UNREADABLE',
      `${prefix || 'This file'} could not be opened as an Excel workbook. Save it again from Excel as .xlsx and retry.`,
    );
  }
  const sheets: SourceGrid[] = [];
  for (const ws of workbook.worksheets) {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;
    if (ws.actualRowCount > limits.maxRows)
      throw tooManyRows(`${prefix}${ws.name}`, limits.maxRows);
    const rows: SourceGrid['rows'] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        cells[col - 1] = cell.value;
      });
      rows.push({ rowNumber, cells });
    });
    sheets.push({ name: `${prefix}${ws.name}`, rows });
  }
  if (sheets.length === 0)
    throw fail(
      'MIGRATION_FILE_UNREADABLE',
      `${prefix || 'This workbook'} has no sheets.`,
    );
  return { kind: 'xlsx', sheets };
}

async function readZip(
  buffer: Buffer,
  limits: ReadLimits,
): Promise<UploadContents> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw fail(
      'MIGRATION_FILE_UNREADABLE',
      'This ZIP file is damaged and could not be opened.',
    );
  }
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.)/.test(e.entryName));
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw fail(
      'MIGRATION_FILE_TOO_LARGE',
      `This ZIP holds ${entries.length} files; the limit is ${MAX_ZIP_ENTRIES}.`,
    );
  }
  const sheets: SourceGrid[] = [];
  const xml: string[] = [];
  for (const entry of entries) {
    const name = entry.entryName;
    const lower = name.toLowerCase();
    if (!/\.(xlsx|csv|xml)$/.test(lower)) continue;
    const data = entry.getData();
    if (data.length > limits.maxBytes)
      throw fail(
        'MIGRATION_FILE_TOO_LARGE',
        `${name} inside the ZIP is larger than the limit.`,
      );
    const inner = await readUpload(data, name.split('/').pop() ?? name, limits);
    if (inner.xml) xml.push(...inner.xml);
    for (const s of inner.sheets) {
      sheets.push({
        name:
          inner.kind === 'csv'
            ? s.name
            : `${stripExt(name.split('/').pop() ?? name)}/${s.name}`,
        rows: s.rows,
      });
    }
  }
  if (sheets.length === 0 && xml.length === 0) {
    throw fail(
      'MIGRATION_FILE_UNREADABLE',
      'This ZIP holds no .xlsx, .csv or .xml file.',
    );
  }
  return { kind: 'zip', sheets, ...(xml.length ? { xml } : {}) };
}

/** Sum the uncompressed sizes in the central directory without inflating anything. */
function assertZipWithinLimits(buffer: Buffer, name: string): void {
  const searchFrom = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1)
    throw fail(
      'MIGRATION_FILE_UNREADABLE',
      `${name} is damaged and could not be opened.`,
    );
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      throw fail(
        'MIGRATION_FILE_UNREADABLE',
        `${name} is damaged and could not be opened.`,
      );
    }
    const uncompressed = buffer.readUInt32LE(offset + 24);
    total += uncompressed === 0xffffffff ? Infinity : uncompressed;
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
  if (total > MAX_UNZIPPED_BYTES) {
    throw fail(
      'MIGRATION_FILE_TOO_LARGE',
      `${name} unpacks to more than ${Math.round(MAX_UNZIPPED_BYTES / 1_048_576)} MB and cannot be read.`,
    );
  }
}

const tooManyRows = (where: string, max: number) =>
  fail(
    'MIGRATION_FILE_TOO_LARGE',
    `${where} has more than ${max.toLocaleString('en-US')} rows. Split it into smaller files.`,
  );
