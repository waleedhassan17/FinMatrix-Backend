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
import { PurchaseOrderStatus } from '../../../types';

export class PurchaseOrderLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumberString() orderedQty!: string;
  @ApiProperty() @IsNumberString() unitCost!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() taxRate?: string;
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

export class CreateBillFromPoDto {
  @ApiProperty() @IsString() billNumber!: string;
  @ApiProperty() @IsDateString() billDate!: string;
  @ApiProperty() @IsDateString() dueDate!: string;
  // Optional: only needed as a fallback expense account for non-inventory
  // lines. Pure-inventory PO bills debit GRNI and don't require it.
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
}
