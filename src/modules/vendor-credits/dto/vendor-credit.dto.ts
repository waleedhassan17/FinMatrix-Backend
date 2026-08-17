import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsDateString, IsIn, IsNumberString, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';

export class VendorCreditLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ example: '100', description: 'Net amount, excluding tax.' })
  @IsNumberString() amount!: string;
  @ApiPropertyOptional({
    example: '17',
    description:
      'Tax percent to reverse out of Sales Tax Recoverable (1300) — the input ' +
      'tax claimed on the original bill. Omit or 0 for a tax-free credit.',
  })
  @IsOptional() @IsNumberString() taxRate?: string;
  @ApiPropertyOptional({
    description:
      'Inventory item being returned to the supplier. When set, the credit ' +
      'relieves stock and posts to Inventory (1200) rather than an expense ' +
      'account. Omit for money-only credits such as freight.',
  })
  @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional({ example: '3', description: 'Units returned. Required when itemId is set.' })
  @IsOptional() @IsNumberString() quantity?: string;
  @ApiPropertyOptional({ description: 'Expense account to credit for a non-stock line.' })
  @IsOptional() @IsUUID() accountId?: string;
}

export class CreateVendorCreditDto {
  @ApiProperty() @IsUUID() vendorId!: string;
  @ApiProperty({ example: '2026-06-22' }) @IsDateString() date!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() originalBillId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;

  @ApiProperty({ type: [VendorCreditLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => VendorCreditLineDto)
  lines!: VendorCreditLineDto[];
}

export class ListVendorCreditsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsIn(['open', 'applied', 'closed', 'void']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vendorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class ApplyVendorCreditDto {
  @ApiProperty() @IsUUID() billId!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
}
