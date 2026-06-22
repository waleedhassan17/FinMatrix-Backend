import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsDateString, IsIn, IsNumberString, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';

export class SalesOrderLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ example: '1' }) @IsNumberString() quantity!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() taxRate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
}

export class CreateSalesOrderDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty({ example: '2026-04-23' }) @IsDateString() orderDate!: string;
  @ApiPropertyOptional({ example: '2026-05-10' }) @IsOptional() @IsDateString() expectedDate?: string;

  @ApiPropertyOptional({ enum: ['percent', 'amount', 'none'], default: 'none' })
  @IsOptional() @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';

  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() discountValue?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiProperty({ type: [SalesOrderLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SalesOrderLineDto)
  lines!: SalesOrderLineDto[];
}

export class UpdateSalesOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() orderDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';
  @ApiPropertyOptional() @IsOptional() @IsNumberString() discountValue?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [SalesOrderLineDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SalesOrderLineDto)
  lines?: SalesOrderLineDto[];
}

export class ListSalesOrdersQueryDto {
  @ApiPropertyOptional()
  @IsOptional() @IsIn(['open', 'partial', 'fulfilled', 'invoiced', 'cancelled'])
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class FulfillLineDto {
  @ApiProperty() @IsUUID() lineId!: string;
  @ApiProperty({ example: '5', description: 'Total quantity fulfilled so far for this line.' })
  @IsNumberString() quantityFulfilled!: string;
}

export class FulfillSalesOrderDto {
  @ApiProperty({ type: [FulfillLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => FulfillLineDto)
  lines!: FulfillLineDto[];
}

export class ConvertSalesOrderDto {
  @ApiPropertyOptional({ example: '2026-05-23' }) @IsOptional() @IsDateString() dueDate?: string;
}
