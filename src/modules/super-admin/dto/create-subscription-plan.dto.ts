import { IsString, IsNumber, IsOptional, IsBoolean, IsArray, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSubscriptionPlanDto {
  @IsString()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  priceMonthly!: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  priceYearly!: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  maxUsers!: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  maxInvoices?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  features?: string[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  sortOrder?: number;
}
