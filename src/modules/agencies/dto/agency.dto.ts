import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsUUID,
  Length,
  IsObject,
  IsArray,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AgencyType } from '../../../types';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

export class CreateAgencyDto {
  @ApiProperty({ example: 'ABC Manufacturing' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ enum: ['manufacturing', 'supply', 'distribution'] })
  @IsEnum(['manufacturing', 'supply', 'distribution'] as AgencyType[])
  type!: AgencyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  contact?: Record<string, unknown>;
}

export class UpdateAgencyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(['manufacturing', 'supply', 'distribution'] as AgencyType[])
  type?: AgencyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  contact?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  inventory?: AgencyInventoryItemDto[];
}

export class AgencyInventoryItemDto {
  @IsString() itemId!: string;
  @IsOptional() @IsString() itemName?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() unitOfMeasure?: string;
  @IsOptional() @IsNumber() unitCost?: number;
  @IsOptional() @IsNumber() sellingPrice?: number;
  @IsOptional() @IsNumber() quantity?: number;
  @IsOptional() @IsNumber() quantityOnHand?: number;
  @IsOptional() @IsNumber() reorderLevel?: number;
  @IsOptional() @IsNumber() reorderPoint?: number;
}

export class SyncInventoryDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgencyInventoryItemDto)
  inventory?: AgencyInventoryItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgencyInventoryItemDto)
  items?: AgencyInventoryItemDto[];
}

export class AgencyQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(['manufacturing', 'supply', 'distribution'] as AgencyType[])
  type?: AgencyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isConnected?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;
}
