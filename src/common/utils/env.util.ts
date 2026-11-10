import type { ConfigService } from '@nestjs/config';

const TRUE_VALUES = ['true', '1', 'yes', 'on'];
const FALSE_VALUES = ['false', '0', 'no', 'off'];

/**
 * Read a boolean-ish value, case-insensitively. `undefined` when it is absent
 * or not recognisable, so callers can tell "set to false" from "not set".
 *
 * Joi.boolean() accepts 'TRUE' / 'False' as well as 'true' / 'false', and
 * @nestjs/config leaves the original string in process.env. Comparing that
 * string to 'true' disagreed with validation: EMAIL_ENABLED=TRUE passed and
 * then switched email off.
 */
export function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.includes(s)) return true;
  if (FALSE_VALUES.includes(s)) return false;
  return undefined;
}

/** Joi turns 'true'/'false' into booleans; process.env keeps strings. Accept both. */
export function envFlag(
  config: ConfigService | null,
  key: string,
  fallback: boolean,
): boolean {
  return parseBoolean(config?.get(key) ?? process.env[key]) ?? fallback;
}

export function envString(config: ConfigService | null, key: string): string {
  const raw: unknown = config?.get(key) ?? process.env[key];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}
