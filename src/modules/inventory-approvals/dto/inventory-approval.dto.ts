import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ============================================================================
//  Legacy DTOs (kept so existing /inventory-approvals routes keep working)
// ============================================================================

class RequestLineDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsNumber() deliveredQty!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() returnedQty?: number;
}

export class CreateInventoryUpdateRequestDto {
  @ApiProperty() @IsUUID() deliveryId!: string;
  @ApiProperty() @IsUUID() personnelId!: string;
  @ApiProperty({ type: [RequestLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequestLineDto)
  lines!: RequestLineDto[];
}

export class ReviewRequestDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsEnum(['approved', 'rejected'])
  action!: 'approved' | 'rejected';

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// ============================================================================
//  Bill-photo capture DTOs (POST /deliveries/:id/bill-photo)
// ============================================================================

export class BillPhotoChangeDto {
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty() @IsString() @Length(1, 200) itemName!: string;
  @ApiProperty() @IsInt() @Min(0) beforeQty!: number;
  @ApiProperty() @IsInt() @Min(0) deliveredQty!: number;
  @ApiProperty() @IsInt() @Min(0) returnedQty!: number;
}

export class SubmitBillPhotoDto {
  @ApiProperty({ description: 'Customer name written on the signed bill.' })
  @IsString()
  @Length(1, 200)
  signedBy!: string;

  @ApiProperty({ enum: ['camera', 'gallery'] })
  @IsEnum(['camera', 'gallery'])
  source!: 'camera' | 'gallery';

  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;

  /**
   * Multipart sends `changes` as a JSON string. The controller parses it
   * and validates the resulting array against BillPhotoChangeDto.
   */
  @ApiProperty({ description: 'JSON-stringified array of BillPhotoChangeDto.' })
  @IsString()
  changes!: string;
}

// ============================================================================
//  Approval / rejection DTOs
// ============================================================================

export class ApproveInventoryUpdateRequestDto {
  @ApiPropertyOptional({ description: 'Optional reviewer comment.' })
  @IsOptional()
  @IsString()
  reviewerComment?: string;
}

export class RejectInventoryUpdateRequestDto {
  @ApiProperty({ description: 'Required reason for rejection (min 5 chars).' })
  @IsString()
  @Length(5, 1000)
  reviewerComment!: string;
}

// ============================================================================
//  Query DTO
// ============================================================================

export class ListInventoryUpdateRequestsQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected', 'all'] })
  @IsOptional()
  @IsEnum(['pending', 'approved', 'rejected', 'all'])
  status?: 'pending' | 'approved' | 'rejected' | 'all';

  @ApiPropertyOptional({ default: 1 }) @IsOptional() page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() pageSize?: number;
}
