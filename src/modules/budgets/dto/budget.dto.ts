import { IsString, IsOptional, IsEnum, IsNumberString, IsUUID, Length, IsArray, ValidateNested, IsInt } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class BudgetLineDto {
  @ApiProperty() @IsUUID() accountId!: string;
  @ApiProperty() @IsNumberString() annualTotal!: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() monthlyAmounts?: string[];
}

export class CreateBudgetDto {
  @ApiProperty() @IsString() @Length(1, 200) name!: string;
  @ApiProperty() @IsInt() fiscalYear!: number;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['draft', 'active', 'closed']) status?: string;
  @ApiProperty() @IsNumberString() totalBudget!: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => BudgetLineDto) lines!: BudgetLineDto[];
}

export class UpdateBudgetDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['draft', 'active', 'closed']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() totalBudget?: string;
}
