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
import { EstimateStatus } from '../../../types';

export class EstimateLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumberString() quantity!: string;
  @ApiProperty() @IsNumberString() unitPrice!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() taxRate?: string;
}

export class CreateEstimateDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsDateString() estimateDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expirationDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() discountAmount?: string;

  @ApiProperty({ type: [EstimateLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EstimateLineDto)
  lines!: EstimateLineDto[];
}

export class UpdateEstimateDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() estimateDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expirationDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() discountAmount?: string;
  @ApiPropertyOptional({ type: [EstimateLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EstimateLineDto)
  lines?: EstimateLineDto[];
}

export class ListEstimatesQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'sent', 'accepted', 'declined', 'expired'] })
  @IsOptional()
  @IsIn(['draft', 'sent', 'accepted', 'declined', 'expired'])
  status?: EstimateStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
}
