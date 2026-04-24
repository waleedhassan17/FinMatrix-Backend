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
import { SalesOrderStatus } from '../../../types';

export class SalesOrderLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumberString() orderedQty!: string;
  @ApiProperty() @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() taxRate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() itemId?: string;
}

export class CreateSalesOrderDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsDateString() orderDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiProperty({ type: [SalesOrderLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesOrderLineDto)
  lines!: SalesOrderLineDto[];
}

export class FulfillLineDto {
  @ApiProperty() @IsUUID() lineId!: string;
  @ApiProperty() @IsNumberString() fulfilledQty!: string;
}

export class FulfillOrderDto {
  @ApiProperty({ type: [FulfillLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FulfillLineDto)
  lines!: FulfillLineDto[];
}

export class ListSalesOrdersQueryDto {
  @ApiPropertyOptional({
    enum: ['draft', 'open', 'partial', 'fulfilled', 'closed'],
  })
  @IsOptional()
  @IsIn(['draft', 'open', 'partial', 'fulfilled', 'closed'])
  status?: SalesOrderStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
}
