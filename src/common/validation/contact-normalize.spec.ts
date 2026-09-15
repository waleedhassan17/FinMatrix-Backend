import { normalizeEmail, normalizePhone } from './contact-normalize';

describe('normalizePhone', () => {
  it('reduces every way of writing the same mobile to ONE string', () => {
    const inputs = ['03001234567', '+923001234567', '923001234567', '00923001234567'];
    const outputs = inputs.map(normalizePhone);
    expect(outputs).toEqual([
      '+923001234567',
      '+923001234567',
      '+923001234567',
      '+923001234567',
    ]);
  });

  it('ignores the formatting people type', () => {
    for (const input of [
      '0300-1234567',
      '0300 123 4567',
      '(0300) 123-4567',
      '+92 300 1234567',
      '0092 300 1234567',
      '  03001234567  ',
    ]) {
      expect(normalizePhone(input)).toBe('+923001234567');
    }
  });

  it('accepts company landlines in the same canonical form', () => {
    expect(normalizePhone('042-35761234')).toBe('+924235761234');
    expect(normalizePhone('+92-42-35761234')).toBe('+924235761234');
    expect(normalizePhone('0092 42 35761234')).toBe('+924235761234');
  });

  it('returns null rather than storing something that is not a number', () => {
    for (const bad of [
      '',
      '   ',
      'not-a-phone',
      '0300-abc4567',
      '12345',
      '0300123456', // one digit short
      '030012345678', // one digit long
      '+14155552671', // another country
      '001415555267', // another country via 00
      '+92',
      '0',
    ]) {
      expect(normalizePhone(bad)).toBeNull();
    }
  });

  it('returns null for non-strings', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(3001234567)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Owner@Example.COM ')).toBe('owner@example.com');
  });

  it('keeps Gmail dots and +tags — they may be different people', () => {
    expect(normalizeEmail('first.last@gmail.com')).toBe('first.last@gmail.com');
    expect(normalizeEmail('firstlast+shop@gmail.com')).toBe('firstlast+shop@gmail.com');
    expect(normalizeEmail('first.last@gmail.com')).not.toBe(normalizeEmail('firstlast@gmail.com'));
  });

  it('returns null for blank or malformed input', () => {
    for (const bad of ['', '   ', 'owner', 'owner@', '@example.com', 'a b@example.com', 'owner@example']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});
