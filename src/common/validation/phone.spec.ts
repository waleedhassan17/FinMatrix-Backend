import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import {
  IsPkPhone,
  isPkLandline,
  isPkMobile,
  isValidPkPhone,
  normalizePkPhone,
} from './phone';

describe('normalizePkPhone', () => {
  it('normalises every common Pakistani mobile format to +923124890176', () => {
    const inputs = [
      '03124890176',
      '+923124890176',
      '923124890176',
      '0312-4890176',
      '+92 312 4890176',
      '0312 4890176',
      '(0312) 489-0176',
      '  03124890176  ',
    ];
    for (const input of inputs) {
      expect(normalizePkPhone(input)).toBe('+923124890176');
    }
  });

  it('treats blank input as absent so @IsOptional() applies', () => {
    expect(normalizePkPhone('')).toBeUndefined();
    expect(normalizePkPhone('   ')).toBeUndefined();
    expect(normalizePkPhone(undefined)).toBeUndefined();
    expect(normalizePkPhone(null)).toBeUndefined();
  });

  it('normalises landlines to the same canonical shape', () => {
    expect(normalizePkPhone('+92-42-35761234')).toBe('+924235761234');
    expect(normalizePkPhone('042-35761234')).toBe('+924235761234');
    expect(normalizePkPhone('+92-21-35131000')).toBe('+922135131000');
  });
});

describe('isPkMobile / isPkLandline', () => {
  it('accepts canonical mobiles', () => {
    expect(isPkMobile('+923124890176')).toBe(true);
    expect(isPkMobile('+923001234567')).toBe(true);
  });

  it('rejects non-mobiles', () => {
    expect(isPkMobile('+924235761234')).toBe(false); // landline
    expect(isPkMobile('+92312489017')).toBe(false); // one digit short
    expect(isPkMobile('+9231248901766')).toBe(false); // one digit long
    expect(isPkMobile('+14155552671')).toBe(false); // wrong country
  });

  it('accepts canonical landlines and never confuses them with mobiles', () => {
    expect(isPkLandline('+924235761234')).toBe(true); // Lahore
    expect(isPkLandline('+922135131000')).toBe(true); // Karachi
    expect(isPkLandline('+92511234567')).toBe(true); // Islamabad
    expect(isPkLandline('+923124890176')).toBe(false); // mobile
  });
});

describe('isValidPkPhone', () => {
  it('is mobile-only by default', () => {
    expect(isValidPkPhone('+923124890176')).toBe(true);
    expect(isValidPkPhone('+924235761234')).toBe(false);
  });

  it('accepts landlines when allowed', () => {
    expect(isValidPkPhone('+924235761234', true)).toBe(true);
    expect(isValidPkPhone('+923124890176', true)).toBe(true);
  });

  it('rejects genuinely invalid numbers either way', () => {
    for (const bad of ['12345', '+14155552671', 'not-a-phone', '+92', '0']) {
      expect(isValidPkPhone(bad, true)).toBe(false);
    }
  });
});

// ── The decorator end-to-end, exactly as the global ValidationPipe runs it ──

class MobileDto {
  @IsOptional()
  @IsString()
  @IsPkPhone()
  phone?: string;
}

class CompanyPhoneDto {
  @IsOptional()
  @IsString()
  @IsPkPhone({ allowLandline: true })
  phone?: string;
}

const runPipe = async <T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) => {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance as object);
  return { instance, errors };
};

describe('@IsPkPhone', () => {
  it.each([
    '03124890176',
    '+923124890176',
    '923124890176',
    '0312-4890176',
    '+92 312 4890176',
  ])('accepts %s and stores it canonically', async input => {
    const { instance, errors } = await runPipe(MobileDto, { phone: input });
    expect(errors).toHaveLength(0);
    expect(instance.phone).toBe('+923124890176');
  });

  it('lets an omitted or blank phone through (optional field)', async () => {
    for (const payload of [{}, { phone: '' }, { phone: '   ' }]) {
      const { instance, errors } = await runPipe(MobileDto, payload);
      expect(errors).toHaveLength(0);
      expect(instance.phone).toBeUndefined();
    }
  });

  it('rejects invalid numbers with the friendly message', async () => {
    const { errors } = await runPipe(MobileDto, { phone: '12345' });
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})[0]).toContain(
      'valid Pakistani mobile number',
    );
  });

  it('rejects a landline on a mobile-only field', async () => {
    const { errors } = await runPipe(MobileDto, { phone: '+92-42-35761234' });
    expect(errors).toHaveLength(1);
  });

  it('accepts a landline on the company field', async () => {
    const { instance, errors } = await runPipe(CompanyPhoneDto, {
      phone: '+92-42-35761234',
    });
    expect(errors).toHaveLength(0);
    expect(instance.phone).toBe('+924235761234');
  });

  it('still rejects nonsense on the company field', async () => {
    const { errors } = await runPipe(CompanyPhoneDto, { phone: '12345' });
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})[0]).toContain(
      'valid Pakistani phone number',
    );
  });
});
