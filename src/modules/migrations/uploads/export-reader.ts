/**
 * Reads a large export — a ZIP of reports, a big CSV or text file, a large
 * workbook, IIF or XML — once, in the background, and keeps only what an
 * opening-balance migration uses.
 *
 * Each sheet is judged from its first rows: a report FinMatrix recognises
 * (sources/reports) or a sheet the generic detector can place is kept whole;
 * anything else — a general ledger, a journal, a sheet of a million rows
 * nothing recognises — is listed as skipped and is not read further, let
 * alone held in memory. Small entries go through the same reader as a
 * direct upload, so a ZIP of ordinary files reads exactly as it would there.
 */
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { readXlsxLean } from './xlsx-lean';
import { detectSheet } from '../mapping/sheet-detector';
import {
  readUpload,
  SourceGrid,
  sniffDelimiter,
  ZIP_LOCKED,
} from '../readers/read-upload';
import { REPORT_PROFILES } from '../sources/reports/profiles';
import {
  isStarterSheet,
  recogniseReport,
  SKIPPED_KINDS,
} from '../sources/reports/report-engine';
import { BtrieveError } from '../sources/peachtree/btrieve';
import { forEachEntry, PTB_ZIP_LIMITS } from '../sources/peachtree/zip';

export interface SourceExtract {
  format: 'finmatrix-source-extract';
  version: 1;
  name: string;
  sheets: SourceGrid[];
  /** XML documents (Tally) kept as text. */
  xml: string[];
  skipped: Array<{ entry: string; reason: string }>;
}

export interface ExportReadOptions {
  /** Sheets kept may not be longer than this (the analysis limit). */
  maxRows: number;
  /** Entries up to this size are read in memory, as a direct upload is. */
  inMemoryBytes: number;
  /** XML is kept as text only up to this size. */
  maxXmlBytes: number;
  preferredSource?: string;
  onProgress?: (detail: string) => void;
}

const HEAD_ROWS = 40;
/** Rows between progress reports: a long read must never look like a dead one. */
const HEARTBEAT_ROWS = 50_000;
const READABLE = /\.(xlsx|csv|tsv|txt|iif|xml)$/i;

const fail = (message: string) =>
  new BtrieveError('MIGRATION_PTB_UNREADABLE', message);

/** Whether a sheet whose first rows are these is worth keeping, and why not if not. */
export function judgeSheet(
  grid: SourceGrid,
  preferredSource?: string,
): { keep: boolean; reason: string } {
  const r = recogniseReport(grid, REPORT_PROFILES, preferredSource);
  if (r) {
    if (SKIPPED_KINDS.includes(r.spec.kind))
      return {
        keep: false,
        reason: `${r.profile.label} ${r.spec.kind.replace(/_/g, ' ')} — not needed`,
      };
    return { keep: true, reason: '' };
  }
  if (isStarterSheet(grid)) return { keep: true, reason: '' };
  const d = detectSheet(grid.name, grid.rows);
  if (d.target) return { keep: true, reason: '' };
  return {
    keep: false,
    reason: 'not recognised as anything a migration needs',
  };
}

/** A streaming CSV/TSV parser: fields with quotes, any line ending. */
function* csvRows(
  text: string,
  delimiter: string,
  state: { field: string; row: string[]; quoted: boolean; pendingCr: boolean },
): Generator<string[]> {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state.pendingCr) {
      state.pendingCr = false;
      if (ch === '\n') continue;
    }
    if (state.quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          state.field += '"';
          i++;
        } else state.quoted = false;
      } else state.field += ch;
    } else if (ch === '"' && state.field === '') {
      state.quoted = true;
    } else if (ch === delimiter) {
      state.row.push(state.field);
      state.field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r') state.pendingCr = true;
      state.row.push(state.field);
      const done = state.row;
      state.row = [];
      state.field = '';
      yield done;
    } else {
      state.field += ch;
    }
  }
}

/** A big delimited text (CSV, TSV, TXT, IIF): one sheet, judged on its first rows. */
async function readLargeText(
  stream: NodeJS.ReadableStream,
  name: string,
  opts: ExportReadOptions,
  out: SourceExtract,
): Promise<void> {
  const decoderFor = (head: Buffer) =>
    head[0] === 0xff && head[1] === 0xfe
      ? new TextDecoder('utf-16le')
      : head[0] === 0xfe && head[1] === 0xff
        ? new TextDecoder('utf-16be')
        : new TextDecoder('utf-8');
  let decoder: TextDecoder | null = null;
  let delimiter: string | null = null;
  let buffered = '';
  const state = {
    field: '',
    row: [] as string[],
    quoted: false,
    pendingCr: false,
  };
  const grid: SourceGrid = {
    name: name
      .replace(/\.[A-Za-z0-9]{1,5}$/, '')
      .split('/')
      .pop()!,
    rows: [],
  };
  let rowNumber = 0;
  let decided: boolean | null = null;
  const take = (cells: string[]) => {
    rowNumber++;
    if (rowNumber % HEARTBEAT_ROWS === 0)
      opts.onProgress?.(`${name}: ${rowNumber.toLocaleString()} rows`);
    if (cells.every((c) => c.trim() === '')) return;
    grid.rows.push({ rowNumber, cells });
    if (grid.rows.length > opts.maxRows && decided !== false) {
      // Opening balances never run this long: a ledger or a history.
      decided = false;
      grid.rows = [];
      out.skipped.push({
        entry: name,
        reason: `over ${opts.maxRows.toLocaleString()} rows — a ledger or history, not opening balances; not read`,
      });
    }
  };
  const decide = () => {
    const j = judgeSheet(grid, opts.preferredSource);
    decided = j.keep;
    if (!j.keep) out.skipped.push({ entry: name, reason: j.reason });
  };
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (!decoder) {
      decoder = decoderFor(chunk);
      const skip =
        chunk[0] === 0xff || chunk[0] === 0xfe
          ? 2
          : chunk[0] === 0xef && chunk[1] === 0xbb
            ? 3
            : 0;
      buffered += decoder.decode(chunk.subarray(skip), { stream: true });
    } else {
      buffered += decoder.decode(chunk, { stream: true });
    }
    if (!delimiter) {
      if (
        buffered.length < 64 * 1024 &&
        buffered.split('\n').length < HEAD_ROWS
      )
        continue;
      delimiter = /\.iif$/i.test(name) ? '\t' : sniffDelimiter(buffered);
    }
    for (const row of csvRows(buffered, delimiter, state)) {
      take(row);
      if (decided === null && grid.rows.length >= HEAD_ROWS) decide();
      if (decided === false) {
        (stream as Readable).destroy?.();
        return;
      }
    }
    buffered = '';
  }
  if (!delimiter)
    delimiter = /\.iif$/i.test(name) ? '\t' : sniffDelimiter(buffered);
  if (buffered)
    for (const row of csvRows(buffered, delimiter, state)) take(row);
  if (state.field !== '' || state.row.length) take([...state.row, state.field]);
  if (decided === null) decide();
  if (decided) out.sheets.push(grid);
}

async function toBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) parts.push(c);
  return Buffer.concat(parts);
}

async function readEntry(
  name: string,
  size: number,
  open: () => Promise<NodeJS.ReadableStream>,
  opts: ExportReadOptions,
  out: SourceExtract,
) {
  const lower = name.toLowerCase();
  opts.onProgress?.(name.split('/').pop()!);
  if (lower.endsWith('.xml')) {
    if (size > opts.maxXmlBytes) {
      out.skipped.push({
        entry: name,
        reason: `an XML file of ${(size / 1_048_576).toFixed(0)} MB — larger than a Tally master, balance or outstanding export; not read`,
      });
      ((await open()) as Readable).destroy();
      return;
    }
    const text = (await toBuffer(await open()))
      .toString('utf8')
      .replace(/^﻿/, '');
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw fail(`${name} contains a DOCTYPE, which a Tally export never has.`);
    out.xml.push(text);
    return;
  }
  if (size <= opts.inMemoryBytes) {
    const contents = await readUpload(
      await toBuffer(await open()),
      name.split('/').pop()!,
      {
        maxBytes: opts.inMemoryBytes,
        maxRows: opts.maxRows,
      },
    );
    for (const g of contents.sheets) {
      const j = judgeSheet(g, opts.preferredSource);
      if (j.keep) out.sheets.push(g);
      else out.skipped.push({ entry: `${name}/${g.name}`, reason: j.reason });
    }
    out.xml.push(...(contents.xml ?? []));
    return;
  }
  if (lower.endsWith('.xlsx'))
    return readLargeXlsxFile(await toDisk(await open()), name, opts, out, true);
  return readLargeText(await open(), name, opts, out);
}

/** A large workbook needs random access: an entry inside a ZIP goes to a temporary file first. */
async function toDisk(stream: NodeJS.ReadableStream): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fm-xlsx-'));
  const path = join(dir, 'book.xlsx');
  await pipeline(stream, createWriteStream(path));
  return path;
}

async function readLargeXlsxFile(
  path: string,
  name: string,
  opts: ExportReadOptions,
  out: SourceExtract,
  temporary: boolean,
) {
  try {
    const r = await readXlsxLean(
      path,
      name
        .replace(/\.xlsx$/i, '')
        .split('/')
        .pop()!,
      {
        headRows: HEAD_ROWS,
        maxRows: opts.maxRows,
        judge: (g) => judgeSheet(g, opts.preferredSource),
        onProgress: opts.onProgress,
      },
    );
    out.sheets.push(...r.sheets);
    out.skipped.push(...r.skipped);
  } catch (err) {
    throw fail(
      `${name} could not be read as an Excel workbook (${(err as Error).message}).`,
    );
  } finally {
    if (temporary) await rm(join(path, '..'), { recursive: true, force: true });
  }
}

/** Read the export at `path` (its original name says what it is). */
export async function readExport(
  path: string,
  originalName: string,
  opts: ExportReadOptions,
): Promise<SourceExtract> {
  const out: SourceExtract = {
    format: 'finmatrix-source-extract',
    version: 1,
    name: originalName,
    sheets: [],
    xml: [],
    skipped: [],
  };
  const { size } = await stat(path);
  if (/\.zip$/i.test(originalName)) {
    await forEachEntry(
      path,
      async (e, open) => {
        if (!READABLE.test(e.name)) {
          out.skipped.push({
            entry: e.name,
            reason: 'not a spreadsheet, text or XML file',
          });
          return;
        }
        await readEntry(e.name, e.size, open, opts, out);
      },
      { ...PTB_ZIP_LIMITS, lockedMessage: ZIP_LOCKED },
    );
  } else if (/\.xlsx$/i.test(originalName) && size > opts.inMemoryBytes) {
    await readLargeXlsxFile(path, originalName, opts, out, false);
  } else if (READABLE.test(originalName)) {
    await readEntry(
      originalName,
      size,
      async () => createReadStream(path),
      opts,
      out,
    );
  } else {
    throw fail(
      `${originalName} is not a ZIP, spreadsheet, text, IIF or XML file.`,
    );
  }
  if (!out.sheets.length && !out.xml.length) {
    throw fail(
      `Nothing in ${originalName} is a report or list a migration uses${
        out.skipped.length
          ? ` (${out.skipped
              .slice(0, 5)
              .map((s) => `${s.entry}: ${s.reason}`)
              .join('; ')})`
          : ''
      }.`,
    );
  }
  return out;
}
