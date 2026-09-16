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
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PurchaseOrderStatus } from '../../../types';
import { IsTaxRate } from '../../../common/validation/tax-rate.validator';

export const PURCHASE_LINE_KINDS = ['item', 'expense'] as const;
export type PurchaseLineKind = (typeof PURCHASE_LINE_KINDS)[number];

export class PurchaseOrderLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumberString() orderedQty!: string;
  @ApiProperty() @IsNumberString() unitCost!: string;
  @ApiPropertyOptional({
    example: '17',
    description: 'Tax percent the vendor charges, typed by hand (0–100, up to 4 decimals).',
  })
  @IsOptional()
  @IsTaxRate()
  taxRate?: string;

  @ApiPropertyOptional({
    enum: PURCHASE_LINE_KINDS,
    description:
      "'item' adds stock on receipt and needs itemId; 'expense' is a non-stock " +
      'purchase and needs accountId (the expense account it bills to).',
  })
  @IsOptional()
  @IsIn(PURCHASE_LINE_KINDS)
  lineKind?: PurchaseLineKind;

  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
}

export class CreatePurchaseOrderDto {
  @ApiProperty() @IsUUID() vendorId!: string;
  @ApiProperty() @IsDateString() orderDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiProperty({ type: [PurchaseOrderLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines!: PurchaseOrderLineDto[];
}

export class ReceiveLineDto {
  @ApiProperty() @IsUUID() lineId!: string;
  @ApiProperty() @IsNumberString() receivedQty!: string;
}

export class ReceivePurchaseOrderDto {
  @ApiProperty({ type: [ReceiveLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
}

/**
 * Everything is optional: a bill raised from a PO takes the vendor's invoice
 * number if one is given (otherwise BILL-YYYY-NNNN), is dated today, and falls
 * due on the vendor's payment terms. The web client used to post no body at
 * all and got "billNumber must be a string; billDate must be a valid ISO 8601
 * date string; dueDate …" back.
 */
export class CreateBillFromPoDto {
  @ApiPropertyOptional({ description: "The vendor's own invoice number." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  billNumber?: string;

  @ApiPropertyOptional({ description: 'Defaults to today.' })
  @IsOptional()
  @IsDateString()
  billDate?: string;

  @ApiPropertyOptional({ description: "Defaults to the bill date plus the vendor's payment terms." })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  // Only needed for non-stock lines saved without an expense account (older
  // POs). Stock lines clear GRNI and never use it.
  @ApiPropertyOptional() @IsOptional() @IsUUID() defaultAccountId?: string;
}

/** The status column is varchar(16) — an unvalidated string is a Postgres
 *  22001 (a 500) rather than a 400, so every route taking one validates
 *  against this list. */
const PURCHASE_ORDER_STATUSES: PurchaseOrderStatus[] = [
  'draft',
  'sent',
  'partial',
  'received',
  'closed',
];

export class UpdatePurchaseOrderStatusDto {
  @ApiProperty({ enum: PURCHASE_ORDER_STATUSES })
  @IsIn(PURCHASE_ORDER_STATUSES)
  status!: PurchaseOrderStatus;
}

export class ListPurchaseOrdersQueryDto {
  @ApiPropertyOptional({ enum: PURCHASE_ORDER_STATUSES })
  @IsOptional()
  @IsIn(PURCHASE_ORDER_STATUSES)
  status?: PurchaseOrderStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID() vendorId?: string;

  /** Order number, notes or vendor name. Undeclared, the whitelist stripped it. */
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}
