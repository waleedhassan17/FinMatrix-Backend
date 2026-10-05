import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaymentTerms } from '../../../types';
import {
  PARTY_SORTS,
  PARTY_STATUSES,
  PAYMENT_TERMS,
  queryBoolean,
  type PartySort,
} from '../../customers/dto/customer.dto';

class AddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() street?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
}

export class CreateVendorDto {
  @ApiProperty() @IsString() @MinLength(1) companyName!: string;

  @ApiPropertyOptional({
    example: 'V-0003',
    description: 'Vendor ID. Left out or empty, the next one in the series is assigned.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactPerson?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({ enum: PAYMENT_TERMS, default: 'net30' })
  @IsOptional()
  @IsIn(PAYMENT_TERMS)
  paymentTerms?: PaymentTerms;

  @ApiPropertyOptional() @IsOptional() @IsString() taxId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() defaultExpenseAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdateVendorDto extends PartialType(CreateVendorDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListVendorsQueryDto {
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

export class VendorStatementQueryDto {
  @ApiProperty() @IsDateString() startDate!: string;
  @ApiProperty() @IsDateString() endDate!: string;
}
