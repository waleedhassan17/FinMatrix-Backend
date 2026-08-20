import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class JournalLineDto {
  @ApiProperty() @IsUUID() accountId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ example: '100.0000' }) @IsNumberString() debit!: string;
  @ApiProperty({ example: '0.0000' }) @IsNumberString() credit!: string;
  @ApiPropertyOptional() @IsOptional() lineOrder?: number;
}

export class CreateJournalEntryDto {
  @ApiProperty({ example: '2026-04-23' }) @IsDateString() date!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;

  @ApiPropertyOptional({ enum: ['draft', 'posted'], default: 'draft' })
  @IsOptional()
  @IsIn(['draft', 'posted'])
  status?: 'draft' | 'posted';

  @ApiProperty({ type: [JournalLineDto] })
  @IsArray()
  @ArrayMinSize(2, { message: 'Journal entry must have at least 2 lines' })
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];

  /**
   * Marks this as the company's opening entry, which stamps its GL rows with
   * source_type='opening_balance'.
   *
   * A boolean rather than a free-text sourceType on purpose: the guided
   * Opening Balances screen needs exactly this one classification, and the
   * dashboard's setup checklist looks for it, but letting clients write an
   * arbitrary source_type would let anything pollute the GL taxonomy that
   * reports and reconciliation read.
   */
  @ApiPropertyOptional({
    description:
      "Tag this entry as the company's opening balances (source_type=opening_balance).",
  })
  @IsOptional()
  @IsBoolean()
  isOpeningBalance?: boolean;
}

export class UpdateJournalEntryDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() memo?: string;

  @ApiPropertyOptional({ type: [JournalLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines?: JournalLineDto[];
}

export class VoidJournalEntryDto {
  @ApiProperty({ example: 'Duplicate entry, reversing' })
  @IsString()
  reason!: string;
}

export class ListJournalEntriesQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'posted', 'void'] })
  @IsOptional()
  @IsIn(['draft', 'posted', 'void'])
  status?: 'draft' | 'posted' | 'void';

  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}
