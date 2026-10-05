import { normalizeAuditValue, sameAuditValue } from './audit-diff.util';

describe('audit diffs', () => {
  it('treats blank, NULL and missing as the same nothing', () => {
    expect(sameAuditValue('', null)).toBe(true);
    expect(sameAuditValue('  ', undefined)).toBe(true);
    expect(sameAuditValue('0300-1234567', '')).toBe(false);
  });

  it('compares decimal fields as numbers only when told to', () => {
    expect(sameAuditValue('50000', '50000.0000', true)).toBe(true);
    expect(sameAuditValue('50000', '75000.0000', true)).toBe(false);
    // A phone number is text: 0300 is not 300.
    expect(sameAuditValue('0300', '300')).toBe(false);
  });

  it('reads an address by what it says, not by key order or empty parts', () => {
    expect(
      sameAuditValue(
        { city: 'Lahore', country: 'Pakistan' },
        { country: 'Pakistan', street: '', city: 'Lahore' },
      ),
    ).toBe(true);
    expect(sameAuditValue({ city: 'Lahore' }, { city: 'Karachi' })).toBe(false);
    expect(normalizeAuditValue({ street: '', city: '' })).toBeNull();
  });
});
