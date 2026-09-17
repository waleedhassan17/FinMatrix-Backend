import {
  IsString,
  IsBoolean,
  IsOptional,
  IsUUID,
  IsEnum,
  IsArray,
  ValidateNested,
  IsNumberString,
  IsNumber,
  IsInt,
  Length,
  Max,
  Min,
} from 'class-validator';
import { CreditOverrideDto } from '../../../common/validation/credit-override.dto';
import { Transform, Type } from 'class-transformer';
import { IsTaxRate } from '../../../common/validation/tax-rate.validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryPriority, DeliveryStatus, DeliveryIssueType } from '../../../types';
import { DELIVERY_PAID_STATUSES, DeliveryPaidStatus } from '../delivery-collection.util';

// Clients send quantities as numbers or numeric strings; normalise before
// validating so '12' passes and '', 'abc', {} all become NaN and fail IsInt
// with a 400 instead of dispatching garbage (or 500ing) downstream.
const toNumberOrNaN = ({ value }: { value: unknown }) =>
  value === undefined || value === null
    ? value
    : typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;

export class DeliveryItemDto {
  @ApiProperty() @IsString() itemId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() itemName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agencyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agencyName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toNumberOrNaN)
  @IsInt({ message: 'quantity must be a whole number of units' })
  @Min(0, { message: 'quantity cannot be negative' })
  quantity?: number;
  // Stock is dispatched in whole units only: zero, negative, and fractional
  // quantities are rejected here so inventory can never go negative or
  // fractional through the delivery flow. (The decorator also keeps the
  // property from being stripped by the whitelist ValidationPipe.)
  @ApiProperty()
  @Transform(toNumberOrNaN)
  @IsInt({ message: 'orderedQty must be a whole number of units' })
  @Min(1, { message: 'orderedQty must be at least 1' })
  orderedQty!: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toNumberOrNaN)
  @IsNumber({}, { message: 'unitPrice must be a number' })
  @Min(0, { message: 'unitPrice cannot be negative' })
  unitPrice?: number;
  @ApiPropertyOptional({ description: 'Sales tax %, flows to the Sales Order / Invoice line' })
  @IsOptional()
  @Transform(toNumberOrNaN)
  @IsNumber({}, { message: 'taxRate must be a number' })
  @IsTaxRate()
  taxRate?: number;
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
  // Manual destination override — used when automatic geocoding fails and
  // the dispatcher supplies the address/pin themselves.
  @ApiPropertyOptional() @IsOptional() @IsString() destAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) destLat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) destLng?: number;
  @ApiPropertyOptional({
    description:
      'Customer paid the whole order before dispatch. Same as advanceAmount = the order total (tax included). ' +
      'Staff: the delivery is sent to the owner for approval.',
  })
  @IsOptional() @IsBoolean() prePaid?: boolean;

  @ApiPropertyOptional({
    example: '3000',
    description:
      'Paid before dispatch, fully or in part — recorded now as a cash receipt held in Customer Advances ' +
      'and applied to the invoice when the delivery is approved. The rider collects only the balance. ' +
      'Staff: the delivery is sent to the owner for approval.',
  })
  @IsOptional() @IsNumberString({}, { message: 'advanceAmount must be a number' }) advanceAmount?: string;
  @ApiProperty() @IsArray() @ValidateNested({ each: true }) @Type(() => DeliveryItemDto) items!: DeliveryItemDto[];

  @ApiPropertyOptional({
    type: CreditOverrideDto,
    description: "Owner only: let this go past the customer's credit limit, with a reason (audited).",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreditOverrideDto)
  creditOverride?: CreditOverrideDto;
}

export class UpdateDeliveryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() personnelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(['low', 'normal', 'medium', 'high', 'urgent'] as DeliveryPriority[]) priority?: DeliveryPriority;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredTimeSlot?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() destAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) destLat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) destLng?: number;

  @ApiPropertyOptional({
    type: CreditOverrideDto,
    description: "Owner only: let this go past the customer's credit limit, with a reason (audited).",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreditOverrideDto)
  creditOverride?: CreditOverrideDto;
}

export class DeliveryStatusUpdateDto {
  @ApiProperty() @IsEnum([
    'unassigned', 'pending', 'picked_up', 'in_transit', 'arrived', 'delivered', 'failed', 'returned', 'cancelled',
  ] as DeliveryStatus[]) status!: DeliveryStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() location?: { lat: number; lng: number };
  @ApiPropertyOptional({
    enum: DELIVERY_PAID_STATUSES,
    description:
      "Rider's payment answer, when it is settled at the same moment the delivery " +
      'is marked delivered rather than at bill-photo capture. Posts NOTHING — ' +
      'approval records the cash. Ignored when nothing is due (prepaid).',
  })
  @IsOptional() @IsEnum(DELIVERY_PAID_STATUSES) paidStatus?: DeliveryPaidStatus;
  @ApiPropertyOptional({ example: '500', description: "Cash received, required when paidStatus is 'partial'." })
  @IsOptional() @IsNumberString() amountCollected?: string;
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
  // Optional: when omitted, every line is treated as fully delivered.
  @ApiPropertyOptional({ type: [ConfirmDeliveryItemDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ConfirmDeliveryItemDto) deliveredItems?: ConfirmDeliveryItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() verifiedBy?: string;
  @ApiPropertyOptional({
    enum: DELIVERY_PAID_STATUSES,
    description:
      "Rider's payment answer. Posts NOTHING — approval records the cash. Ignored when nothing is due (prepaid).",
  })
  @IsOptional() @IsEnum(DELIVERY_PAID_STATUSES) paidStatus?: DeliveryPaidStatus;
  @ApiPropertyOptional({ example: '500', description: "Cash received, required when paidStatus is 'partial'." })
  @IsOptional() @IsNumberString() amountCollected?: string;
}
