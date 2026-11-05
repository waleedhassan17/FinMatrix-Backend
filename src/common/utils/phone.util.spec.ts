import { maskPhone, toWhatsappE164 } from './phone.util';

// Ported from the app's src/utils/__tests__/whatsappPhone.test.ts — the same
// inputs must give the same number on the server (with the E.164 '+').
describe('toWhatsappE164', () => {
  it.each([
    ['0300 1234567', '+923001234567'],
    ['0300-1234567', '+923001234567'],
    ['3001234567', '+923001234567'],
    ['+92 300 1234567', '+923001234567'],
    ['0092 300 1234567', '+923001234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+92-300-5552200', '+923005552200'],
    ['03124890176', '+923124890176'],
    ['03441052857', '+923441052857'],
  ])('%s -> %s', (input, expected) => {
    expect(toWhatsappE164(input)).toBe(expected);
  });

  it('drops what cannot be a number rather than messaging it', () => {
    expect(toWhatsappE164('12345')).toBeNull();
    expect(toWhatsappE164('')).toBeNull();
    expect(toWhatsappE164(undefined)).toBeNull();
    expect(toWhatsappE164(null)).toBeNull();
    expect(toWhatsappE164('1234567890123456')).toBeNull(); // 16 digits
  });

  it('keeps a 10-digit number that does not start with 3 as it is', () => {
    // Same as the app: only 3xx mobiles get the 92 prefix.
    expect(toWhatsappE164('4212345678')).toBe('+4212345678');
  });
});

describe('maskPhone', () => {
  it('keeps the country code, three digits and the last four', () => {
    expect(maskPhone('+923001234567')).toBe('+92300***4567');
  });

  it('never prints a short or missing number', () => {
    expect(maskPhone(null)).toBe('(none)');
    expect(maskPhone('+1234')).toBe('+***');
  });
});
