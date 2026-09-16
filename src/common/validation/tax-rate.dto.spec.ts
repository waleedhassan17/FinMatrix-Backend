import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreditMemoLineDto } from '../../modules/credit-memos/dto/credit-memo.dto';
import { DeliveryItemDto } from '../../modules/deliveries/dto/delivery.dto';
import { EstimateLineDto } from '../../modules/estimates/dto/estimate.dto';
import { InvoiceLineDto } from '../../modules/invoices/dto/invoice.dto';
import { SalesOrderLineDto } from '../../modules/sales-orders/dto/sales-order.dto';
import { CreateTaxRateDto } from '../../modules/tax/dto/tax.dto';

/**
 * Tax is typed on every line now, so the DTO is what stops -5 or 150 from
 * posting. Sales lines used to be @IsNumberString only.
 */
const taxErrors = async (cls: new () => object, taxRate: unknown, base: object) => {
  const dto = plainToInstance(cls, { ...base, taxRate }, { enableImplicitConversion: true });
  const errors = await validate(dto);
  return errors.filter((e) => e.property === 'taxRate');
};

const salesLine = { description: 'Widget', quantity: '1', unitPrice: '100' };

describe.each([
  ['InvoiceLineDto', InvoiceLineDto],
  ['EstimateLineDto', EstimateLineDto],
  ['SalesOrderLineDto', SalesOrderLineDto],
  ['CreditMemoLineDto', CreditMemoLineDto],
])('%s taxRate', (_name, cls) => {
  it.each(['0', '12.5', '17', '100'])('accepts %s', async (rate) => {
    expect(await taxErrors(cls, rate, salesLine)).toHaveLength(0);
  });

  it.each(['-5', '150', '1.23456', 'abc'])('refuses %s', async (rate) => {
    expect(await taxErrors(cls, rate, salesLine)).toHaveLength(1);
  });

  it('still lets the rate be left out', async () => {
    expect(await taxErrors(cls, undefined, salesLine)).toHaveLength(0);
  });
});

describe('DeliveryItemDto taxRate', () => {
  const item = { itemId: '00000000-0000-4000-8000-000000000000', orderedQty: 1 };

  it.each([0, 12.5, '17'])('accepts %s', async (rate) => {
    expect(await taxErrors(DeliveryItemDto, rate, item)).toHaveLength(0);
  });

  it.each([-1, 150, 12.34567])('refuses %s', async (rate) => {
    expect(await taxErrors(DeliveryItemDto, rate, item)).toHaveLength(1);
  });
});

describe('CreateTaxRateDto rate', () => {
  const rateErrors = async (rate: unknown) => {
    const dto = plainToInstance(CreateTaxRateDto, { name: 'GST', rate }, { enableImplicitConversion: true });
    return (await validate(dto)).filter((e) => e.property === 'rate');
  };

  it.each(['17', 12.5])('accepts %s', async (rate) => {
    expect(await rateErrors(rate)).toHaveLength(0);
  });

  it.each(['-1', '150'])('refuses %s', async (rate) => {
    expect(await rateErrors(rate)).toHaveLength(1);
  });
});
