import { IsString, IsOptional, IsNumberString, IsBoolean, IsUUID, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaxRateDto {
  @ApiProperty() @IsString() @Length(1, 200) name!: string;
  @ApiProperty() @IsNumberString() rate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() authority?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateTaxRateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() rate?: string;
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
