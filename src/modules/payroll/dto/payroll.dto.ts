import { IsString, IsOptional, IsEnum, IsNumberString, IsUUID, IsDateString, Length, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class PaystubLineDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() hoursWorked?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() grossPay?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() taxDeduction?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() healthInsuranceDeduction?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() retirementDeduction?: string;
}

export class CreatePayrollRunDto {
  @ApiProperty() @IsString() @Length(1, 64) payPeriod!: string;
  @ApiProperty() @IsDateString() periodStart!: string;
  @ApiProperty() @IsDateString() periodEnd!: string;
  @ApiProperty() @IsDateString() payDate!: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => PaystubLineDto) paystubs!: PaystubLineDto[];
}

export class UpdatePayrollRunDto {
  @ApiPropertyOptional() @IsOptional() @IsEnum(['draft', 'processed', 'posted']) status?: string;
}
