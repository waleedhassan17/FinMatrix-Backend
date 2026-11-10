import { plainToInstance } from 'class-transformer';
import { ListAccountsQueryDto } from '../../modules/accounts/dto/account.dto';
import { InventoryItemQueryDto } from '../../modules/inventory/dto/inventory.dto';

/**
 * The global ValidationPipe transforms with enableImplicitConversion, under
 * which a bare `boolean` field turns the string "false" into `true`. Every
 * boolean on a query DTO must read the raw value instead.
 */
describe('boolean query parameters', () => {
  const asQuery = <T>(cls: new () => T, query: Record<string, string>) =>
    plainToInstance(cls, query, { enableImplicitConversion: true });

  it.each([
    ['ListAccountsQueryDto.isActive', ListAccountsQueryDto, 'isActive'],
    ['InventoryItemQueryDto.isActive', InventoryItemQueryDto, 'isActive'],
    ['InventoryItemQueryDto.lowStock', InventoryItemQueryDto, 'lowStock'],
  ] as const)(
    '%s reads "false" as false and "true" as true',
    (_name, cls, field) => {
      expect(
        (
          asQuery(cls as new () => object, { [field]: 'false' }) as Record<
            string,
            unknown
          >
        )[field],
      ).toBe(false);
      expect(
        (
          asQuery(cls as new () => object, { [field]: 'true' }) as Record<
            string,
            unknown
          >
        )[field],
      ).toBe(true);
      expect(
        (asQuery(cls as new () => object, {}) as Record<string, unknown>)[
          field
        ],
      ).toBeUndefined();
    },
  );
});
