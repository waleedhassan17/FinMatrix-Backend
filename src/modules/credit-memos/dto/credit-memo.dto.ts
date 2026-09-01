import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumberString, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';

export class CreditMemoLineDto {
  @ApiPropertyOptional({ description: 'Inventory item to restock on return.' })
  @IsOptional() @IsUUID() itemId?: string;
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
  /**
   * Settle the credit against this invoice as part of the same action.
   *
   * Set when reversing a delivery: creating the memo posts the reversal, but
   * without applying it the original invoice still shows a balance beside a
   * floating credit, so the customer appears to owe money they do not. Only
   * what the invoice can absorb is applied — a prepaid delivery has nothing
   * left to settle and the credit stays available.
   */
  @ApiPropertyOptional({ description: 'Invoice to settle with this credit, in the same action.' })
  @IsOptional() @IsUUID() applyToInvoiceId?: string;
  /**
   * Refund whatever the invoice could not absorb, in the same action.
   *
   * Set when reversing a PREPAID delivery: its invoice was already settled
   * from Customer Advances, so there is no receivable to clear and the credit
   * would otherwise leave A/R negative — a credit balance inside an asset
   * account — until somebody separately raised and approved a refund.
   */
  @ApiPropertyOptional({ description: 'Refund any unapplied remainder to cash.' })
  @IsOptional() @IsBoolean() refundRemainderToCash?: boolean;
  /**
   * The approved delivery this credit reverses. Recorded on that delivery so a
   * second reversal can be refused, and so the two are linked for audit.
   */
  @ApiPropertyOptional({ description: 'Delivery approval request this reverses.' })
  @IsOptional() @IsUUID() reversesDeliveryRequestId?: string;
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
