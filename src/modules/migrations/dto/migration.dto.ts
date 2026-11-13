import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MIGRATION_SOURCE_SYSTEMS,
  MigrationSourceSystem,
} from '../entities/migration-batch.entity';

export class CreateMigrationDto {
  @ApiProperty({ enum: MIGRATION_SOURCE_SYSTEMS })
  @IsIn(MIGRATION_SOURCE_SYSTEMS)
  sourceSystem!: MigrationSourceSystem;

  @ApiProperty({
    example: '2026-06-30',
    description: 'Every migration posting is dated this day.',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cutoverDate!: string;
}

export class MappingPatchItemDto {
  @ApiProperty({
    enum: ['sheet', 'column', 'value', 'account', 'match', 'cell', 'skip'],
  })
  @IsIn(['sheet', 'column', 'value', 'account', 'match', 'cell', 'skip'])
  kind!: 'sheet' | 'column' | 'value' | 'account' | 'match' | 'cell' | 'skip';

  @ApiPropertyOptional({
    description:
      'Source sheet name the mapping belongs to; blank for account mappings.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sheet?: string;

  @ApiProperty({
    description:
      'Source side: a sheet name, header, `field::value`, account number, …',
  })
  @IsString()
  @MaxLength(255)
  source!: string;

  @ApiPropertyOptional({ description: 'Target side; null clears the mapping.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  target?: string | null;
}

export class PatchMappingsDto {
  @ApiProperty({ type: [MappingPatchItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MappingPatchItemDto)
  mappings!: MappingPatchItemDto[];
}

export class ResolveIssueDto {
  @ApiProperty({ enum: ['edit', 'map', 'skip'] })
  @IsIn(['edit', 'map', 'skip'])
  action!: 'edit' | 'map' | 'skip';

  @ApiPropertyOptional({
    description: 'The new value (edit), or the chosen option (map).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  value?: string;

  @ApiPropertyOptional({
    description: 'Why a row is skipped; required for skip.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Apply the same resolution to every issue with the same code and value in this file.',
  })
  @IsOptional()
  @IsBoolean()
  applyToAll?: boolean;
}

export class SignOffDto {
  @ApiProperty()
  @IsBoolean()
  confirmed!: boolean;

  @ApiProperty()
  @IsBoolean()
  spotCheckDone!: boolean;
}

export class IssuesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ enum: ['blocking', 'warning'] })
  @IsOptional()
  @IsIn(['blocking', 'warning'])
  severity?: 'blocking' | 'warning';

  @ApiPropertyOptional({ enum: ['open', 'resolved', 'all'], default: 'open' })
  @IsOptional()
  @IsIn(['open', 'resolved', 'all'])
  state?: 'open' | 'resolved' | 'all';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
