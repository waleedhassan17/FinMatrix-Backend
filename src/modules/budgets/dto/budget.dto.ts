import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';

export class BudgetLineDto {
  @ApiProperty() @IsUUID() accountId!: string;
  @ApiProperty({ type: [Number], description: '12 monthly amounts (Jan..Dec).' })
  @IsArray() monthlyAmounts!: number[];
}

export class CreateBudgetDto {
  @ApiProperty({ example: 'FY2026 Operating Budget' }) @IsString() name!: string;
  @ApiProperty({ example: 2026 }) @IsInt() fiscalYear!: number;
  @ApiPropertyOptional({ enum: ['draft', 'active', 'archived'] })
  @IsOptional() @IsIn(['draft', 'active', 'archived']) status?: string;

  @ApiProperty({ type: [BudgetLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => BudgetLineDto)
  lines!: BudgetLineDto[];
}

export class UpdateBudgetDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['draft', 'active', 'archived']) status?: string;
  @ApiPropertyOptional({ type: [BudgetLineDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BudgetLineDto)
  lines?: BudgetLineDto[];
}

export class ListBudgetsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Type(() => Number) fiscalYear?: number;
}
