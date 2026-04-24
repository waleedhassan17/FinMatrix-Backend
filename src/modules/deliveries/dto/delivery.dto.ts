import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsArray,
  ValidateNested,
  IsNumberString,
  Length,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryPriority, DeliveryStatus, DeliveryIssueType } from '../../../types';

export class DeliveryItemDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumberString() orderedQty!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() unitPrice?: string;
}

export class CreateDeliveryDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() personnelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['normal', 'high', 'urgent'] as DeliveryPriority[]) priority?: DeliveryPriority;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) preferredTimeSlot?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => DeliveryItemDto) items!: DeliveryItemDto[];
}

export class UpdateDeliveryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() personnelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['normal', 'high', 'urgent'] as DeliveryPriority[]) priority?: DeliveryPriority;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredTimeSlot?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class DeliveryStatusUpdateDto {
  @ApiProperty() @IsEnum([
    'unassigned', 'pending', 'picked_up', 'in_transit', 'arrived', 'delivered', 'failed', 'returned', 'cancelled',
  ] as DeliveryStatus[]) status!: DeliveryStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() location?: { lat: number; lng: number };
}

export class DeliveryQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsEnum([
    'unassigned', 'pending', 'picked_up', 'in_transit', 'arrived', 'delivered', 'failed', 'returned', 'cancelled',
  ] as DeliveryStatus[]) status?: DeliveryStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() personnelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
}

export class DeliveryIssueDto {
  @ApiProperty() @IsEnum(['damaged', 'wrong_item', 'customer_refused', 'access_denied', 'payment_issue', 'other'] as DeliveryIssueType[]) issueType!: DeliveryIssueType;
  @ApiProperty() @IsString() notes!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() photoUrl?: string;
}
