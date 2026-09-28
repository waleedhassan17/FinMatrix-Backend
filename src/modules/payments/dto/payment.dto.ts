import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  @ApiPropertyOptional({
    description:
      'Bank/Cash GL account id to debit. If omitted, defaults to the ' +
      "company's Cash account (for the 'cash' method) or Business Checking account.",
  })
  @IsOptional()
  @IsUUID()
  bankAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;

  @ApiPropertyOptional({
    type: [PaymentApplicationDto],
    description:
      'Invoices to apply the receipt to. If omitted (and holdAsAdvance is not ' +
      'true), it is auto-applied to the oldest unpaid invoices (FIFO). Whatever ' +
      'is not applied is held in 2400 Customer Advances.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentApplicationDto)
  applications?: PaymentApplicationDto[];

  @ApiPropertyOptional({
    description:
      'Hold the whole receipt (or everything not in `applications`) as a ' +
      'customer advance. Without it an empty or missing `applications` means ' +
      '"apply automatically", which is the opposite of what a "save as credit" ' +
      'choice asks for.',
  })
  @IsOptional()
  @IsBoolean()
  holdAsAdvance?: boolean;
}

/** Apply money a receipt is still holding as an advance to invoices. */
export class ApplyPaymentDto {
  @ApiProperty({ type: [PaymentApplicationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentApplicationDto)
  applications!: PaymentApplicationDto[];

  @ApiPropertyOptional({ description: 'Application date; defaults to today.' })
  @IsOptional()
  @IsDateString()
  date?: string;
}

/** Money the customer already has on account, spent on one invoice. */
export class CustomerCreditUseDto {
  @ApiProperty({ enum: ['advance', 'credit_memo'] })
  @IsIn(['advance', 'credit_memo'])
  kind!: 'advance' | 'credit_memo';

  @ApiProperty({ description: 'The receipt holding the advance, or the credit memo.' })
  @IsUUID()
  id!: string;

  @ApiProperty() @IsUUID() invoiceId!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
}

/** The new-money leg of a settlement: a receipt, exactly as POST /payments takes one. */
export class SettleInvoicesCashDto {
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) paymentMethod!: PaymentMethod;
  @ApiPropertyOptional() @IsOptional() @IsUUID() bankAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;

  @ApiPropertyOptional({ type: [PaymentApplicationDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentApplicationDto)
  applications?: PaymentApplicationDto[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() holdAsAdvance?: boolean;
}

/**
 * Settle a customer's invoices from what they already have on account —
 * advances and credit memos — and/or new money, in one step.
 *
 * Credits are spent first, then the receipt is recorded; all of it in one
 * transaction. A receipt with no `applications` sweeps oldest-due first over
 * what the credits left, so overdue invoices are paid before current ones.
 */
export class SettleInvoicesDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsDateString() paymentDate!: string;

  @ApiPropertyOptional({ type: [CustomerCreditUseDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerCreditUseDto)
  credits?: CustomerCreditUseDto[];

  @ApiPropertyOptional({ type: SettleInvoicesCashDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SettleInvoicesCashDto)
  cash?: SettleInvoicesCashDto;
}

export class ListPaymentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() invoiceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional({ enum: PAYMENT_METHODS })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethod;
}
