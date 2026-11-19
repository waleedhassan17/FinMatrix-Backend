/**
 * A lean reader for very large .xlsx files on disk: each sheet is judged on
 * its first rows, and a sheet that is not kept is closed there — its
 * remaining (possibly millions of) rows are never inflated or parsed.
 * Shared strings are resolved only for the cells actually kept, so a
 * workbook whose string table is huge costs memory only for what is read.
 *
 * Supported cell forms: numbers, shared strings (t="s"), inline strings
 * (t="inlineStr"), formula strings (t="str"), booleans (t="b"); errors
 * (t="e") read as blank. Dates arrive as Excel serial numbers, which the
 * date parser reads.
 */
import * as yauzl from 'yauzl';
import { SourceGrid } from '../readers/read-upload';

type RawCell = { col: number; t: string; v: string };
type RawRow = { rowNumber: number; cells: RawCell[] };

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, ''))
    n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, z) =>
      err || !z ? reject(err ?? new Error('not a workbook')) : resolve(z),
    ),
  );
}

async function entries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  const map = new Map<string, yauzl.Entry>();
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (e: yauzl.Entry) => {
      map.set(e.fileName, e);
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  return map;
}

const stream = (zip: yauzl.ZipFile, e: yauzl.Entry) =>
  new Promise<NodeJS.ReadableStream>((resolve, reject) =>
    zip.openReadStream(e, (err, s) => (err || !s ? reject(err) : resolve(s))),
  );

async function text(
  zip: yauzl.ZipFile,
  e: yauzl.Entry | undefined,
): Promise<string> {
  if (!e) return '';
  const parts: Buffer[] = [];
  for await (const c of (await stream(zip, e)) as AsyncIterable<Buffer>)
    parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Rows of a sheet, streamed. `keepGoing(rowsSoFar)` is asked after each row;
 * returning false closes the sheet there.
 */
async function sheetRows(
  zip: yauzl.ZipFile,
  e: yauzl.Entry,
  keepGoing: (rows: RawRow[]) => boolean,
): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const s = (await stream(zip, e)) as NodeJS.ReadableStream & {
    destroy: () => void;
  };
  let buf = '';
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for await (const chunk of s as AsyncIterable<Buffer>) {
    buf += chunk.toString('utf8');
    let end: number;
    while ((end = buf.indexOf('</row>')) >= 0) {
      const xml = buf.slice(0, end);
      buf = buf.slice(end + 6);
      const start = xml.lastIndexOf('<row');
      if (start < 0) continue;
      const rowXml = xml.slice(start);
      const rMatch = /<row\b[^>]*\br="(\d+)"/.exec(rowXml);
      const cells: RawCell[] = [];
      let auto = 0;
      for (const m of rowXml.matchAll(cellRe)) {
        const attrs = m[1];
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const col = ref ? colIndex(ref) : auto;
        auto = col + 1;
        const t = /\bt="([a-z]+)"/i.exec(attrs)?.[1] ?? 'n';
        const inner = m[2] ?? '';
        let v = '';
        if (t === 'inlineStr')
          v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
            .map((x) => decode(x[1]))
            .join('');
        else v = decode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
        cells.push({ col, t, v });
      }
      rows.push({
        rowNumber: rMatch ? Number(rMatch[1]) : rows.length + 1,
        cells,
      });
      if (!keepGoing(rows)) {
        s.destroy();
        return rows;
      }
    }
  }
  return rows;
}

/** The shared strings at `wanted` indices, streamed; nothing else kept. */
async function sharedStrings(
  zip: yauzl.ZipFile,
  e: yauzl.Entry | undefined,
  wanted: Set<number>,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!e || !wanted.size) return out;
  const max = Math.max(...wanted);
  const s = (await stream(zip, e)) as NodeJS.ReadableStream & {
    destroy: () => void;
  };
  let buf = '';
  let index = 0;
  for await (const chunk of s as AsyncIterable<Buffer>) {
    buf += chunk.toString('utf8');
    let end: number;
    while ((end = buf.indexOf('</si>')) >= 0) {
      const si = buf.slice(0, end);
      buf = buf.slice(end + 5);
      if (wanted.has(index)) {
        out.set(
          index,
          [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
            .map((x) => decode(x[1]))
            .join(''),
        );
      }
      if (++index > max) {
        s.destroy();
        return out;
      }
    }
  }
  return out;
}

function resolve(rows: RawRow[], strings: Map<number, string>) {
  return rows.map((r) => {
    const cells: unknown[] = [];
    for (const c of r.cells) {
      cells[c.col] =
        c.t === 's'
          ? (strings.get(Number(c.v)) ?? '')
          : c.t === 'b'
            ? c.v === '1'
            : c.t === 'e'
              ? null
              : c.t === 'str' || c.t === 'inlineStr'
                ? c.v
                : c.v === ''
                  ? null
                  : Number(c.v);
    }
    for (let i = 0; i < cells.length; i++)
      if (cells[i] === undefined) cells[i] = null;
    return { rowNumber: r.rowNumber, cells: cells as any[] };
  });
}

const stringIndices = (rows: RawRow[]) =>
  new Set(
    rows.flatMap((r) =>
      r.cells.filter((c) => c.t === 's').map((c) => Number(c.v)),
    ),
  );

/**
 * Read the workbook at `path`: every sheet's first `headRows` rows are
 * judged; sheets judged worth keeping are read whole (up to `maxRows`).
 */
export async function readXlsxLean(
  path: string,
  baseName: string,
  opts: {
    headRows: number;
    maxRows: number;
    judge: (g: SourceGrid) => { keep: boolean; reason: string };
    onProgress?: (detail: string) => void;
  },
): Promise<{
  sheets: SourceGrid[];
  skipped: Array<{ entry: string; reason: string }>;
}> {
  const zip = await openZip(path);
  try {
    const all = await entries(zip);
    const workbook = await text(zip, all.get('xl/workbook.xml'));
    const rels = await text(zip, all.get('xl/_rels/workbook.xml.rels'));
    const target = new Map(
      [
        ...rels.matchAll(
          /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g,
        ),
      ].map((m) => [m[1], m[2]]),
    );
    const targetAlt = new Map(
      [
        ...rels.matchAll(
          /<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g,
        ),
      ].map((m) => [m[2], m[1]]),
    );
    const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
      const name = decode(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? 'Sheet');
      const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1] ?? '';
      const hidden = /\bstate="(hidden|veryHidden)"/.test(m[1]);
      const t = (target.get(rid) ?? targetAlt.get(rid) ?? '')
        .replace(/^\/?xl\//, '')
        .replace(/^\//, '');
      return { name, path: `xl/${t}`, hidden };
    });
    const sst = all.get('xl/sharedStrings.xml');
    const kept: SourceGrid[] = [];
    const skipped: Array<{ entry: string; reason: string }> = [];
    for (const sh of sheets) {
      const label = `${baseName}/${sh.name}`;
      const e = all.get(sh.path);
      if (sh.hidden || !e) continue;
      opts.onProgress?.(label);
      const head = await sheetRows(
        zip,
        e,
        (rows) => rows.length < opts.headRows,
      );
      const headStrings = await sharedStrings(zip, sst, stringIndices(head));
      const verdict = opts.judge({
        name: label,
        rows: resolve(head, headStrings),
      });
      if (!verdict.keep) {
        skipped.push({ entry: label, reason: verdict.reason });
        continue;
      }
      let tooMany = false;
      const rows = await sheetRows(zip, e, (r) => {
        if (r.length % 50_000 === 0)
          opts.onProgress?.(`${label}: ${r.length.toLocaleString()} rows`);
        if (r.length > opts.maxRows) tooMany = true;
        return !tooMany;
      });
      if (tooMany) {
        skipped.push({
          entry: label,
          reason: `over ${opts.maxRows.toLocaleString()} rows — a ledger or history, not opening balances; not read`,
        });
        continue;
      }
      kept.push({
        name: label,
        rows: resolve(rows, await sharedStrings(zip, sst, stringIndices(rows))),
      });
    }
    return { sheets: kept, skipped };
  } finally {
    zip.close();
  }
}
