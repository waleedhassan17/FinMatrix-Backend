import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaymentTerms } from '../../../types';

export const PAYMENT_TERMS: PaymentTerms[] = [
  'due_on_receipt',
  'net15',
  'net30',
  'net45',
  'net60',
  '2_10_net30',
  'custom',
];

class AddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() street?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  // `zipCode` is accepted as an alias so app builds that send it don't
  // silently lose the field to DTO whitelisting.
  @ApiPropertyOptional()
  @Transform(({ value, obj }) => value ?? obj?.zipCode)
  @IsOptional()
  @IsString()
  postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zipCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
}

export class ShippingAddressDto extends AddressDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sameAsBilling?: boolean;
}

/**
 * A boolean query parameter read from what was actually sent.
 *
 * The global ValidationPipe converts implicitly, and class-transformer turns a
 * string into a boolean with `Boolean(value)` — so `?isActive=false` arrived as
 * `true` and the Inactive filter listed the active ones. `obj[key]` is the raw
 * query value, before that conversion.
 */
export const queryBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj?.[key];
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === '0') return false;
  return undefined;
};

/** List orders. `code` is natural order: C-2 before C-10. */
export const PARTY_SORTS = ['recent', 'code', 'name', 'balance'] as const;
export type PartySort = (typeof PARTY_SORTS)[number];

/** The app's status chip, accepted as another way to say `isActive`. */
export const PARTY_STATUSES = ['all', 'active', 'inactive'] as const;

export class CreateCustomerDto {
  @ApiProperty() @IsString() @MinLength(1) name!: string;

  @ApiPropertyOptional({
    example: 'C-0007',
    description: 'Customer ID. Left out or empty, the next one in the series is assigned.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() company?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  billingAddress?: AddressDto;

  @ApiPropertyOptional({ type: ShippingAddressDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress?: ShippingAddressDto;

  @ApiPropertyOptional({ example: '0' })
  @IsOptional()
  @IsNumberString()
  creditLimit?: string;

  @ApiPropertyOptional({ enum: PAYMENT_TERMS, default: 'net30' })
  @IsOptional()
  @IsIn(PAYMENT_TERMS)
  paymentTerms?: PaymentTerms;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() contactPerson?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() taxId?: string;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListCustomersQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: PARTY_STATUSES })
  @IsOptional()
  @IsIn(PARTY_STATUSES)
  status?: (typeof PARTY_STATUSES)[number];

  @ApiPropertyOptional({ enum: PARTY_SORTS, default: 'recent' })
  @IsOptional()
  @IsIn(PARTY_SORTS)
  sort?: PartySort;
}

export class StatementQueryDto {
  @ApiProperty() @IsDateString() startDate!: string;
  @ApiProperty() @IsDateString() endDate!: string;
}
