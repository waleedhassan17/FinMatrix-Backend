import { validate } from 'class-validator';
import { IsTaxRate, isValidTaxRate } from './tax-rate.validator';

class Line {
  @IsTaxRate()
  taxRate!: string;
}

describe('isValidTaxRate', () => {
  it.each(['0', '5', '10', '12.5', '17', '17.25', '100', '0.0001'])('accepts %s', (rate) => {
    expect(isValidTaxRate(rate)).toBe(true);
  });

  it.each(['-1', '100.01', '150', '17%', 'abc', '', '1e2', '12.34567'])('refuses %s', (rate) => {
    expect(isValidTaxRate(rate)).toBe(false);
  });

  it('reports a readable message through class-validator', async () => {
    const line = Object.assign(new Line(), { taxRate: '150' });
    const [error] = await validate(line);
    expect(error.constraints?.isTaxRate).toContain('between 0 and 100');
  });
});
