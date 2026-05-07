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
} from 'class-validator';
import { BillStatus, PaymentMethod } from '../../../types';
import { PAYMENT_METHODS } from '../../payments/dto/payment.dto';

export class BillLineDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiProperty() @IsString() description!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() amount?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() quantity?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() unitPrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() taxRate?: string;
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

  @ApiProperty({ type: [BillPaymentApplicationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BillPaymentApplicationDto)
  applications!: BillPaymentApplicationDto[];
}
