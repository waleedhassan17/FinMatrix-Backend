import { IsString, IsOptional, IsNumberString, IsBoolean, IsUUID, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsTaxRate } from '../../../common/validation/tax-rate.validator';

export class CreateTaxRateDto {
  @ApiProperty() @IsString() @Length(1, 200) name!: string;
  @ApiProperty({ example: '17' }) @IsTaxRate() rate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() type?: string;
  // App alias for `type` (e.g. "GST", "Sales Tax")
  @ApiPropertyOptional() @IsOptional() @IsString() taxType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() authority?: string;
  // App alias for `authority` (free-text note)
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateTaxRateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ example: '17' }) @IsOptional() @IsTaxRate() rate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() taxType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() authority?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class CreateTaxPaymentDto {
  @ApiProperty() @IsUUID() taxRateId!: string;
  @ApiProperty() @IsString() @Length(1, 32) period!: string;
  @ApiProperty() @IsNumberString() amount!: string;
  @ApiProperty() @IsString() paymentDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
}
