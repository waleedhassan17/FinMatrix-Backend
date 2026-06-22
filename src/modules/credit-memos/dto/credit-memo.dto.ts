import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsDateString, IsIn, IsNumberString, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';

export class CreditMemoLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ example: '1' }) @IsNumberString() quantity!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() taxRate?: string;
}

export class CreateCreditMemoDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty({ example: '2026-06-22' }) @IsDateString() date!: string;
  @ApiPropertyOptional({ description: 'Original invoice this credit references.' })
  @IsOptional() @IsUUID() originalInvoiceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;

  @ApiProperty({ type: [CreditMemoLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CreditMemoLineDto)
  lines!: CreditMemoLineDto[];
}

export class ListCreditMemosQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsIn(['open', 'applied', 'closed', 'refunded', 'void']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class ApplyCreditMemoDto {
  @ApiProperty() @IsUUID() invoiceId!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
}
