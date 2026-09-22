import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

import { AgingQueryDto } from './aging-query.dto';

/**
 * The query for one party's open documents behind an aging row.
 *
 * It extends `AgingQueryDto` rather than declaring its own preset/buckets pair,
 * and that inheritance is the point: the drill-down has to be bucketed by the
 * SAME spec as the report above it. Resolve a different one and every
 * `bucketLabel` in the detail disagrees with the column the user clicked —
 * silently, because both numbers are individually correct.
 *
 * `format` comes along from the parent and is ignored. There is no CSV of a
 * paginated drill-down, the same call `profitLossLineEntries` makes.
 *
 * `asOfDate` is deliberately absent, as it is on the parent. See the note there.
 */
export class AgingDetailQueryDto extends AgingQueryDto {
  @ApiPropertyOptional({
    example: 'd31to60',
    description:
      'Restrict to one bucket, by its key from the report payload. Omit for ' +
      'every open document. Keys are `current`, `d{min}to{max}` and `d{n}plus`.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]{1,32}$/, {
    message: 'bucket must be a bucket key from the report, e.g. d31to60',
  })
  bucket?: string;
}
