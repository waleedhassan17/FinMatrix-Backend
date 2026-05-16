import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsArray,
  ValidateNested,
  IsNumberString,
  IsNumber,
  Length,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryPriority, DeliveryStatus, DeliveryIssueType } from '../../../types';

export class DeliveryItemDto {
  @ApiProperty() @IsString() itemId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() itemName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agencyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agencyName?: string;
  @ApiPropertyOptional() @IsOptional() quantity?: number | string;
  @ApiProperty() orderedQty!: number | string;
  @ApiPropertyOptional() @IsOptional() unitPrice?: number | string;
}

export class CreateDeliveryDto {
  @ApiProperty() @IsString() customerId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() customerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() scheduledDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() personnelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['low', 'normal', 'medium', 'high', 'urgent'] as DeliveryPriority[]) priority?: DeliveryPriority;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) preferredTimeSlot?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => DeliveryItemDto) items!: DeliveryItemDto[];
}

export class UpdateDeliveryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() personnelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['low', 'normal', 'medium', 'high', 'urgent'] as DeliveryPriority[]) priority?: DeliveryPriority;
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

export class CaptureSignatureDto {
  @ApiProperty() @IsString() signatureImage!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() signerName?: string;
}

export class ConfirmDeliveryItemDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumberString() deliveredQty!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() returnedQty?: string;
}

export class ConfirmDeliveryDto {
  @ApiPropertyOptional() @IsOptional() customerVerified?: boolean;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => ConfirmDeliveryItemDto) deliveredItems!: ConfirmDeliveryItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
