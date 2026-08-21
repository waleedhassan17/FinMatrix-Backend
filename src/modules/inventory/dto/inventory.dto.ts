import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumberString,
  IsUUID,
  IsEnum,
  IsArray,
  ValidateNested,
  Length,
  Min,
  Max,
  IsInt,
  IsDecimal,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryCostMethod, InventoryAdjustmentReason } from '../../../types';

// --- Inventory Item ---
export class CreateInventoryItemDto {
  @ApiProperty() @IsString() @Length(1, 64) sku!: string;
  @ApiProperty() @IsString() @Length(1, 200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 32) unitOfMeasure?: string;
  // Weighted average only — see InventoryCostMethod. Anything else is rejected
  // rather than silently stored and ignored.
  @ApiPropertyOptional({ enum: ['average'], default: 'average' })
  @IsOptional() @IsEnum(['average'] as InventoryCostMethod[]) costMethod?: InventoryCostMethod;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() unitCost?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() sellingPrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() reorderPoint?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() reorderQuantity?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minStock?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxStock?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceAgencyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() locationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() serialTracking?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() lotTracking?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 128) barcodeData?: string;
}

export class UpdateInventoryItemDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() unitOfMeasure?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() unitCost?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() sellingPrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() reorderPoint?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() reorderQuantity?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minStock?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxStock?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceAgencyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() locationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() serialTracking?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() lotTracking?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() barcodeData?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class InventoryItemQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceAgencyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() locationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() lowStock?: boolean;
}

// --- Opening stock ---
// Note there is deliberately NO quantity field on CreateInventoryItemDto.
// Creating an item is reference data and posts nothing; stock the company
// already owned is a balance-sheet event and comes through here, where it
// posts Dr Inventory 1200 / Cr Opening Balance Equity 3900 (§3.12).
export class SetOpeningStockDto {
  @ApiProperty({ example: '100' }) @IsNumberString() quantity!: string;
  @ApiPropertyOptional({ example: '2026-08-15' }) @IsOptional() @IsString() asOfDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// --- Adjustment ---
export class AdjustQuantityDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumberString() newQty!: string;
  @ApiProperty() @IsEnum(['physical_count', 'damage', 'theft', 'correction', 'obsolescence', 'other'] as InventoryAdjustmentReason[]) reason!: InventoryAdjustmentReason;
  /**
   * The date the adjustment is recorded ON — it sets the GL period, and the
   * period lock is enforced against it. Defaults to today.
   *
   * @IsDateString, not the @IsString() that SetOpeningStockDto.asOfDate uses:
   * that one is unvalidated, so 'banana' reaches a date column and fails in
   * Postgres instead of in the pipe.
   */
  @ApiPropertyOptional({ example: '2026-08-15' }) @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() referenceNum?: string;
}

// --- Stock Transfer ---
export class TransferLineDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumberString() quantity!: string;
}

export class CreateStockTransferDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() fromLocationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() toLocationId?: string;
  @ApiProperty() @IsString() transferDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => TransferLineDto) lines!: TransferLineDto[];
}

// --- Physical Count ---
export class CountLineDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumberString() countedQty!: string;
}

export class CreatePhysicalCountDto {
  @ApiProperty() @IsString() countDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => CountLineDto) lines!: CountLineDto[];
}

// --- Movement Query ---
export class MovementQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() endDate?: string;
}
