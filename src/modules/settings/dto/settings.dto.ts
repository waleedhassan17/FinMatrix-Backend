import {
  IsString,
  IsOptional,
  IsInt,
  IsObject,
  IsIn,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  AGING_PRESETS,
  MAX_BOUNDARIES,
  type AgingPresetKey,
} from '../../reports/aging-buckets';

const PRESET_KEYS: AgingPresetKey[] = [
  ...(Object.keys(AGING_PRESETS) as Exclude<AgingPresetKey, 'custom'>[]),
  'custom',
];

/**
 * The company's default A/R and A/P aging buckets.
 *
 * Validated to the same rules the report query takes, so a preference that
 * would be rejected as a query cannot be stored as a default. ReportsService
 * still treats a stored value defensively — a row written before these rules
 * existed, or edited in the database by hand, falls back to 30/60/90 rather
 * than making the report unopenable.
 */
export class AgingPreferenceDto {
  @ApiPropertyOptional({ enum: PRESET_KEYS })
  @IsOptional()
  @IsIn(PRESET_KEYS, { message: `preset must be one of: ${PRESET_KEYS.join(', ')}` })
  preset?: AgingPresetKey;

  @ApiPropertyOptional({
    example: '3,6,9,12',
    description: `Ascending upper bounds in days overdue, at most ${MAX_BOUNDARIES}.`,
  })
  @IsOptional()
  @IsString()
  @Matches(/^\s*\d{1,4}\s*(,\s*\d{1,4}\s*)*,?\s*$/, {
    message: 'buckets must be a comma-separated list of whole days, e.g. 3,6,9,12',
  })
  buckets?: string;
}

export class ReportPreferencesDto {
  @ApiPropertyOptional({ type: AgingPreferenceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AgingPreferenceDto)
  aging?: AgingPreferenceDto;
}

export class UpdateSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 10) fiscalYearStart?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 3) defaultCurrency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 32) taxIdLabel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 16) invoicePrefix?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() invoiceStartNumber?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 32) dateFormat?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() features?: Record<string, unknown>;

  @ApiPropertyOptional({ type: ReportPreferencesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportPreferencesDto)
  reportPreferences?: ReportPreferencesDto;
}
