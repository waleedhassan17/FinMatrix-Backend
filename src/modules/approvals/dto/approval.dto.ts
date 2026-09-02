import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { APPROVAL_TYPES, ApprovalType } from '../entities/approval-request.entity';

export const APPROVAL_LIST_FILTERS = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'all',
] as const;
export type ApprovalListFilter = (typeof APPROVAL_LIST_FILTERS)[number];

export class ListApprovalsQueryDto {
  @ApiPropertyOptional({ enum: APPROVAL_LIST_FILTERS, default: 'pending' })
  @IsOptional()
  @IsIn(APPROVAL_LIST_FILTERS)
  status?: ApprovalListFilter;

  @ApiPropertyOptional({ enum: APPROVAL_TYPES })
  @IsOptional()
  @IsIn(APPROVAL_TYPES)
  type?: ApprovalType;
}

export class DecideApprovalDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  /**
   * Required when rejecting: a request turned down without a reason leaves the
   * staff member with no idea what to do differently. Optional on approve.
   */
  @ApiPropertyOptional({ example: 'Duplicate of the adjustment posted on Monday.' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  comment?: string;
}
