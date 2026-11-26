import * as Sentry from '@sentry/nestjs';

/**
 * Report a Migration Center or backup failure to Sentry (a no-op without
 * SENTRY_DSN) with what support needs to find it — the area, the batch or
 * export id, an error code — and NOTHING from the customer's files: no file
 * contents, no row values, no amounts. The message is cut to its first line
 * and 200 characters, and figures in it are masked, so a value quoted inside
 * an error never travels.
 */
export function reportFailure(input: {
  area: 'migration' | 'export';
  id: string;
  companyId?: string | null;
  code?: string | null;
  error: unknown;
}): void {
  try {
    Sentry.withScope((scope) => {
      scope.setTag('area', input.area);
      scope.setTag(
        input.area === 'migration' ? 'batch_id' : 'export_id',
        input.id,
      );
      if (input.code) scope.setTag('code', input.code);
      if (input.companyId) scope.setTag('company_id', input.companyId);
      Sentry.captureException(
        new Error(`${input.area} failure: ${safeMessage(input.error)}`),
      );
    });
  } catch {
    // monitoring must never break the work it reports on
  }
}

/** First line, 200 characters, figures masked ("Rs 1,20,000" → "Rs #"). */
export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (raw.split('\n')[0] ?? '').slice(0, 200).replace(/\d[\d,.]{2,}/g, '#');
}
