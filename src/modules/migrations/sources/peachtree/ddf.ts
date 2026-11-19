/**
 * The Pervasive data dictionary a Peachtree company carries (FILE.DDF,
 * FIELD.DDF): which table lives in which file, and where each field sits in a
 * record. Every other table is read through it, so no record layout is
 * guessed. The two dictionary files are themselves plain Btrieve files with
 * layouts fixed by Pervasive:
 *
 *   X$File  (97 bytes)  Xf$Id u16 · Xf$Name char(20) · Xf$Loc char(64) · …
 *   X$Field (32 bytes)  Xe$Id u16 · Xe$File u16 · Xe$Name char(20) ·
 *                       Xe$DataType u8 · Xe$Offset u16 · Xe$Size u16 ·
 *                       Xe$Dec u8 · Xe$Flags u16
 */
import { BtrieveError, BtrieveFile } from './btrieve';
import { FieldDef } from './field-types';

export interface TableDef {
  id: number;
  name: string;
  /** The file, as the dictionary names it (e.g. `Chart.DAT`). */
  file: string;
  fields: Map<string, FieldDef>;
  /** End of the last field: the length every record must have. */
  recordLength: number;
}

/** Pseudo-fields that name an index carry type 255 and no bytes. */
const INDEX_NAME_TYPE = 255;

const name = (b: Buffer, o: number, n: number) =>
  b.toString('latin1', o, o + n).replace(/[\s\0]+$/, '');

export async function readDictionary(
  filePath: string,
  fieldPath: string,
): Promise<Map<string, TableDef>> {
  const tables = new Map<number, TableDef>();
  const files = await BtrieveFile.open(filePath, 'FILE.DDF');
  try {
    if (files.info.recordLength !== 97) {
      throw new BtrieveError(
        'MIGRATION_PTB_UNSUPPORTED',
        `FILE.DDF records are ${files.info.recordLength} bytes; expected 97.`,
      );
    }
    for await (const r of files.records()) {
      const id = r.readUInt16LE(0);
      const loc = r.subarray(22, 86);
      const file = name(loc, 0, loc.indexOf(0) < 0 ? 64 : loc.indexOf(0))
        .replace(/^\.[\\/]/, '')
        .trim();
      tables.set(id, {
        id,
        name: name(r, 2, 20),
        file,
        fields: new Map(),
        recordLength: 0,
      });
    }
  } finally {
    await files.close();
  }
  const fields = await BtrieveFile.open(fieldPath, 'FIELD.DDF');
  try {
    if (fields.info.recordLength !== 32) {
      throw new BtrieveError(
        'MIGRATION_PTB_UNSUPPORTED',
        `FIELD.DDF records are ${fields.info.recordLength} bytes; expected 32.`,
      );
    }
    for await (const r of fields.records()) {
      const table = tables.get(r.readUInt16LE(2));
      const type = r[24];
      if (!table || type === INDEX_NAME_TYPE) continue;
      const f: FieldDef = {
        name: name(r, 4, 20),
        type,
        offset: r.readUInt16LE(25),
        size: r.readUInt16LE(27),
        decimals: r[29],
      };
      table.fields.set(f.name.toLowerCase(), f);
      table.recordLength = Math.max(table.recordLength, f.offset + f.size);
    }
  } finally {
    await fields.close();
  }
  return new Map([...tables.values()].map((t) => [t.name.toLowerCase(), t]));
}
