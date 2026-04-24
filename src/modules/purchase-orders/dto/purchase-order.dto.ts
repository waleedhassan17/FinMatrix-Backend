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
  @ApiProperty() @IsUUID() defaultAccountId!: string;
}

export class ListPurchaseOrdersQueryDto {
  @ApiPropertyOptional({
    enum: ['draft', 'sent', 'partial', 'received', 'closed'],
  })
  @IsOptional()
  @IsIn(['draft', 'sent', 'partial', 'received', 'closed'])
  status?: PurchaseOrderStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID() vendorId?: string;
}
