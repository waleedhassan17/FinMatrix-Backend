import AdmZip from 'adm-zip';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { crc32, extractTables, inspectArchive, PTB_ZIP_LIMITS } from './zip';

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptb-zip-spec-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function archive(
  entries: Record<string, Buffer>,
  comment = 'PAW15.02',
): string {
  const z = new AdmZip();
  for (const [name, data] of Object.entries(entries)) z.addFile(name, data);
  z.addZipComment(comment);
  const p = join(dir, `a${n++}.ptb`);
  writeFileSync(p, z.toBuffer());
  return p;
}

const out = () => {
  const d = join(dir, `out${n++}`);
  mkdirSync(d);
  return d;
};

describe('crc32', () => {
  it('matches the standard check value, also when fed in pieces', () => {
    const data = Buffer.from('123456789');
    expect(crc32(data)).toBe(0xcbf43926);
    expect(crc32(data.subarray(4), crc32(data.subarray(0, 4)))).toBe(
      0xcbf43926,
    );
  });
});

describe('inspectArchive / extractTables', () => {
  it('lists the archive and extracts only the wanted top-level tables, case-insensitively', async () => {
    const p = archive({
      'Chart.DAT': Buffer.from('chart bytes'),
      'CUSTOMER.DAT': Buffer.from('customer bytes'),
      'Other.DAT': Buffer.from('not wanted'),
      'sub/CHART.DAT': Buffer.from('nested'),
    });
    const info = await inspectArchive(p);
    expect(info.comment).toBe('PAW15.02');
    expect(info.entries.map((e) => e.name).sort()).toEqual([
      'CUSTOMER.DAT',
      'Chart.DAT',
      'Other.DAT',
      'sub/CHART.DAT',
    ]);
    const dest = out();
    const got = await extractTables(
      p,
      new Set(['CHART.DAT', 'CUSTOMER.DAT', 'JRNLROW.DAT']),
      dest,
    );
    expect([...got.keys()].sort()).toEqual(['CHART.DAT', 'CUSTOMER.DAT']);
    expect(readFileSync(got.get('CHART.DAT')!, 'utf8')).toBe('chart bytes');
    expect(existsSync(join(dest, 'OTHER.DAT'))).toBe(false);
  });

  it('reports progress as it extracts', async () => {
    const p = archive({ 'CHART.DAT': Buffer.alloc(100_000, 7) });
    let last = 0;
    await extractTables(
      p,
      new Set(['CHART.DAT']),
      out(),
      PTB_ZIP_LIMITS,
      (b) => (last = b),
    );
    expect(last).toBe(100_000);
  });

  it('refuses a damaged table (CRC-32 or sizes disagree)', async () => {
    const z = new AdmZip();
    const payload = Buffer.from(
      'x'.repeat(10) +
        'a unique payload that is not compressible: 9f8e7d6c5b4a',
    );
    z.addFile('CHART.DAT', payload);
    const buf = z.toBuffer();
    // Flip a byte inside the stored data.
    const at = buf.indexOf(Buffer.from('9f8e7d6c'));
    const bad = Buffer.from(buf);
    if (at >= 0) bad[at] ^= 0xff;
    else bad[60] ^= 0xff;
    const p = join(dir, `bad${n++}.ptb`);
    writeFileSync(p, bad);
    await expect(
      extractTables(p, new Set(['CHART.DAT']), out()),
    ).rejects.toMatchObject({
      code: 'MIGRATION_PTB_UNREADABLE',
    });
  });

  it('refuses something that is not a ZIP at all', async () => {
    const p = join(dir, `junk${n++}.ptb`);
    writeFileSync(p, Buffer.alloc(5000, 0x41));
    await expect(inspectArchive(p)).rejects.toMatchObject({
      code: 'MIGRATION_PTB_UNREADABLE',
    });
  });

  it('refuses too many entries, too much unpacked, or a zip bomb', async () => {
    const many = archive(
      Object.fromEntries(
        [...Array(6)].map((_, i) => [`F${i}.DAT`, Buffer.from('x')]),
      ),
    );
    await expect(
      inspectArchive(many, { ...PTB_ZIP_LIMITS, maxEntries: 5 }),
    ).rejects.toThrow(/holds 6 files/);
    const big = archive({
      'A.DAT': Buffer.from('a'.repeat(1000)),
      'B.DAT': Buffer.from('b'.repeat(1000)),
    });
    await expect(
      inspectArchive(big, { ...PTB_ZIP_LIMITS, maxUncompressed: 1500 }),
    ).rejects.toThrow(/more than FinMatrix will read/);
    const bomb = archive({ 'JRNLROW.DAT': Buffer.alloc(4 * 1024 * 1024) });
    await expect(
      inspectArchive(bomb, { ...PTB_ZIP_LIMITS, ratioFrom: 1024 * 1024 }),
    ).rejects.toThrow(/expands implausibly/);
    // The same ratio in a small table (a nearly empty one) is harmless.
    await expect(
      inspectArchive(bomb, { ...PTB_ZIP_LIMITS, ratioFrom: 8 * 1024 * 1024 }),
    ).resolves.toBeTruthy();
  });

  it('refuses a password-protected backup', async () => {
    const p = archive({ 'CHART.DAT': Buffer.from('secret') });
    const buf = readFileSync(p);
    // Set the "encrypted" bit in the local and central headers.
    for (const sig of [
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    ]) {
      const at = buf.indexOf(sig);
      const flagAt = at + (sig[2] === 0x03 ? 6 : 8);
      buf[flagAt] |= 0x01;
    }
    writeFileSync(p, buf);
    await expect(inspectArchive(p)).rejects.toMatchObject({
      code: 'MIGRATION_PTB_UNSUPPORTED',
    });
  });
});
