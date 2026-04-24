import { IsString, IsOptional, IsUUID, IsEnum, IsArray, ValidateNested, IsNumberString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class RequestLineDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumberString() deliveredQty!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() returnedQty?: string;
}

export class CreateInventoryUpdateRequestDto {
  @ApiProperty() @IsUUID() deliveryId!: string;
  @ApiProperty() @IsUUID() personnelId!: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => RequestLineDto) lines!: RequestLineDto[];
}

export class ReviewRequestDto {
  @ApiProperty() @IsEnum(['approved', 'rejected']) action!: 'approved' | 'rejected';
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
