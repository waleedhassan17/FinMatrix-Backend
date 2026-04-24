import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsUUID,
  Length,
  IsObject,
} from 'class-validator';
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
