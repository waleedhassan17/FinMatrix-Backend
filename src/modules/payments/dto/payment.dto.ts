import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '../../../types';

export const PAYMENT_METHODS: PaymentMethod[] = [
  'cash',
  'check',
  'bank_transfer',
  'credit_card',
  'other',
];

export class PaymentApplicationDto {
  @ApiProperty() @IsUUID() invoiceId!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
}

export class ReceivePaymentDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsDateString() paymentDate!: string;
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) paymentMethod!: PaymentMethod;
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
  @ApiProperty({ description: 'Bank/Cash account id to debit' })
  @IsUUID()
  bankAccountId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;

  @ApiPropertyOptional({
    type: [PaymentApplicationDto],
    description: 'If omitted, auto-apply to oldest unpaid invoices (FIFO).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentApplicationDto)
  applications?: PaymentApplicationDto[];
}

export class ListPaymentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional({ enum: PAYMENT_METHODS })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethod;
}
