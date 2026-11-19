/**
 * A read-only reader for Btrieve 6.x files (Pervasive.SQL), the database a
 * Peachtree / Sage 50 company is kept in. It reads what a backup holds and
 * nothing more: no indexes, no writes, no locking.
 *
 * The format, as this reader relies on it (each point checked against the
 * Peachtree 2015 files it was written for, and against the MIT-licensed
 * mbbsemu/wbtrv32 reader where noted):
 *
 *  - Physical pages 0 and 1 are two copies of the File Control Record
 *    ('FC'); the copy with the higher usage count (u32 at 4) is current. It
 *    holds the page size (u16 at 0x08), key count (0x14), fixed record length
 *    (0x16), slot length (0x18), record count (u16 high at 0x1A, low at 0x1C)
 *    and the file flags (u16 at 0x106: 0x08 compressed, 0x01 variable,
 *    0x0800 blob table).
 *  - Pages are never rewritten in place: a changed page is written to a free
 *    physical page and the old copy is left behind, so a file holds stale
 *    copies of many pages. Every page header starts with the logical page it
 *    holds — [high][type][low][mid] — then a 15-bit usage count, which wraps
 *    and so cannot tell copies apart. The Page Allocation Table decides: 'PP'
 *    pages in pairs, the current copy of a pair the one with the higher u32
 *    usage count at 4, its sequence number at 2; entry n of PAT s (4 bytes,
 *    [high][type][low][mid] from byte 8) maps logical page (s−1)·E + n + 1,
 *    E = (pageSize − 8) / 4. Its page numbers assume each region's PAT pair
 *    sits at 2 + region·(pageSize / 4); where a pair actually sits further
 *    on, every page in that region is shifted by the same amount (the
 *    mbbsemu/wbtrv32 reader's toFilePage). With that correction every
 *    pointer in Peachtree's files lands on a page naming the same logical
 *    page and type — which this reader checks for each one, and refuses the
 *    file otherwise.
 *  - Data pages ('D') hold fixed slots after a 6-byte header. In a plain file
 *    a slot is a 2-byte usage count (0 = free) and the record. In a
 *    compressed file the whole record lives on variable pages and the slot is
 *    a 4-byte pointer to its first fragment, an in-use byte (1) and a 2-byte
 *    counter, followed by duplicate-key links in both layouts.
 *  - Variable pages ('V') hold fragments; their offsets are a table of u16 at
 *    the end of the page, fragment n at (pageSize − 2 − 2n), 0xFFFF for a
 *    deleted one. A fragment ends where the next live entry begins. Each
 *    fragment starts with a pointer to the next ([high][low][mid][fragment],
 *    fragment 0xFF = end).
 *  - Compressed records are a run of tokens that alternate, literal first: a
 *    literal is a u16 count and that many bytes, a run a u16 count and the
 *    byte repeated.
 *
 * Every read is checked rather than trusted: the records read must equal the
 * File Control Record's count, a decompressed record its dictionary length,
 * and any pointer must land inside the file. A file that breaks a rule is
 * refused, never partly read.
 */
import { promises as fs } from 'fs';
import { basename } from 'path';

export type BtrieveFailure =
  | 'MIGRATION_PTB_UNREADABLE'
  | 'MIGRATION_PTB_UNSUPPORTED';

export class BtrieveError extends Error {
  constructor(
    readonly code: BtrieveFailure,
    message: string,
  ) {
    super(message);
    this.name = 'BtrieveError';
  }
}

export interface BtrieveInfo {
  pageSize: number;
  keyCount: number;
  /** Fixed record length in a plain file; 0 in a compressed one. */
  recordLength: number;
  /** Bytes per data-page slot. */
  slotLength: number;
  recordCount: number;
  compressed: boolean;
  /** The FCR's usage count: every write the file has seen. */
  usage: number;
}

interface PageRef {
  physical: number;
  type: number;
  usage: number;
}

const TYPE_DATA = 0x44; // 'D'
const TYPE_VARIABLE = 0x56; // 'V'
/** Bytes ahead of the first slot on a data page. */
const DATA_HEADER = 6;
/** Bytes ahead of the first fragment on a variable page. */
const VARIABLE_HEADER = 12;
/** Pages scanned per read while building the page map. */
const SCAN_PAGES = 256;
/** Variable pages kept in memory. */
const V_CACHE = 2048;
/** The largest record Btrieve allows is 64 KB; anything larger is damage. */
const MAX_RECORD = 65536 * 4;

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
/** [high][type][low][mid] → page number. */
const headerPage = (b: Buffer, o = 0) =>
  (b[o] << 16) | (b[o + 3] << 8) | b[o + 2];
/** [high][low][mid][fragment] → page number. */
const pointerPage = (b: Buffer, o = 0) =>
  (b[o] << 16) | (b[o + 2] << 8) | b[o + 1];

export class BtrieveFile {
  private pages: Map<number, PageRef> | null = null;
  private readonly vCache = new Map<number, Buffer>();

  private constructor(
    private readonly fh: fs.FileHandle,
    readonly name: string,
    readonly info: BtrieveInfo,
    private readonly fileSize: number,
  ) {}

  static async open(path: string, name = basename(path)): Promise<BtrieveFile> {
    const fh = await fs.open(path, 'r');
    try {
      const { size } = await fh.stat();
      const head = Buffer.alloc(512);
      await fh.read(head, 0, 512, 0);
      if (size < 1024 || head.toString('latin1', 0, 2) !== 'FC') {
        throw new BtrieveError(
          'MIGRATION_PTB_UNSUPPORTED',
          `${name} is not a Btrieve 6.x file.`,
        );
      }
      const pageSize = u16(head, 8);
      if (pageSize < 512 || pageSize % 512 !== 0 || size % pageSize !== 0) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${name} has an impossible page size (${pageSize}).`,
        );
      }
      const copies: Buffer[] = [];
      for (const p of [0, 1]) {
        const b = Buffer.alloc(pageSize);
        await fh.read(b, 0, pageSize, p * pageSize);
        if (b.toString('latin1', 0, 2) === 'FC') copies.push(b);
      }
      const fcr = copies.reduce((a, b) => (u32(b, 4) > u32(a, 4) ? b : a));
      const flags = u16(fcr, 0x106);
      if (u16(fcr, 0x0a) !== 0 || flags & 0x0800) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNSUPPORTED',
          `${name} uses a Btrieve feature this reader does not support (flags ${flags.toString(16)}).`,
        );
      }
      const compressed = (flags & 0x08) !== 0;
      if (!compressed && ((flags & 0x01) !== 0 || fcr[0x38] !== 0)) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNSUPPORTED',
          `${name} has variable-length records, which this reader does not support.`,
        );
      }
      const info: BtrieveInfo = {
        pageSize,
        keyCount: u16(fcr, 0x14),
        recordLength: u16(fcr, 0x16),
        slotLength: u16(fcr, 0x18),
        recordCount: u16(fcr, 0x1a) * 65536 + u16(fcr, 0x1c),
        compressed,
        usage: u32(fcr, 4),
      };
      const minSlot = compressed ? 7 : info.recordLength + 2;
      if (
        info.slotLength < minSlot ||
        info.slotLength > pageSize - DATA_HEADER ||
        (!compressed && info.recordLength === 0)
      ) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${name} has an impossible record layout (record ${info.recordLength}, slot ${info.slotLength}).`,
        );
      }
      return new BtrieveFile(fh, name, info, size);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  private get pageCount(): number {
    return this.fileSize / this.info.pageSize;
  }

  private async readPage(physical: number): Promise<Buffer> {
    if (physical < 0 || physical >= this.pageCount) {
      throw new BtrieveError(
        'MIGRATION_PTB_UNREADABLE',
        `${this.name} points past its end (page ${physical}).`,
      );
    }
    const b = Buffer.alloc(this.info.pageSize);
    await this.fh.read(b, 0, b.length, physical * this.info.pageSize);
    return b;
  }

  /**
   * The current physical page of every allocated data and variable page, from
   * the current PAT copies, each pointer corrected for its region's drift and
   * confirmed by the page's own header.
   */
  private async pageMap(): Promise<Map<number, PageRef>> {
    if (this.pages) return this.pages;
    const ps = this.info.pageSize;
    const unreadable = (m: string) =>
      new BtrieveError('MIGRATION_PTB_UNREADABLE', `${this.name}: ${m}`);
    // Find every PAT page: their positions give each region's drift.
    const pats = new Map<number, Array<{ at: number; page: Buffer }>>();
    const chunk = Buffer.alloc(ps * SCAN_PAGES);
    for (let first = 2; first < this.pageCount; first += SCAN_PAGES) {
      const count = Math.min(SCAN_PAGES, this.pageCount - first);
      await this.fh.read(chunk, 0, count * ps, first * ps);
      for (let i = 0; i < count; i++) {
        const o = i * ps;
        if (chunk[o] !== 0x50 || chunk[o + 1] !== 0x50) continue;
        const seq = u16(chunk, o + 2);
        const list = pats.get(seq) ?? [];
        list.push({
          at: first + i,
          page: Buffer.from(chunk.subarray(o, o + ps)),
        });
        pats.set(seq, list);
      }
    }
    const seqs = [...pats.keys()].sort((a, b) => a - b);
    if (!seqs.length) throw unreadable('it has no page allocation table.');
    const region = ps / 4;
    const drift: number[] = [];
    seqs.forEach((seq, r) => {
      const copies = pats.get(seq)!;
      if (seq !== r + 1)
        throw unreadable(`page allocation table ${r + 1} is missing.`);
      if (copies.length !== 2 || copies[1].at !== copies[0].at + 1) {
        throw unreadable(
          `page allocation table ${seq} is not a single pair of pages.`,
        );
      }
      drift.push(copies[0].at - (2 + r * region));
    });
    const toFilePage = (physical: number) => {
      if (physical < 2) return physical;
      const r = Math.min(Math.floor((physical - 2) / region), drift.length - 1);
      return physical + drift[r];
    };
    const perPat = (ps - 8) / 4;
    const pages = new Map<number, PageRef>();
    const header = Buffer.alloc(6);
    for (const seq of seqs) {
      const [a, b] = pats.get(seq)!;
      const current = u32(b.page, 4) > u32(a.page, 4) ? b.page : a.page;
      for (let slot = 0; slot < perPat; slot++) {
        const e = 8 + slot * 4;
        const type = current[e + 1];
        if (type !== TYPE_DATA && type !== TYPE_VARIABLE) continue;
        const logical = (seq - 1) * perPat + slot + 1;
        const physical = toFilePage(headerPage(current, e));
        if (physical < 2 || physical >= this.pageCount) {
          throw unreadable(
            `logical page ${logical} points past the end of the file.`,
          );
        }
        await this.fh.read(header, 0, 6, physical * ps);
        if (header[1] !== type || headerPage(header) !== logical) {
          throw unreadable(
            `logical page ${logical} points at a page holding logical page ${headerPage(header)}.`,
          );
        }
        pages.set(logical, { physical, type, usage: u16(header, 4) & 0x7fff });
      }
    }
    this.pages = pages;
    return pages;
  }

  private async variablePage(logical: number): Promise<Buffer> {
    const cached = this.vCache.get(logical);
    if (cached) return cached;
    const ref = (await this.pageMap()).get(logical);
    if (!ref || ref.type !== TYPE_VARIABLE) {
      throw new BtrieveError(
        'MIGRATION_PTB_UNREADABLE',
        `${this.name}: a record points at page ${logical}, which holds no record data.`,
      );
    }
    const page = await this.readPage(ref.physical);
    if (this.vCache.size >= V_CACHE) {
      this.vCache.delete(this.vCache.keys().next().value as number);
    }
    this.vCache.set(logical, page);
    return page;
  }

  /** The bytes of one record's fragment chain, pointers removed. */
  private async chain(pointer: Buffer): Promise<Buffer> {
    const ps = this.info.pageSize;
    const parts: Buffer[] = [];
    let page = pointerPage(pointer);
    let fragment = pointer[3];
    let total = 0;
    for (let hops = 0; fragment !== 0xff; hops++) {
      if (hops > this.pageCount) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${this.name}: a record's fragments loop.`,
        );
      }
      const v = await this.variablePage(page);
      const entry = (n: number) => ps - 2 - 2 * n;
      if (entry(fragment) < VARIABLE_HEADER) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${this.name}: fragment ${fragment} on page ${page} does not exist.`,
        );
      }
      const raw = u16(v, entry(fragment));
      if (raw === 0xffff) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${this.name}: a record points at deleted fragment ${fragment} on page ${page}.`,
        );
      }
      const start = raw & 0x7fff;
      let next = fragment + 1;
      while (entry(next) >= VARIABLE_HEADER && u16(v, entry(next)) === 0xffff)
        next++;
      if (entry(next) < VARIABLE_HEADER) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${this.name}: fragment ${fragment} on page ${page} has no end.`,
        );
      }
      const end = u16(v, entry(next)) & 0x7fff;
      if (start < VARIABLE_HEADER || end < start + 4 || end > entry(next)) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${this.name}: fragment ${fragment} on page ${page} is out of bounds.`,
        );
      }
      const body = v.subarray(start + 4, end);
      total += body.length;
      if (total > MAX_RECORD) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          `${this.name}: a record is impossibly large.`,
        );
      }
      parts.push(body);
      page = pointerPage(v, start);
      fragment = v[start + 3];
    }
    return Buffer.concat(parts, total);
  }

  /**
   * Every record, in logical page order. `expectedLength` (the dictionary's
   * record length) is checked for each; the count is checked at the end.
   */
  async *records(expectedLength?: number): AsyncGenerator<Buffer> {
    const { pageSize, slotLength, compressed, recordLength } = this.info;
    const pages = await this.pageMap();
    const data = [...pages.entries()]
      .filter(([, ref]) => ref.type === TYPE_DATA)
      .sort(([a], [b]) => a - b);
    const slots = Math.floor((pageSize - DATA_HEADER) / slotLength);
    let count = 0;
    for (const [, ref] of data) {
      const page = await this.readPage(ref.physical);
      for (let s = 0; s < slots; s++) {
        const o = DATA_HEADER + s * slotLength;
        let record: Buffer;
        if (compressed) {
          if (page[o + 4] !== 0x01) continue;
          record = decompress(await this.chain(page.subarray(o, o + 4)));
        } else {
          if (page[o] === 0 && page[o + 1] === 0) continue;
          record = Buffer.from(page.subarray(o + 2, o + 2 + recordLength));
        }
        if (expectedLength !== undefined && record.length !== expectedLength) {
          throw new BtrieveError(
            'MIGRATION_PTB_UNREADABLE',
            `${this.name}: a record is ${record.length} bytes; its table defines ${expectedLength}.`,
          );
        }
        count++;
        yield record;
      }
    }
    if (count !== this.info.recordCount) {
      throw new BtrieveError(
        'MIGRATION_PTB_UNREADABLE',
        `${this.name}: ${count} records read, but the file holds ${this.info.recordCount}.`,
      );
    }
  }
}

/** Btrieve record compression: alternating literal and run tokens. */
export function decompress(stream: Buffer): Buffer {
  const parts: Buffer[] = [];
  let length = 0;
  let i = 0;
  let literal = true;
  while (i < stream.length) {
    if (i + 2 > stream.length) {
      throw new BtrieveError(
        'MIGRATION_PTB_UNREADABLE',
        'A compressed record ends inside a token.',
      );
    }
    const n = u16(stream, i);
    i += 2;
    if (literal) {
      if (i + n > stream.length) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          'A compressed record ends inside a literal.',
        );
      }
      parts.push(stream.subarray(i, i + n));
      i += n;
    } else {
      if (i >= stream.length) {
        throw new BtrieveError(
          'MIGRATION_PTB_UNREADABLE',
          'A compressed record ends inside a run.',
        );
      }
      parts.push(Buffer.alloc(n, stream[i]));
      i += 1;
    }
    length += n;
    if (length > MAX_RECORD) {
      throw new BtrieveError(
        'MIGRATION_PTB_UNREADABLE',
        'A compressed record expands impossibly far.',
      );
    }
    literal = !literal;
  }
  return Buffer.concat(parts, length);
}
