import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import {
  AGING_PRESETS,
  MAX_BOUNDARIES,
  type AgingPresetKey,
} from '../aging-buckets';

const PRESET_KEYS: AgingPresetKey[] = [
  ...(Object.keys(AGING_PRESETS) as Exclude<AgingPresetKey, 'custom'>[]),
  'custom',
];

/**
 * The first DTO in the reports module.
 *
 * Every other reports endpoint takes raw `@Query('x') x: string` and the
 * service never throws — a bad input degrades to zeroes. That is the right
 * shape for a date range, where "all time" is a sane reading of nothing. It is
 * the wrong shape for a bucket spec: "3,-1,abc" has no sane reading, and
 * silently falling back to 30/60/90 would show the user a report that is not
 * the one they asked for, with no indication of it.
 */
export class AgingQueryDto {
  @ApiPropertyOptional({
    enum: PRESET_KEYS,
    description:
      'Bucket scheme. Omit to use the company default, or 30/60/90 if none is saved.',
  })
  @IsOptional()
  @IsIn(PRESET_KEYS, {
    message: `preset must be one of: ${PRESET_KEYS.join(', ')}`,
  })
  preset?: AgingPresetKey;

  @ApiPropertyOptional({
    example: '3,6,9,12',
    description:
      `Ascending upper bounds in days overdue, at most ${MAX_BOUNDARIES}. ` +
      'The trailing open-ended bucket is implied. Required when preset=custom.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\s*\d{1,4}\s*(,\s*\d{1,4}\s*)*,?\s*$/, {
    message:
      'buckets must be a comma-separated list of whole days, e.g. 3,6,9,12',
  })
  buckets?: string;

  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json' })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: string;
}

/**
 * The unified /reports/aging route, which picks its side with `type`.
 *
 * `asOfDate` used to sit here and was accepted, documented and then discarded
 * by the service — the report always aged against "now". It is gone rather
 * than implemented: true as-of aging needs each document's balance
 * reconstructed from payment history, and `invoices.balance` only ever holds
 * the current one. Answering with today's balances under yesterday's heading
 * would be a worse lie than not offering the control.
 */
export class UnifiedAgingQueryDto extends AgingQueryDto {
  @ApiPropertyOptional({ enum: ['ar', 'ap'], default: 'ar' })
  @IsOptional()
  @IsIn(['ar', 'ap'], { message: "type must be 'ar' or 'ap'" })
  type?: 'ar' | 'ap';
}
