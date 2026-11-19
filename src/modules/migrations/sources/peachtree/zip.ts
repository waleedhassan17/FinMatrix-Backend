/**
 * Reading a Peachtree backup (.ptb), which is a ZIP of the company folder.
 *
 * The archive is streamed from disk entry by entry (yauzl): nothing is held
 * in memory whole, whatever the backup's size. Only top-level table files are
 * extracted, each checked against the archive's own CRC-32 as it is written,
 * so a backup damaged in upload or storage is refused rather than read wrong.
 * Encrypted entries, path tricks and zip bombs are refused up front.
 */
import { createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import * as yauzl from 'yauzl';
import { BtrieveError } from './btrieve';

export interface ZipLimits {
  maxEntries: number;
  /** Sum of the entries' uncompressed sizes. */
  maxUncompressed: number;
  /** Per entry, uncompressed ÷ compressed… */
  maxRatio: number;
  /**
   * …for entries that unpack to more than this. A small, nearly empty table
   * compresses far beyond any sensible ratio and is harmless; the size of
   * what is unpacked is bounded by maxUncompressed and the free-disk check.
   */
  ratioFrom: number;
  /** What to tell the owner when an entry is password-protected. */
  lockedMessage?: string;
}

/** A Peachtree company folder: tens of files, a few GB at the very most. */
export const PTB_ZIP_LIMITS: ZipLimits = {
  maxEntries: 500,
  maxUncompressed: 10 * 1024 ** 3,
  maxRatio: 200,
  ratioFrom: 64 * 1024 ** 2,
};

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface OpenedArchive {
  comment: string;
  entries: ZipEntryInfo[];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(chunk: Buffer, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < chunk.length; i++)
    c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const unreadable = (message: string) =>
  new BtrieveError('MIGRATION_PTB_UNREADABLE', message);

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: false,
      },
      (err, zip) =>
        err || !zip
          ? reject(
              unreadable(
                `The backup is not a readable ZIP archive (${err?.message ?? 'no archive'}).`,
              ),
            )
          : resolve(zip),
    ),
  );
}

/** Every entry, after the archive-wide guards. */
async function scan(
  zip: yauzl.ZipFile,
  limits: ZipLimits,
): Promise<yauzl.Entry[]> {
  if (zip.entryCount > limits.maxEntries) {
    throw unreadable(
      `The ZIP holds ${zip.entryCount.toLocaleString()} files; FinMatrix reads at most ${limits.maxEntries}. A backup or export of one company has far fewer — check it is the right file.`,
    );
  }
  const entries: yauzl.Entry[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (e: yauzl.Entry) => {
      if (e.generalPurposeBitFlag & 0x1) {
        reject(
          new BtrieveError(
            'MIGRATION_PTB_UNSUPPORTED',
            limits.lockedMessage ?? 'The backup is password-protected. Make the backup again without a password.',
          ),
        );
        return;
      }
      total += e.uncompressedSize;
      if (total > limits.maxUncompressed) {
        reject(
          unreadable(`The ZIP unpacks to more than ${Math.round(limits.maxUncompressed / 1024 ** 3)} GB, more than FinMatrix will read.`),
        );
        return;
      }
      if (
        e.uncompressedSize > limits.ratioFrom &&
        e.uncompressedSize > e.compressedSize * limits.maxRatio
      ) {
        reject(
          unreadable(
            `${e.fileName} expands implausibly; the backup is damaged.`,
          ),
        );
        return;
      }
      entries.push(e);
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', (err: Error) =>
      reject(unreadable(`The backup is damaged (${err.message}).`)),
    );
    zip.readEntry();
  });
  return entries;
}

/** A top-level file name, or null for folders and anything path-like. */
function topLevel(fileName: string): string | null {
  if (!fileName || /[\\/]/.test(fileName) || fileName.includes('..'))
    return null;
  return fileName;
}

export async function inspectArchive(
  path: string,
  limits: ZipLimits = PTB_ZIP_LIMITS,
): Promise<OpenedArchive> {
  const zip = await openZip(path);
  try {
    const entries = await scan(zip, limits);
    return {
      comment: (zip.comment ?? '').toString(),
      entries: entries.map((e) => ({
        name: e.fileName,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
      })),
    };
  } finally {
    zip.close();
  }
}

/**
 * Extract the named top-level files (matched case-insensitively) into
 * `destDir`, verifying each one's CRC-32. Returns upper-cased name → path.
 */
export async function extractTables(
  path: string,
  wanted: ReadonlySet<string>,
  destDir: string,
  limits: ZipLimits = PTB_ZIP_LIMITS,
  onProgress?: (bytes: number) => void,
): Promise<Map<string, string>> {
  const zip = await openZip(path);
  const out = new Map<string, string>();
  try {
    const entries = await scan(zip, limits);
    let done = 0;
    for (const e of entries) {
      const name = topLevel(e.fileName);
      const key = name?.toUpperCase();
      if (!name || !key || !wanted.has(key) || out.has(key)) continue;
      const target = join(destDir, key);
      const stream = await new Promise<NodeJS.ReadableStream>(
        (resolve, reject) =>
          zip.openReadStream(e, (err, s) =>
            err || !s
              ? reject(
                  unreadable(`${name} could not be read (${err?.message}).`),
                )
              : resolve(s),
          ),
      );
      let crc = 0;
      const check = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          crc = crc32(chunk, crc);
          done += chunk.length;
          onProgress?.(done);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(stream, check, createWriteStream(target));
      } catch (err) {
        throw unreadable(
          `${name} is damaged inside the backup (${(err as Error).message}).`,
        );
      }
      if (crc !== e.crc32 >>> 0) {
        throw unreadable(
          `${name} does not match its checksum; the backup is damaged.`,
        );
      }
      out.set(key, target);
    }
    return out;
  } finally {
    zip.close();
  }
}

/**
 * Every top-level-or-nested file entry of an archive, one at a time, as a
 * stream the caller must consume or destroy before the next is offered.
 * The archive-wide guards (entry count, unpacked size, ratio, encryption)
 * apply as for a Peachtree backup.
 */
export async function forEachEntry(
  path: string,
  visit: (
    entry: { name: string; size: number },
    open: () => Promise<NodeJS.ReadableStream>,
  ) => Promise<void>,
  limits: ZipLimits = PTB_ZIP_LIMITS,
): Promise<void> {
  const zip = await openZip(path);
  try {
    const entries = await scan(zip, limits);
    for (const e of entries) {
      if (e.fileName.endsWith('/') || e.fileName.includes('..')) continue;
      await visit({ name: e.fileName, size: e.uncompressedSize }, () =>
        new Promise<NodeJS.ReadableStream>((resolve, reject) =>
          zip.openReadStream(e, (err, s) =>
            err || !s ? reject(unreadable(`${e.fileName} could not be read (${err?.message}).`)) : resolve(s),
          ),
        ),
      );
    }
  } finally {
    zip.close();
  }
}
