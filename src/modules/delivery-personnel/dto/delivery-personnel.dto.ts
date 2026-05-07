import { IsString, IsOptional, IsBoolean, IsEnum, IsNumberString, IsArray, IsUUID, Length, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryPersonnelStatus } from '../../../types';

export class CreatePersonnelDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() zones?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxLoad?: string;
}

export class UpdatePersonnelDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) vehicleNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() zones?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxLoad?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['active', 'on_leave', 'inactive'] as DeliveryPersonnelStatus[]) status?: DeliveryPersonnelStatus;
}

export class UpdateLocationDto {
  @ApiProperty({ description: 'GPS latitude' }) @IsNumber() lat!: number;
  @ApiProperty({ description: 'GPS longitude' }) @IsNumber() lng!: number;
}
