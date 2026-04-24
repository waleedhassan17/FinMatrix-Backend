import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
