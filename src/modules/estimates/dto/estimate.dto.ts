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

export class EstimateLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty({ example: '1' }) @IsNumberString() quantity!: string;
  @ApiProperty({ example: '100' }) @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() taxRate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
}

export class CreateEstimateDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty({ example: '2026-04-23' }) @IsDateString() estimateDate!: string;
  @ApiPropertyOptional({ example: '2026-05-23' }) @IsOptional() @IsDateString() expiryDate?: string;

  @ApiPropertyOptional({ enum: ['percent', 'amount', 'none'], default: 'none' })
  @IsOptional() @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';

  @ApiPropertyOptional({ example: '0' }) @IsOptional() @IsNumberString() discountValue?: string;

  @ApiPropertyOptional({ enum: ['draft', 'sent'], default: 'draft' })
  @IsOptional() @IsIn(['draft', 'sent'])
  status?: 'draft' | 'sent';

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiProperty({ type: [EstimateLineDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => EstimateLineDto)
  lines!: EstimateLineDto[];
}

export class UpdateEstimateDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() estimateDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expiryDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['percent', 'amount', 'none'])
  discountType?: 'percent' | 'amount' | 'none';
  @ApiPropertyOptional() @IsOptional() @IsNumberString() discountValue?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [EstimateLineDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => EstimateLineDto)
  lines?: EstimateLineDto[];
}

export class ListEstimatesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['draft', 'sent', 'accepted', 'declined', 'converted', 'expired'])
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class EstimateStatusDto {
  @ApiProperty({ enum: ['sent', 'accepted', 'declined'] })
  @IsIn(['sent', 'accepted', 'declined'])
  status!: 'sent' | 'accepted' | 'declined';
}

export class ConvertEstimateDto {
  @ApiPropertyOptional({ example: '2026-05-23', description: 'Invoice due date (invoice conversion).' })
  @IsOptional() @IsDateString() dueDate?: string;
}
