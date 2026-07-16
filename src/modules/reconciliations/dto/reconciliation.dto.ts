import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
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

export class ClearedMarkDto {
  @ApiProperty({ description: 'GL entry id.' })
  @IsUUID()
  entryId!: string;

  @ApiProperty({ description: 'Ticked (true) or unticked (false).' })
  @IsBoolean()
  cleared!: boolean;
}

/**
 * Save-and-resume (bankreconcillation.md behavior 11): persists the in-progress
 * cleared ticks on the GL rows themselves so exiting mid-reconciliation loses
 * nothing. Only UNRECONCILED rows of the given Cash/Bank account are touched.
 */
export class MarkClearedDto {
  @ApiProperty()
  @IsUUID()
  accountId!: string;

  @ApiProperty({ type: [ClearedMarkDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ClearedMarkDto)
  marks!: ClearedMarkDto[];
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
