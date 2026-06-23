import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsEmail, IsIn, IsNumberString, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';

export class CreateEmployeeDto {
  @ApiProperty() @IsString() firstName!: string;
  @ApiProperty() @IsString() lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() position?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() hireDate?: string;
  @ApiPropertyOptional({ enum: ['salary', 'hourly'], default: 'salary' })
  @IsOptional() @IsIn(['salary', 'hourly']) payType?: 'salary' | 'hourly';
  @ApiPropertyOptional({ example: '50000' }) @IsOptional() @IsNumberString() salary?: string;
  @ApiPropertyOptional({ example: '500' }) @IsOptional() @IsNumberString() hourlyRate?: string;
  @ApiPropertyOptional({ enum: ['weekly', 'biweekly', 'monthly'], default: 'monthly' })
  @IsOptional() @IsIn(['weekly', 'biweekly', 'monthly']) payFrequency?: string;
  @ApiPropertyOptional({ description: 'Fixed deduction amount per period.', example: '0' })
  @IsOptional() @IsNumberString() deductionAmount?: string;
}

export class UpdateEmployeeDto extends CreateEmployeeDto {
  @ApiPropertyOptional({ enum: ['active', 'inactive', 'terminated'] })
  @IsOptional() @IsIn(['active', 'inactive', 'terminated']) status?: string;
}

export class ListEmployeesQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['active', 'inactive', 'terminated']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class PayrollItemInputDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiPropertyOptional({ example: '160' }) @IsOptional() @IsNumberString() hours?: string;
}

export class CreatePayrollRunDto {
  @ApiProperty({ example: 'June 2026' }) @IsString() payPeriod!: string;
  @ApiProperty({ example: '2026-06-01' }) @IsDateString() periodStart!: string;
  @ApiProperty({ example: '2026-06-30' }) @IsDateString() periodEnd!: string;
  @ApiProperty({ example: '2026-07-01' }) @IsDateString() payDate!: string;
  @ApiPropertyOptional({ type: [PayrollItemInputDto], description: 'Override employees/hours; defaults to all active employees.' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PayrollItemInputDto)
  items?: PayrollItemInputDto[];
}
