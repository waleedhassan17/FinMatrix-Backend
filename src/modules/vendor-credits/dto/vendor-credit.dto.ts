import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class VendorCreditLineDto {
  @ApiProperty() @IsUUID() accountId!: string;
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumberString() amount!: string;
}

export class CreateVendorCreditDto {
  @ApiProperty() @IsUUID() vendorId!: string;
  @ApiProperty() @IsDateString() date!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() originalBillId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;

  @ApiProperty({ type: [VendorCreditLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VendorCreditLineDto)
  lines!: VendorCreditLineDto[];
}

export class ApplyVendorCreditDto {
  @ApiProperty() @IsUUID() billId!: string;
  @ApiProperty() @IsNumberString() amount!: string;
}
