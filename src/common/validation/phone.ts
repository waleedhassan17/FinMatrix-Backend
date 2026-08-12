// ═══════════════════════════════════════════════════════
// FinMatrix — Pakistani phone validation + normalisation
// ═══════════════════════════════════════════════════════
// THE single source of truth for phone rules. Previously the regex
// (/^\+92-\d{2,3}-\d{7}$/) and its error message were duplicated across
// SignupDto and CreateCompanyDto, and demanded the dashed +92-XXX-XXXXXXX
// form — which rejected every way a Pakistani user actually types their
// number (03124890176, +923124890176, 0312-4890176, …).
//
// The rule now: strip the formatting the user typed, then check the digits.
// Everything is stored in one canonical form so lookups and exports are
// consistent:  +92XXXXXXXXXX  (E.164, e.g. +923124890176).
//
// The mirror of this file lives in the app at src/utils/phone.ts — keep the
// two in sync so the client never submits something the server will reject.

import { Transform } from 'class-transformer';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { applyDecorators } from '@nestjs/common';

/** Canonical mobile: +92 3XX XXXXXXX (Pakistani mobiles always start with 3). */
export const PK_MOBILE_CANONICAL = /^\+923\d{9}$/;

/**
 * Canonical landline: +92 <area 2-4 digits, never starting with 3> <subscriber>.
 * Pakistani landline NSNs run 9-11 digits total (e.g. 42-35761234 → Lahore,
 * 21-35131000 → Karachi, 51-1234567 → Islamabad).
 */
export const PK_LANDLINE_CANONICAL = /^\+92(?!3)[2-9]\d{8,10}$/;

/**
 * Reduce anything the user typed to the canonical +92XXXXXXXXXX form.
 *
 * Accepts (with or without spaces, dashes, dots or parentheses):
 *   03124890176   →  +923124890176
 *   +923124890176 →  +923124890176
 *   923124890176  →  +923124890176
 *   0312-4890176  →  +923124890176
 *   +92 312 4890176 → +923124890176
 *
 * Returns `undefined` for empty/blank input so `@IsOptional()` behaves as
 * intended — class-validator only skips `undefined`/`null`, so an empty
 * string used to trip the format error on an optional field.
 * Unrecognised input is returned trimmed-but-unchanged, letting the
 * validator produce the friendly message instead of silently mangling it.
 */
export function normalizePkPhone(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;

  const stripped = raw.replace(/[\s\-().]/g, '');
  if (stripped === '') return undefined;

  // Local form (0XXXXXXXXXX) → +92XXXXXXXXXX
  if (/^0\d+$/.test(stripped)) return `+92${stripped.slice(1)}`;
  // Country code without the plus (92XXXXXXXXXX) → +92XXXXXXXXXX
  if (/^92\d+$/.test(stripped)) return `+${stripped}`;
  // Already canonical, or some other country's number — leave it for the check.
  if (/^\+\d+$/.test(stripped)) return stripped;

  return stripped;
}

/** True for a canonical Pakistani MOBILE number. */
export const isPkMobile = (value: string): boolean =>
  PK_MOBILE_CANONICAL.test(value);

/** True for a canonical Pakistani LANDLINE number. */
export const isPkLandline = (value: string): boolean =>
  PK_LANDLINE_CANONICAL.test(value);

/** True for either, per the caller's policy. */
export function isValidPkPhone(value: string, allowLandline = false): boolean {
  return isPkMobile(value) || (allowLandline && isPkLandline(value));
}

export const PK_MOBILE_MESSAGE =
  'Enter a valid Pakistani mobile number (e.g. 0312 3456789 or +92 312 3456789)';

export const PK_PHONE_MESSAGE =
  'Enter a valid Pakistani phone number (e.g. 0312 3456789 or 042 35761234)';

/**
 * Normalise-then-validate a Pakistani phone field.
 *
 * The `@Transform` runs during `plainToInstance`, i.e. BEFORE validation
 * (the global ValidationPipe in main.ts uses `transform: true`), so the
 * validator only ever sees the canonical form and the entity is persisted
 * canonically without any service-layer change.
 *
 * @param opts.allowLandline accept landlines too — used for COMPANY phones,
 *   which are legitimately landlines (the repo's own seed data uses
 *   +92-42-35761234). User/personnel phones stay mobile-only.
 */
export function IsPkPhone(
  opts: { allowLandline?: boolean } = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const allowLandline = opts.allowLandline ?? false;

  return applyDecorators(
    Transform(({ value }) => normalizePkPhone(value)),
    (target: object, propertyName: string | symbol) => {
      registerDecorator({
        name: 'isPkPhone',
        target: target.constructor,
        propertyName: propertyName as string,
        options: {
          message: allowLandline ? PK_PHONE_MESSAGE : PK_MOBILE_MESSAGE,
          ...validationOptions,
        },
        validator: {
          validate(value: unknown): boolean {
            // `undefined` is left to @IsOptional()/@IsNotEmpty() to judge.
            if (value === undefined || value === null) return true;
            return (
              typeof value === 'string' && isValidPkPhone(value, allowLandline)
            );
          },
          defaultMessage(_args: ValidationArguments): string {
            return allowLandline ? PK_PHONE_MESSAGE : PK_MOBILE_MESSAGE;
          },
        },
      });
    },
  );
}
