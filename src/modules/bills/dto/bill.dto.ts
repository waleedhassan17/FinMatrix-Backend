import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { BillStatus, PaymentMethod } from '../../../types';
import { PAYMENT_METHODS } from '../../payments/dto/payment.dto';
import { IsTaxRate } from '../../../common/validation/tax-rate.validator';

export class BillLineDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiProperty() @IsString() description!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() amount?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() quantity?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() unitPrice?: string;
  @ApiPropertyOptional({ example: '17', description: 'Tax percent, typed by hand (0–100).' })
  @IsOptional()
  @IsTaxRate()
  taxRate?: string;
}

export class CreateBillDto {
  @ApiProperty() @IsUUID() vendorId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() billNumber?: string;
  @ApiProperty() @IsDateString() billDate!: string;
  @ApiProperty() @IsDateString() dueDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;
  @ApiPropertyOptional({ enum: ['draft', 'open'], default: 'open' })
  @IsOptional()
  @IsIn(['draft', 'open'])
  status?: 'draft' | 'open';

  /** Set by the PO conversion path. A PO is billed once per receipt. */
  @ApiPropertyOptional() @IsOptional() @IsUUID() purchaseOrderId?: string;

  @ApiProperty({ type: [BillLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BillLineDto)
  lines!: BillLineDto[];
}

export class UpdateBillDto {
  @ApiPropertyOptional() @IsOptional() @IsString() billNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() billDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;
  @ApiPropertyOptional({ type: [BillLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BillLineDto)
  lines?: BillLineDto[];
}

export class ListBillsQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'open', 'partial', 'paid', 'overdue', 'void'] })
  @IsOptional()
  @IsIn(['draft', 'open', 'partial', 'paid', 'overdue', 'void'])
  status?: BillStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vendorId?: string;
  /** Bill number, memo or vendor name. Undeclared, the whitelist stripped it. */
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class BillPaymentApplicationDto {
  @ApiProperty() @IsUUID() billId!: string;
  @ApiProperty() @IsNumberString() amount!: string;
}

export class PayBillsDto {
  @ApiProperty() @IsUUID() vendorId!: string;
  @ApiProperty() @IsDateString() paymentDate!: string;
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) paymentMethod!: PaymentMethod;
  @ApiProperty() @IsUUID() bankAccountId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;

  /**
   * A bill_payment_proofs row, uploaded through POST /bill-payments/proofs
   * before the payment is recorded. Required: money leaving the bank account
   * has to be evidenced.
   */
  @ApiProperty({ description: 'Id returned by POST /bill-payments/proofs' })
  @IsNotEmpty({
    message:
      'A payment proof (receipt or screenshot) is required to record a bill payment.',
  })
  @IsUUID(undefined, {
    message:
      'A payment proof (receipt or screenshot) is required to record a bill payment.',
  })
  proofId!: string;

  @ApiProperty({ type: [BillPaymentApplicationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BillPaymentApplicationDto)
  applications!: BillPaymentApplicationDto[];
}

/** Vendor credit to spend on one bill, as part of a settlement. */
export class VendorCreditUseDto {
  @ApiProperty() @IsUUID() vendorCreditId!: string;
  @ApiProperty() @IsUUID() billId!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() amount!: string;
}

/** The cash leg of a settlement: what leaves the bank, and the proof of it. */
export class SettleBillsCashDto {
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) paymentMethod!: PaymentMethod;
  @ApiProperty() @IsUUID() bankAccountId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;

  @ApiProperty({ description: 'Id returned by POST /bill-payments/proofs' })
  @IsNotEmpty({
    message: 'A payment proof (receipt or screenshot) is required to record a bill payment.',
  })
  @IsUUID(undefined, {
    message: 'A payment proof (receipt or screenshot) is required to record a bill payment.',
  })
  proofId!: string;

  @ApiProperty({ type: [BillPaymentApplicationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BillPaymentApplicationDto)
  applications!: BillPaymentApplicationDto[];
}

/**
 * Settle a vendor's bills from their credits and/or cash, in one step.
 *
 * Credits are spent first, then cash; all of it in one transaction, so a
 * refused cash leg leaves every credit where it was. A settlement paid wholly
 * from credit moves no money and needs no proof.
 */
export class SettleBillsDto {
  @ApiProperty() @IsUUID() vendorId!: string;
  @ApiProperty() @IsDateString() paymentDate!: string;

  @ApiPropertyOptional({ type: [VendorCreditUseDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VendorCreditUseDto)
  credits?: VendorCreditUseDto[];

  @ApiPropertyOptional({ type: SettleBillsCashDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SettleBillsCashDto)
  cash?: SettleBillsCashDto;
}

