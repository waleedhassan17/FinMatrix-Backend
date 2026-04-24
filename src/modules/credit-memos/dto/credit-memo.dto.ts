import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class CreditMemoLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumberString() quantity!: string;
  @ApiProperty() @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() taxRate?: string;
}

export class CreateCreditMemoDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsDateString() date!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() originalInvoiceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;

  @ApiProperty({ type: [CreditMemoLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreditMemoLineDto)
  lines!: CreditMemoLineDto[];
}

export class ApplyCreditMemoDto {
  @ApiProperty() @IsUUID() invoiceId!: string;
  @ApiProperty() @IsNumberString() amount!: string;
}
