import { Injectable, PipeTransform } from '@nestjs/common';

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parses ?page= and ?limit= query params into a clamped PaginationParams object.
 * Apply via @Query(ParsePaginationPipe) in controllers that expect pagination.
 */
@Injectable()
export class ParsePaginationPipe
  implements PipeTransform<Record<string, unknown>, PaginationParams>
{
  transform(value: Record<string, unknown> | undefined): PaginationParams {
    const raw = value ?? {};
    const pageParsed = parseInt(String(raw.page ?? '1'), 10);
    const limitParsed = parseInt(String(raw.limit ?? DEFAULT_LIMIT), 10);

    const page = Number.isFinite(pageParsed) && pageParsed > 0 ? pageParsed : 1;
    const limitClamped = Number.isFinite(limitParsed) && limitParsed > 0
      ? Math.min(limitParsed, MAX_LIMIT)
      : DEFAULT_LIMIT;

    return {
      page,
      limit: limitClamped,
      skip: (page - 1) * limitClamped,
    };
  }
}
