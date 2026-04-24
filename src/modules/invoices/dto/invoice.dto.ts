import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  Min,
} from 'class-validator';
import { InvoiceStatus, PaymentTerms } from '../../../types';
import { PAYMENT_TERMS } from '../../customers/dto/customer.dto';

export class InvoiceLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ example: '1' }) @IsNumberString() quantity!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() taxRate?: string;
  @ApiPropertyOptional({ description: 'Revenue account id' })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class CreateInvoiceDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty({ example: '2026-04-23' }) @IsDateString() invoiceDate!: string;
  @ApiProperty({ example: '2026-05-23' }) @IsDateString() dueDate!: string;

  @ApiPropertyOptional({ enum: ['percent', 'amount', 'none'], default: 'none' })
  @IsOptional()
  @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';

  @ApiPropertyOptional({ example: '0' })
  @IsOptional()
  @IsNumberString()
  discountValue?: string;

  @ApiPropertyOptional({ enum: PAYMENT_TERMS, default: 'net30' })
  @IsOptional()
  @IsIn(PAYMENT_TERMS)
  paymentTerms?: PaymentTerms;

  @ApiPropertyOptional({ enum: ['draft', 'sent'], default: 'draft' })
  @IsOptional()
  @IsIn(['draft', 'sent'])
  status?: 'draft' | 'sent';

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiProperty({ type: [InvoiceLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() invoiceDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';
  @ApiPropertyOptional() @IsOptional() @IsNumberString() discountValue?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [InvoiceLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines?: InvoiceLineDto[];
}

export class ListInvoicesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['draft', 'sent', 'partial', 'paid', 'overdue', 'void'])
  status?: InvoiceStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class VoidInvoiceDto {
  @ApiProperty() @IsString() reason!: string;
}
