import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * A tax percentage typed by hand on a purchase line: 0, 10, 12.5, 17 …
 *
 * Purchase tax is whatever the vendor charged, so the clients no longer offer a
 * fixed list. That makes this the only guard on the value. The column is
 * decimal(8,4), so without it a negative rate would post a negative input tax
 * and anything from 10,000 up would fail at Postgres as a 500.
 */
export const TAX_RATE_PATTERN = /^\d{1,3}(\.\d{1,4})?$/;

export function isValidTaxRate(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  if (!TAX_RATE_PATTERN.test(text)) return false;
  const rate = Number(text);
  return rate >= 0 && rate <= 100;
}

export function IsTaxRate(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isTaxRate',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be a percentage between 0 and 100 with at most 4 decimals`,
        ...options,
      },
      validator: {
        validate: (value: unknown) => isValidTaxRate(value),
      },
    });
  };
}
