import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  fieldRecord,
  fileRecord,
  writeBtrieve,
} from '../../../../../test/fixtures/peachtree/btrieve-writer';
import { readDictionary } from './ddf';
import {
  btrieveDate,
  decodeField,
  exactAmount,
  FIELD_TYPE,
  FieldDef,
} from './field-types';

const f = (type: number, size: number, decimals = 0, offset = 0): FieldDef => ({
  name: 'F',
  type,
  offset,
  size,
  decimals,
});

describe('decodeField', () => {
  it('strings: fixed (space/NUL padded), zero-terminated, length-prefixed, Windows-1252', () => {
    expect(
      decodeField(Buffer.from('ABC   \0\0'), f(FIELD_TYPE.STRING, 8)),
    ).toBe('ABC');
    expect(decodeField(Buffer.from('AB\0junk'), f(FIELD_TYPE.ZSTRING, 7))).toBe(
      'AB',
    );
    expect(
      decodeField(
        Buffer.from([3, 0x41, 0x42, 0x43, 0x44]),
        f(FIELD_TYPE.LSTRING, 5),
      ),
    ).toBe('ABC');
    // A length byte larger than the field is clipped, never read past it.
    expect(
      decodeField(Buffer.from([200, 0x41, 0x42]), f(FIELD_TYPE.LSTRING, 3)),
    ).toBe('AB');
    expect(
      decodeField(Buffer.from([0x80, 0x20]), f(FIELD_TYPE.STRING, 2)),
    ).toBe('€');
  });

  it('integers, signed and unsigned, every width', () => {
    const b = Buffer.alloc(8);
    b.writeInt32LE(-123456);
    expect(decodeField(b, f(FIELD_TYPE.INTEGER, 4))).toBe(-123456);
    b.writeInt16LE(-2);
    expect(decodeField(b, f(FIELD_TYPE.INTEGER, 2))).toBe(-2);
    expect(decodeField(Buffer.from([0xff]), f(FIELD_TYPE.INTEGER, 1))).toBe(-1);
    expect(decodeField(Buffer.from([0xff]), f(FIELD_TYPE.UNSIGNED, 1))).toBe(
      255,
    );
    b.writeBigInt64LE(BigInt(9_000_000_000));
    expect(decodeField(b, f(FIELD_TYPE.AUTOINC, 8))).toBe(9_000_000_000);
  });

  it('floats', () => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(1234.56);
    expect(decodeField(b, f(FIELD_TYPE.FLOAT, 8))).toBe(1234.56);
    b.writeFloatLE(0.5);
    expect(decodeField(b, f(FIELD_TYPE.FLOAT, 4))).toBe(0.5);
  });

  it('dates and times; a blank date is null', () => {
    expect(
      decodeField(Buffer.from([5, 10, 0xea, 0x07]), f(FIELD_TYPE.DATE, 4)),
    ).toBe('2026-10-05');
    expect(
      decodeField(Buffer.from([0, 0, 0, 0]), f(FIELD_TYPE.DATE, 4)),
    ).toBeNull();
    expect(
      decodeField(Buffer.from([0, 9, 30, 14]), f(FIELD_TYPE.TIME, 4)),
    ).toBe('14:30:09');
  });

  it('refuses a date that does not exist', () => {
    expect(() => btrieveDate(Buffer.from([31, 2, 0xea, 0x07]), 0)).toThrow(
      RangeError,
    );
    expect(() => btrieveDate(Buffer.from([1, 13, 0xea, 0x07]), 0)).toThrow(
      RangeError,
    );
  });

  it('packed BCD money and decimals, with sign', () => {
    // 123.45 → digits 1 2 3 4 5, sign nibble C (plus)
    expect(
      decodeField(Buffer.from([0x12, 0x34, 0x5c]), f(FIELD_TYPE.MONEY, 3, 2)),
    ).toBe('123.45');
    expect(
      decodeField(Buffer.from([0x12, 0x34, 0x5d]), f(FIELD_TYPE.DECIMAL, 3, 2)),
    ).toBe('-123.45');
    expect(
      decodeField(Buffer.from([0x00, 0x00, 0x0c]), f(FIELD_TYPE.DECIMAL, 3, 0)),
    ).toBe('0');
    expect(() =>
      decodeField(Buffer.from([0x1a, 0x0c]), f(FIELD_TYPE.DECIMAL, 2, 0)),
    ).toThrow(/BCD/);
  });

  it('logical', () => {
    expect(decodeField(Buffer.from([0, 0]), f(FIELD_TYPE.LOGICAL, 2))).toBe(
      false,
    );
    expect(decodeField(Buffer.from([0, 1]), f(FIELD_TYPE.LOGICAL, 2))).toBe(
      true,
    );
  });

  it('refuses a field that runs past the record, or an unknown type', () => {
    expect(() => decodeField(Buffer.alloc(4), f(FIELD_TYPE.STRING, 8))).toThrow(
      /past the record/,
    );
    expect(() => decodeField(Buffer.alloc(4), f(99, 4))).toThrow(
      /not supported/,
    );
  });
});

describe('exactAmount', () => {
  it('turns a stored float into the amount it holds', () => {
    expect(exactAmount(0.1 + 0.2)).toBe('0.30');
    expect(exactAmount(1433519038.8)).toBe('1433519038.80');
    expect(exactAmount(-10214)).toBe('-10214.00');
    expect(exactAmount(0)).toBe('0.00');
    expect(exactAmount(12.345, 3)).toBe('12.345');
    expect(exactAmount(999999999999.99)).toBe('999999999999.99');
  });

  it('refuses a float that is not an amount at that precision', () => {
    expect(() => exactAmount(1.005)).toThrow(RangeError);
    expect(() => exactAmount(1234.5678)).toThrow(RangeError);
    expect(() => exactAmount(Number.NaN)).toThrow(RangeError);
    expect(() => exactAmount(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('readDictionary', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ddf-spec-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names every table, its file and its fields; skips index names', async () => {
    const files = writeBtrieve({
      recordLength: 97,
      records: [
        fileRecord(1, 'Customers', 'CUSTOMER.DAT'),
        fileRecord(2, 'Chart', '.\\CHART.DAT'),
      ],
    });
    const fields = writeBtrieve({
      recordLength: 32,
      records: [
        fieldRecord(1, 1, 'CustomerID', FIELD_TYPE.STRING, 0, 21),
        fieldRecord(2, 1, 'Balance', FIELD_TYPE.FLOAT, 21, 8, 2),
        fieldRecord(3, 1, 'ByName', 255, 0, 0),
        fieldRecord(4, 2, 'AccountID', FIELD_TYPE.STRING, 0, 16),
        fieldRecord(5, 9, 'Orphan', FIELD_TYPE.STRING, 0, 4),
      ],
    });
    const fp = join(dir, 'FILE.DDF');
    const dp = join(dir, 'FIELD.DDF');
    writeFileSync(fp, files.buffer);
    writeFileSync(dp, fields.buffer);
    const dict = await readDictionary(fp, dp);
    const customers = dict.get('customers')!;
    expect(customers.file).toBe('CUSTOMER.DAT');
    expect(customers.recordLength).toBe(29);
    expect([...customers.fields.keys()]).toEqual(['customerid', 'balance']);
    expect(customers.fields.get('balance')).toMatchObject({
      offset: 21,
      size: 8,
      decimals: 2,
    });
    expect(dict.get('chart')!.file).toBe('CHART.DAT');
  });

  it('refuses dictionary files of another layout', async () => {
    const wrong = writeBtrieve({
      recordLength: 40,
      records: [Buffer.alloc(40)],
    });
    const p = join(dir, 'BAD.DDF');
    writeFileSync(p, wrong.buffer);
    await expect(readDictionary(p, p)).rejects.toMatchObject({
      code: 'MIGRATION_PTB_UNSUPPORTED',
    });
  });
});
