import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsDateString, IsIn, IsNumberString, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';

export class VendorCreditLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
  @ApiPropertyOptional({ description: 'Expense/inventory account to credit.' })
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
