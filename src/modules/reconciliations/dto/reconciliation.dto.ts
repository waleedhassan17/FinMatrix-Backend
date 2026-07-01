import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class UnreconciledQueryDto {
  @ApiProperty({ description: 'Bank/cash account to reconcile.' })
  @IsUUID()
  accountId!: string;

  @ApiPropertyOptional({
    example: '2026-06-30',
    description: 'Only include entries dated on/before the statement date.',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class ListReconciliationsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class CreateReconciliationDto {
  @ApiProperty()
  @IsUUID()
  accountId!: string;

  @ApiProperty({ example: '2026-06-30' })
  @IsDateString()
  statementDate!: string;

  @ApiProperty({ example: '15250.00', description: "Statement's ending balance." })
  @IsNumberString()
  statementEndingBalance!: string;

  @ApiProperty({
    type: [String],
    description: 'IDs of the GL entries that appear as cleared on the statement.',
  })
  @IsArray()
  @ArrayMinSize(0)
  @IsUUID('all', { each: true })
  clearedEntryIds!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
