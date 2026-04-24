import { IsString, IsOptional, IsInt, IsObject, Length } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 10) fiscalYearStart?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 3) defaultCurrency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 32) taxIdLabel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 16) invoicePrefix?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() invoiceStartNumber?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 32) dateFormat?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() features?: Record<string, unknown>;
}
