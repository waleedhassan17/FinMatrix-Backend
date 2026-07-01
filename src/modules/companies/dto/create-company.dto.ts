import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PK_PHONE_REGEX } from '../../auth/dto/signup.dto';

export const LEGAL_STRUCTURES = [
  'sole_proprietor',
  'llc',
  'partnership',
  'corporation',
] as const;

export const ACCOUNTING_METHODS = ['cash', 'accrual'] as const;

class AddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() street?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
}

export class CreateCompanyDto {
  @ApiProperty({ example: 'Ali Traders' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() industry?: string;

  @ApiPropertyOptional({ enum: LEGAL_STRUCTURES })
  @IsOptional()
  @IsIn(LEGAL_STRUCTURES as unknown as string[])
  legalStructure?: string;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({ example: '+92-42-1234567' })
  @IsOptional()
  @IsString()
  @Matches(PK_PHONE_REGEX, {
    message: 'Phone must match Pakistani format +92-XXX-XXXXXXX',
  })
  phone?: string;

  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;

  @ApiPropertyOptional({ example: 'https://acme.pk' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() taxId?: string;

  @ApiPropertyOptional({ description: 'Fiscal year start month, 1-12', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;

  @ApiPropertyOptional({ enum: ACCOUNTING_METHODS })
  @IsOptional()
  @IsIn(ACCOUNTING_METHODS as unknown as string[])
  accountingMethod?: string;

  @ApiPropertyOptional({ example: 'PKR' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  homeCurrency?: string;

  @ApiPropertyOptional({ description: 'URL or base64 logo string' })
  @IsOptional()
  @IsString()
  logo?: string;
}

export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {
  @ApiPropertyOptional({ description: 'Mark/dismiss the first-run setup checklist' })
  @IsOptional()
  @IsBoolean()
  setupCompleted?: boolean;

  @ApiPropertyOptional({
    description: 'Close the books up to this date (YYYY-MM-DD); blocks postings on/before it. Send null to reopen.',
  })
  @IsOptional()
  booksLockedUntil?: string | null;

  @ApiPropertyOptional({
    description: 'GST/Sales-tax registered: reclaim input tax on bills to a recoverable asset (1300).',
  })
  @IsOptional()
  @IsBoolean()
  salesTaxRegistered?: boolean;
}

export class JoinCompanyDto {
  @ApiProperty({ example: 'AB12CD' })
  @IsString()
  @MinLength(4)
  code!: string;
}
