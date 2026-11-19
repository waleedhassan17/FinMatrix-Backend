import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  compress,
  writeBtrieve,
  WriterOptions,
} from '../../../../../test/fixtures/peachtree/btrieve-writer';
import { BtrieveError, BtrieveFile, decompress } from './btrieve';

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'btrieve-spec-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function save(buffer: Buffer): string {
  const path = join(dir, `t${n++}.dat`);
  writeFileSync(path, buffer);
  return path;
}

async function readAll(path: string, expected?: number): Promise<Buffer[]> {
  const f = await BtrieveFile.open(path);
  try {
    const out: Buffer[] = [];
    for await (const r of f.records(expected)) out.push(r);
    return out;
  } finally {
    await f.close();
  }
}

async function failure(p: Promise<unknown>): Promise<BtrieveError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BtrieveError);
    return e as BtrieveError;
  }
  throw new Error('expected a BtrieveError');
}

/** Distinct, recognisable fixed-length records. */
function plainRecords(count: number, length = 24): Buffer[] {
  return [...Array(count)].map((_, i) => {
    const b = Buffer.alloc(length);
    b.write(`REC${String(i).padStart(6, '0')}`, 0, 'latin1');
    b.writeUInt32LE(i * 7 + 1, length - 4);
    return b;
  });
}

/** Records that compress: long zero runs, repeated bytes, varying lengths. */
function compressibleRecords(count: number, length = 300): Buffer[] {
  return [...Array(count)].map((_, i) => {
    const b = Buffer.alloc(length);
    b.write(`Customer ${i}`, 0, 'latin1');
    b.fill(0x20, 40, 80); // spaces
    b.writeDoubleLE(i * 1234.5, 120);
    b.fill(0x41 + (i % 26), 200, 200 + (i % 50));
    return b;
  });
}

const build = (o: WriterOptions) => writeBtrieve(o);

describe('BtrieveFile — plain records', () => {
  it('reads every record in order, from the current FCR copy', async () => {
    const records = plainRecords(40);
    const w = build({ recordLength: 24, records });
    const f = await BtrieveFile.open(save(w.buffer));
    expect(f.info).toMatchObject({
      pageSize: 512,
      recordLength: 24,
      recordCount: 40,
      compressed: false,
    });
    await f.close();
    expect(await readAll(save(w.buffer), 24)).toEqual(records);
  });

  it('skips free slots, whatever bytes sit behind them', async () => {
    const records = plainRecords(30);
    const w = build({
      recordLength: 24,
      records,
      freeBefore: new Set([0, 5, 6, 29]),
    });
    expect(await readAll(save(w.buffer))).toEqual(records);
  });

  it('follows the current PAT copy, never the stale one or stale shadow pages', async () => {
    const records = plainRecords(60);
    const w = build({ recordLength: 24, records, shadows: true });
    expect(await readAll(save(w.buffer))).toEqual(records);
  });

  it('corrects each region for its drift, across several regions', async () => {
    // 512-byte pages: 126 logical pages per PAT; 400 records of 24 bytes in
    // 30-byte slots fill ~24 pages, so use more records for three regions.
    const records = plainRecords(4500, 24);
    const w = build({ recordLength: 24, records, drift: [3, 5, 9] });
    expect(w.currentPat.length).toBeGreaterThanOrEqual(3);
    expect(await readAll(save(w.buffer))).toEqual(records);
  });

  it('reads a record count above 65535 (stored as two 16-bit halves)', async () => {
    const records = plainRecords(65539, 4);
    const w = build({ pageSize: 4096, recordLength: 4, records, keyCount: 0 });
    const got = await readAll(save(w.buffer));
    expect(got.length).toBe(65539);
    expect(got[65538]).toEqual(records[65538]);
  });

  it('refuses a file whose record count disagrees with what it holds', async () => {
    const w = build({
      recordLength: 24,
      records: plainRecords(10),
      recordCount: 11,
    });
    const e = await failure(readAll(save(w.buffer)));
    expect(e.code).toBe('MIGRATION_PTB_UNREADABLE');
    expect(e.message).toMatch(/10 records read, but the file holds 11/);
  });

  it('refuses records of a different length than the dictionary defines', async () => {
    const w = build({ recordLength: 24, records: plainRecords(3) });
    const e = await failure(readAll(save(w.buffer), 30));
    expect(e.message).toMatch(/24 bytes; its table defines 30/);
  });
});

describe('BtrieveFile — compressed records', () => {
  it('rebuilds records from fragment chains across variable pages', async () => {
    const records = compressibleRecords(80);
    const w = build({
      recordLength: 0,
      records,
      compressed: true,
      fragmentBytes: 37,
    });
    expect(w.variablePages.length).toBeGreaterThan(1);
    const f = await BtrieveFile.open(save(w.buffer));
    expect(f.info.compressed).toBe(true);
    await f.close();
    expect(await readAll(save(w.buffer), 300)).toEqual(records);
  });

  it('handles free slots, shadows and drift together', async () => {
    const records = compressibleRecords(50);
    const w = build({
      recordLength: 0,
      records,
      compressed: true,
      freeBefore: new Set([1, 2, 40]),
      shadows: true,
      drift: [4],
    });
    expect(await readAll(save(w.buffer))).toEqual(records);
  });

  it('refuses a record whose fragment pointer loops or dangles', async () => {
    const records = compressibleRecords(4);
    const w = build({ recordLength: 0, records, compressed: true });
    // Point the first data slot at a fragment that does not exist.
    const data = w.physical.get(w.dataPages[0])!;
    const o = data * w.pageSize + 6;
    w.buffer[o + 3] = 250; // past the page's offset table
    const e = await failure(readAll(save(w.buffer)));
    expect(e.code).toBe('MIGRATION_PTB_UNREADABLE');
  });
});

describe('BtrieveFile — refusals', () => {
  it('refuses a file that is not Btrieve', async () => {
    const e = await failure(BtrieveFile.open(save(Buffer.alloc(4096, 0x41))));
    expect(e.code).toBe('MIGRATION_PTB_UNSUPPORTED');
  });

  it('refuses an impossible page size', async () => {
    const w = build({ recordLength: 24, records: plainRecords(3) });
    w.buffer.writeUInt16LE(700, 8);
    w.buffer.writeUInt16LE(700, 512 + 8);
    const e = await failure(BtrieveFile.open(save(w.buffer)));
    expect(e.code).toBe('MIGRATION_PTB_UNREADABLE');
  });

  it('refuses unsupported features (blob tables, variable-length plain records)', async () => {
    for (const flags of [0x0800, 0x01]) {
      const w = build({ recordLength: 24, records: plainRecords(3), flags });
      const e = await failure(BtrieveFile.open(save(w.buffer)));
      expect(e.code).toBe('MIGRATION_PTB_UNSUPPORTED');
    }
  });

  it('refuses a file with no page allocation table', async () => {
    const w = build({ recordLength: 24, records: plainRecords(3) });
    // Region 0's pair: its current copy comes first.
    for (const p of [0, 1]) w.buffer[(w.currentPat[0] + p) * w.pageSize] = 0;
    const e = await failure(readAll(save(w.buffer)));
    expect(e.message).toMatch(/page allocation table/);
  });

  it('refuses a PAT entry that lands on the wrong logical page', async () => {
    const w = build({ recordLength: 24, records: plainRecords(30) });
    const pat = w.currentPat[0] * w.pageSize;
    // Swap the first two data-page pointers.
    const a = w.buffer.subarray(pat + 8, pat + 12);
    const b = w.buffer.subarray(pat + 12, pat + 16);
    const t = Buffer.from(a);
    b.copy(a);
    t.copy(b);
    const e = await failure(readAll(save(w.buffer)));
    expect(e.message).toMatch(/points at a page holding logical page/);
  });

  it('refuses a PAT entry past the end of the file', async () => {
    const w = build({ recordLength: 24, records: plainRecords(3) });
    const pat = w.currentPat[0] * w.pageSize;
    w.buffer[pat + 8] = 0x7f; // high byte of the first pointer
    const e = await failure(readAll(save(w.buffer)));
    expect(e.message).toMatch(/past the end/);
  });
});

describe('decompress', () => {
  it('round-trips literals and runs, including a leading run', () => {
    for (const r of [
      Buffer.from('hello world'),
      Buffer.alloc(100),
      Buffer.concat([
        Buffer.alloc(10),
        Buffer.from('abc'),
        Buffer.alloc(5, 0x20),
      ]),
      Buffer.alloc(0),
      ...compressibleRecords(5),
    ]) {
      expect(decompress(compress(r))).toEqual(r);
    }
  });

  it('refuses truncated tokens', () => {
    expect(() => decompress(Buffer.from([5]))).toThrow(/inside a token/);
    expect(() => decompress(Buffer.from([5, 0, 0x41]))).toThrow(
      /inside a literal/,
    );
    expect(() => decompress(Buffer.from([0, 0, 9, 0]))).toThrow(/inside a run/);
  });

  it('refuses an impossible expansion', () => {
    // literal 0, run 0xffff — six times
    const stream = Buffer.concat(
      [...Array(6)].map(() => Buffer.from([0, 0, 0xff, 0xff, 0x41])),
    );
    expect(() => decompress(stream)).toThrow(/impossibly far/);
  });
});
