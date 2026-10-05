import { BadRequestException } from '@nestjs/common';
import {
  assertValidPartyCode,
  formatPartyCode,
  isUniqueViolation,
  normalizePartyCode,
  PARTY_CODE_PATTERN,
  partyCodeTaken,
} from './party-code.util';

describe('party codes', () => {
  it('normalizes what was typed: trimmed, upper-case, empty means "assign one"', () => {
    expect(normalizePartyCode('  ali-01 ')).toBe('ALI-01');
    expect(normalizePartyCode('c-0007')).toBe('C-0007');
    expect(normalizePartyCode('   ')).toBeNull();
    expect(normalizePartyCode(undefined)).toBeNull();
    expect(normalizePartyCode(null)).toBeNull();
  });

  it('formats the series with four digits until it outgrows them', () => {
    expect(formatPartyCode('customer', 7)).toBe('C-0007');
    expect(formatPartyCode('vendor', 42)).toBe('V-0042');
    // lpad would have truncated this to C-1000.
    expect(formatPartyCode('customer', 10000)).toBe('C-10000');
  });

  it('allows letters, digits and . _ / - up to 20, starting with a letter or digit', () => {
    for (const ok of [
      'C-0001',
      'ALDRED',
      'KHI/001',
      'A.B_C-1',
      '12345678901234567890',
    ]) {
      expect(PARTY_CODE_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of [
      'A B',
      '-C1',
      '',
      '123456789012345678901',
      'Ä1',
      'C#1',
    ]) {
      expect(PARTY_CODE_PATTERN.test(bad)).toBe(false);
    }
  });

  it('refuses a bad code in words a person can act on', () => {
    expect(() => assertValidPartyCode('customer', 'A B')).toThrow(
      BadRequestException,
    );
    try {
      assertValidPartyCode('vendor', 'A B');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_VENDOR_CODE',
      });
    }
  });

  it('names who already holds a taken code', () => {
    const err = partyCodeTaken('customer', 'C-0001', {
      id: 'x',
      name: 'Faisal Traders',
    });
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: 'CUSTOMER_CODE_TAKEN',
      message:
        'C-0001 is already the customer ID of Faisal Traders. Choose another ID.',
    });
  });

  it('recognizes a unique violation however TypeORM wraps it', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ driverError: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
