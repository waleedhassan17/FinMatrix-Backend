/**
 * A test-only Btrieve 6.x writer: builds the files the reader in
 * src/modules/migrations/sources/peachtree/btrieve.ts reads, with the traps a
 * real Peachtree file has — two File Control Record copies, Page Allocation
 * Table pairs whose current copy must be chosen, regions shifted from their
 * nominal place (drift), stale shadow copies of pages, free slots, compressed
 * records split into fragment chains across variable pages, and deleted
 * fragments in the offset table.
 *
 * It writes only what the reader relies on; it is not a Btrieve
 * implementation. Never used outside tests.
 */

export interface WriterOptions {
  /** Page size; 512 keeps regions small enough to test several. */
  pageSize?: number;
  /** Plain: every record's length. Compressed: ignored (records vary). */
  recordLength: number;
  records: Buffer[];
  compressed?: boolean;
  keyCount?: number;
  /** Free slots placed ahead of record i. */
  freeBefore?: ReadonlySet<number>;
  /** Junk pages ahead of each region's PAT pair; must not decrease. */
  drift?: number[];
  /** The FCR's record count, when it should disagree with the records. */
  recordCount?: number;
  /** Compressed stream bytes per fragment. */
  fragmentBytes?: number;
  /** Write a stale copy of every data page, which an old PAT copy points at. */
  shadows?: boolean;
  /** FCR flags (0x106); defaults from `compressed`. */
  flags?: number;
}

export interface WrittenFile {
  buffer: Buffer;
  pageSize: number;
  /** Physical page of each region's current PAT copy. */
  currentPat: number[];
  /** Logical → physical, for every data and variable page. */
  physical: Map<number, number>;
  dataPages: number[];
  variablePages: number[];
}

const TYPE_DATA = 0x44;
const TYPE_VARIABLE = 0x56;
const DATA_HEADER = 6;
const VARIABLE_HEADER = 12;

/** Btrieve record compression: alternating literal / run tokens, literal first. */
export function compress(record: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  let literalStart = 0;
  const token = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  while (i <= record.length) {
    let run = 1;
    while (
      i + run < record.length &&
      record[i + run] === record[i] &&
      run < 0xffff
    )
      run++;
    if (i === record.length || run >= 4) {
      out.push(token(i - literalStart), record.subarray(literalStart, i));
      if (i === record.length) break;
      out.push(token(run), Buffer.from([record[i]]));
      i += run;
      literalStart = i;
      if (i === record.length) break;
    } else {
      i++;
    }
  }
  return Buffer.concat(out);
}

function pageHeader(
  page: Buffer,
  logical: number,
  type: number,
  usage: number,
) {
  page[0] = (logical >> 16) & 0xff;
  page[1] = type;
  page[2] = logical & 0xff;
  page[3] = (logical >> 8) & 0xff;
  page.writeUInt16LE(usage & 0x7fff, 4);
}

function pointer(b: Buffer, o: number, logical: number, fragment: number) {
  b[o] = (logical >> 16) & 0xff;
  b[o + 1] = logical & 0xff;
  b[o + 2] = (logical >> 8) & 0xff;
  b[o + 3] = fragment;
}

export function writeBtrieve(opts: WriterOptions): WrittenFile {
  const ps = opts.pageSize ?? 512;
  const region = ps / 4;
  const perPat = (ps - 8) / 4;
  const compressed = !!opts.compressed;
  const keyCount = opts.keyCount ?? 1;
  const slotLength = compressed
    ? 7 + 4 * keyCount
    : opts.recordLength + 2 + 4 * keyCount;
  const slots = Math.floor((ps - DATA_HEADER) / slotLength);

  // Data pages: records into slots, free slots where asked.
  type DataSlot = { free: true } | { free: false; index: number };
  const dataSlots: DataSlot[] = [];
  opts.records.forEach((_, i) => {
    if (opts.freeBefore?.has(i)) dataSlots.push({ free: true });
    dataSlots.push({ free: false, index: i });
  });
  const dataPageCount = Math.max(1, Math.ceil(dataSlots.length / slots));

  // Compressed: every record's stream, split into fragments, packed onto
  // variable pages (a deleted entry after the first fragment of each page).
  const fragBytes = opts.fragmentBytes ?? 48;
  type Frag = { record: number; body: Buffer; page: number; index: number };
  const frags: Frag[] = [];
  const vPages: Array<{ frags: Frag[]; used: number; entries: number }> = [];
  const firstFrag = new Map<number, Frag>();
  const nextFrag = new Map<Frag, Frag | null>();
  if (compressed) {
    let current = { frags: [] as Frag[], used: VARIABLE_HEADER, entries: 0 };
    vPages.push(current);
    opts.records.forEach((rec, r) => {
      const stream = compress(rec);
      const pieces: Buffer[] = [];
      for (let o = 0; o < stream.length; o += fragBytes)
        pieces.push(stream.subarray(o, o + fragBytes));
      if (!pieces.length) pieces.push(Buffer.alloc(0));
      let prev: Frag | null = null;
      for (const body of pieces) {
        // fragment bytes + its entry + (maybe) a deleted entry + the end entry
        const need = 4 + body.length;
        const tableAfter = (current.entries + 3) * 2;
        if (current.used + need > ps - tableAfter) {
          current = { frags: [], used: VARIABLE_HEADER, entries: 0 };
          vPages.push(current);
        }
        const index =
          current.entries === 1 ? current.entries + 1 : current.entries;
        const f: Frag = { record: r, body, page: vPages.length - 1, index };
        current.entries = index + 1;
        current.used += need;
        current.frags.push(f);
        frags.push(f);
        if (prev) nextFrag.set(prev, f);
        else firstFrag.set(r, f);
        prev = f;
      }
      if (prev) nextFrag.set(prev, null);
    });
  }

  // Logical pages: data first, then variable.
  const logicalCount = dataPageCount + vPages.length;
  const dataLogical = (p: number) => p + 1;
  const varLogical = (p: number) => dataPageCount + p + 1;
  const regions = Math.max(1, Math.ceil(logicalCount / perPat));
  const drift = opts.drift ?? [];
  const driftOf = (r: number) => drift[Math.min(r, drift.length - 1)] ?? 0;
  for (let r = 1; r < regions; r++) {
    if (driftOf(r) < driftOf(r - 1)) throw new Error('drift must not decrease');
  }

  // Physical layout: each region's PAT pair at nominal + drift, its logical
  // pages right after; shadows at the end of the file.
  const physical = new Map<number, number>();
  const patAt: number[] = [];
  let maxPage = 1;
  for (let r = 0; r < regions; r++) {
    const at = 2 + r * region + driftOf(r);
    patAt.push(at);
    let p = at + 2;
    for (let s = 0; s < perPat; s++) {
      const logical = r * perPat + s + 1;
      if (logical > logicalCount) break;
      physical.set(logical, p++);
    }
    maxPage = Math.max(maxPage, p - 1);
    if (r + 1 < regions && p > 2 + (r + 1) * region + driftOf(r + 1)) {
      throw new Error('region overflow');
    }
  }
  const shadowAt = new Map<number, number>();
  if (opts.shadows) {
    for (let p = 0; p < dataPageCount; p++)
      shadowAt.set(dataLogical(p), ++maxPage);
  }
  const pageCount = maxPage + 1;
  const buf = Buffer.alloc(pageCount * ps);
  const page = (n: number) => buf.subarray(n * ps, (n + 1) * ps);

  // Junk where drift leaves gaps: anything but 'PP'.
  for (let n = 2; n < pageCount; n++) page(n).fill(0xee);

  // FCR copies: page 1 current, page 0 stale with a wrong count.
  const count = opts.recordCount ?? opts.records.length;
  const flags = opts.flags ?? (compressed ? 0x08 : 0);
  for (const [n, usage, cnt] of [
    [0, 3, count + 17],
    [1, 9, count],
  ] as const) {
    const f = page(n);
    f.fill(0);
    f.write('FC', 0, 'latin1');
    f.writeUInt32LE(usage, 4);
    f.writeUInt16LE(ps, 8);
    f.writeUInt16LE(keyCount, 0x14);
    f.writeUInt16LE(compressed ? 0 : opts.recordLength, 0x16);
    f.writeUInt16LE(slotLength, 0x18);
    f.writeUInt16LE(Math.floor(cnt / 65536), 0x1a);
    f.writeUInt16LE(cnt % 65536, 0x1c);
    f.writeUInt16LE(flags, 0x106);
  }

  // Data pages (and their stale shadows, holding other records).
  let slotIndex = 0;
  for (let p = 0; p < dataPageCount; p++) {
    const logical = dataLogical(p);
    const pg = page(physical.get(logical)!);
    pg.fill(0);
    pageHeader(pg, logical, TYPE_DATA, 0x7fff + 3); // wraps: usage is useless
    for (let s = 0; s < slots; s++, slotIndex++) {
      const o = DATA_HEADER + s * slotLength;
      const d = dataSlots[slotIndex];
      if (!d) continue;
      if (d.free) {
        pg.fill(0x5a, o + 5, o + slotLength); // garbage behind a free mark
        if (compressed) pg[o + 4] = 0;
        else pg.writeUInt16LE(0, o);
        continue;
      }
      if (compressed) {
        const f = firstFrag.get(d.index)!;
        pointer(pg, o, varLogical(f.page), f.index);
        pg[o + 4] = 0x01;
        pg.writeUInt16LE(1, o + 5);
      } else {
        pg.writeUInt16LE(1, o);
        opts.records[d.index].copy(pg, o + 2);
      }
    }
    const shadow = shadowAt.get(logical);
    if (shadow !== undefined) {
      const sp = page(shadow);
      pg.copy(sp);
      pageHeader(sp, logical, TYPE_DATA, 7);
      for (let s = 0; s < slots; s++) {
        const o = DATA_HEADER + s * slotLength;
        if (!compressed && sp.readUInt16LE(o) !== 0)
          sp.fill(0x21, o + 2, o + 2 + opts.recordLength);
      }
    }
  }

  // Variable pages: fragments up from the header, offset table down from
  // the end, a deleted entry at index 1, an end entry after the last.
  vPages.forEach((vp, p) => {
    const logical = varLogical(p);
    const pg = page(physical.get(logical)!);
    pg.fill(0);
    pageHeader(pg, logical, TYPE_VARIABLE, 1);
    const entry = (n: number) => ps - 2 - 2 * n;
    let at = VARIABLE_HEADER;
    for (let n = 0; n < vp.entries; n++) pg.writeUInt16LE(0xffff, entry(n));
    for (const f of vp.frags) {
      pg.writeUInt16LE(at, entry(f.index));
      const next = nextFrag.get(f);
      if (next) pointer(pg, at, varLogical(next.page), next.index);
      else pointer(pg, at, 0, 0xff);
      f.body.copy(pg, at + 4);
      at += 4 + f.body.length;
    }
    pg.writeUInt16LE(at, entry(vp.entries));
  });

  // PAT pairs: current and stale copy (alternating which comes first); the
  // stale copy points data pages at their shadows.
  const stored = (r: number, phys: number) => phys - driftOf(r);
  const currentPat: number[] = [];
  for (let r = 0; r < regions; r++) {
    const copies = [page(patAt[r]), page(patAt[r] + 1)];
    const currentIdx = r % 2;
    copies.forEach((pg, i) => {
      pg.fill(0);
      pg.write('PP', 0, 'latin1');
      pg.writeUInt16LE(r + 1, 2);
      pg.writeUInt32LE(i === currentIdx ? 50 + r : 10 + r, 4);
      for (let s = 0; s < perPat; s++) {
        const logical = r * perPat + s + 1;
        if (logical > logicalCount) break;
        const isData = logical <= dataPageCount;
        let phys = physical.get(logical)!;
        if (i !== currentIdx && shadowAt.has(logical))
          phys = shadowAt.get(logical)!;
        const e = 8 + s * 4;
        const st = stored(Math.min(r, regions - 1), phys);
        pg[e] = (st >> 16) & 0xff;
        pg[e + 1] = isData ? TYPE_DATA : TYPE_VARIABLE;
        pg[e + 2] = st & 0xff;
        pg[e + 3] = (st >> 8) & 0xff;
      }
    });
    currentPat.push(patAt[r] + currentIdx);
  }

  return {
    buffer: buf,
    pageSize: ps,
    currentPat,
    physical,
    dataPages: [...Array(dataPageCount)].map((_, p) => dataLogical(p)),
    variablePages: vPages.map((_, p) => varLogical(p)),
  };
}

/** Fixed-layout dictionary records (X$File 97 bytes, X$Field 32 bytes). */
export function fileRecord(id: number, name: string, location: string): Buffer {
  const r = Buffer.alloc(97);
  r.writeUInt16LE(id, 0);
  r.write(name.padEnd(20, ' '), 2, 20, 'latin1');
  r.write(location, 22, 64, 'latin1');
  return r;
}

export function fieldRecord(
  id: number,
  file: number,
  name: string,
  type: number,
  offset: number,
  size: number,
  decimals = 0,
): Buffer {
  const r = Buffer.alloc(32);
  r.writeUInt16LE(id, 0);
  r.writeUInt16LE(file, 2);
  r.write(name.padEnd(20, ' '), 4, 20, 'latin1');
  r[24] = type;
  r.writeUInt16LE(offset, 25);
  r.writeUInt16LE(size, 27);
  r[29] = decimals;
  return r;
}
