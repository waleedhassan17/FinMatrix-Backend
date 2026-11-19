/**
 * Pervasive / Btrieve field types, decoded from a record's bytes.
 *
 * Peachtree keeps money in 8-byte IEEE floats. A float cannot hold 0.10
 * exactly, so an amount is turned into a decimal string by rounding to the
 * places it is kept at (two for money) — and is refused if the stored float is
 * not within a hair of such a value, because then it is not an amount
 * Peachtree wrote and rounding would invent one. No arithmetic is ever done on
 * the floats themselves.
 */
import Decimal from 'decimal.js';

export interface FieldDef {
  name: string;
  /** Pervasive data type code (X$Field.Xe$DataType). */
  type: number;
  offset: number;
  size: number;
  decimals: number;
}

export const FIELD_TYPE = {
  STRING: 0,
  INTEGER: 1,
  FLOAT: 2,
  DATE: 3,
  TIME: 4,
  DECIMAL: 5,
  MONEY: 6,
  LOGICAL: 7,
  NUMERIC: 8,
  BFLOAT: 9,
  LSTRING: 10,
  ZSTRING: 11,
  UNSIGNED: 14,
  AUTOINC: 15,
} as const;

export type FieldValue = string | number | boolean | null;

let cp1252: TextDecoder | null = null;
function text(bytes: Buffer): string {
  try {
    cp1252 ??= new TextDecoder('windows-1252');
    return cp1252.decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/** A Btrieve DATE (day, month, u16 year) as YYYY-MM-DD; null when blank. */
export function btrieveDate(b: Buffer, o: number): string | null {
  const day = b[o];
  const month = b[o + 1];
  const year = b.readUInt16LE(o + 2);
  if (day === 0 && month === 0 && year === 0) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) {
    throw new RangeError(`not a date: ${b.subarray(o, o + 4).toString('hex')}`);
  }
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.getUTCDate() !== day) throw new RangeError(`not a date: ${iso}`);
  return iso;
}

/** Packed BCD (DECIMAL / MONEY): sign in the last nibble (0xD/0xB = minus). */
function packedDecimal(b: Buffer, decimals: number): string {
  let digits = '';
  for (let i = 0; i < b.length; i++) {
    const hi = b[i] >> 4;
    const lo = b[i] & 0x0f;
    digits += String(hi);
    if (i < b.length - 1) digits += String(lo);
    else {
      if (hi > 9) throw new RangeError('bad BCD digit');
      const negative = lo === 0x0d || lo === 0x0b;
      const whole = digits.slice(0, digits.length - decimals) || '0';
      const frac = decimals ? digits.slice(digits.length - decimals) : '';
      const value = new Decimal(frac ? `${whole}.${frac}` : whole);
      return (negative ? value.negated() : value).toFixed(decimals);
    }
    if (hi > 9 || lo > 9) throw new RangeError('bad BCD digit');
  }
  return '0';
}

export function decodeField(rec: Buffer, f: FieldDef): FieldValue {
  const o = f.offset;
  if (o + f.size > rec.length) {
    throw new RangeError(`${f.name} runs past the record`);
  }
  const b = rec.subarray(o, o + f.size);
  switch (f.type) {
    case FIELD_TYPE.STRING:
      return text(b).replace(/[\s\0]+$/, '');
    case FIELD_TYPE.ZSTRING: {
      const end = b.indexOf(0);
      return text(end < 0 ? b : b.subarray(0, end)).trimEnd();
    }
    case FIELD_TYPE.LSTRING:
      return text(b.subarray(1, 1 + Math.min(b[0], f.size - 1))).trimEnd();
    case FIELD_TYPE.INTEGER:
    case FIELD_TYPE.AUTOINC:
      if (f.size === 1) return b.readInt8(0);
      if (f.size === 2) return b.readInt16LE(0);
      if (f.size === 4) return b.readInt32LE(0);
      if (f.size === 8) return Number(b.readBigInt64LE(0));
      break;
    case FIELD_TYPE.UNSIGNED:
      if (f.size === 1) return b[0];
      if (f.size === 2) return b.readUInt16LE(0);
      if (f.size === 4) return b.readUInt32LE(0);
      if (f.size === 8) return Number(b.readBigUInt64LE(0));
      return b.toString('hex');
    case FIELD_TYPE.FLOAT:
      if (f.size === 4) return b.readFloatLE(0);
      if (f.size === 8) return b.readDoubleLE(0);
      break;
    case FIELD_TYPE.DATE:
      return btrieveDate(b, 0);
    case FIELD_TYPE.TIME:
      return `${String(b[3]).padStart(2, '0')}:${String(b[2]).padStart(2, '0')}:${String(b[1]).padStart(2, '0')}`;
    case FIELD_TYPE.LOGICAL:
      return b.some((x) => x !== 0);
    case FIELD_TYPE.DECIMAL:
      return packedDecimal(b, f.decimals);
    case FIELD_TYPE.MONEY:
      return packedDecimal(b, f.decimals || 2);
  }
  throw new RangeError(
    `${f.name}: field type ${f.type} (${f.size} bytes) is not supported`,
  );
}

/**
 * A stored float as an exact amount with `places` decimals. Refused when the
 * float is further from that amount than its own precision explains (a
 * millionth of the last place, or a few units in the float's last place for
 * large values): such a value was not stored as money, and rounding it would
 * create a figure. Up to a trillion the allowance stays below a thousandth of
 * a paisa.
 */
export function exactAmount(value: number, places = 2): string {
  if (!Number.isFinite(value)) throw new RangeError('not a number');
  const exact = new Decimal(value);
  const rounded = exact.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  const slack = Decimal.max(
    new Decimal(10).pow(-places).times('0.000001'),
    exact.abs().times('1e-15'),
  );
  if (exact.minus(rounded).abs().greaterThan(slack)) {
    throw new RangeError(`${value} is not an amount with ${places} decimals`);
  }
  return rounded.toFixed(places);
}
