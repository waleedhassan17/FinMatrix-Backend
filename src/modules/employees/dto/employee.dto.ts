import { IsString, IsOptional, IsEnum, IsNumberString, IsBoolean, IsDateString, Length, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEmployeeDto {
  @ApiProperty() @IsString() @Length(1, 120) firstName!: string;
  @ApiProperty() @IsString() @Length(1, 120) lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() position?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() hireDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['salary', 'hourly']) payType?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() salary?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() hourlyRate?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['weekly', 'biweekly', 'semimonthly', 'monthly']) payFrequency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() taxId?: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() position?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() hireDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() terminationDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['active', 'on_leave', 'terminated']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['salary', 'hourly']) payType?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() salary?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() hourlyRate?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['weekly', 'biweekly', 'semimonthly', 'monthly']) payFrequency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() taxId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class EmployeeQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['active', 'on_leave', 'terminated']) status?: string;
}
