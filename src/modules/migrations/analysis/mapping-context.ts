import { DateOrder } from '../parsers/date.parser';
import { normalizeKey } from '../parsers/text-normalize';
import { MigrationMapping } from '../entities/migration-mapping.entity';
import { ProfileMappings } from '../entities/migration-profile.entity';

/**
 * Every decision that steers an analysis, from three sources in priority
 * order: what the owner chose in this batch (origin user), what the company
 * confirmed in an earlier migration (profile), and nothing else — the rules
 * and the AI only PROPOSE, and their proposals are recomputed each time.
 *
 * Keys are normalised so a header retyped with different spacing still finds
 * its decision. Kinds beyond the four mapping kinds carry fixes:
 *   match  `${entity}::${normalised name}` → record id | 'create'
 *   cell   `${sheet}::${rowNumber}::${field}` → the value the owner typed
 *   skip   `${sheet}::${rowNumber}` → reason
 *   value  `dateOrder::${field}` (per sheet) → 'dmy' | 'mdy'
 */
export class MappingContext {
  readonly sheet = new Map<string, string>(); // norm sheet name → target key | 'skip'
  readonly column = new Map<string, string>(); // `${sheetKey}::${normHeader}` → field | ''
  readonly value = new Map<string, string>(); // `${field}::${normValue}` → canonical
  readonly dateOrder = new Map<string, DateOrder>(); // `${sheetKey}::${field}`
  readonly cells = new Map<string, string>(); // `${sheetKey}::${row}::${field}`
  readonly skips = new Map<string, string>(); // `${sheetKey}::${row}` → reason
  readonly matches = new Map<string, string>(); // `${entity}::${normName}` → id | 'create'
  readonly accounts = new Map<string, string>(); // source account number (norm) → target number | 'NEW'
  readonly confirmedAccounts = new Set<string>();

  static from(
    userMappings: MigrationMapping[],
    profile: ProfileMappings | null,
  ): MappingContext {
    const ctx = new MappingContext();
    if (profile) {
      for (const [target, cols] of Object.entries(profile.columns ?? {}))
        for (const [header, field] of Object.entries(cols))
          ctx.column.set(`${target}::${header}`, field);
      for (const [k, v] of Object.entries(profile.values ?? {}))
        ctx.value.set(k, v);
      for (const [k, v] of Object.entries(profile.accounts ?? {}))
        ctx.accounts.set(normalizeKey(k), v);
    }
    for (const m of userMappings) {
      const sheetKey = normalizeKey(m.sheet);
      switch (m.kind) {
        case 'sheet':
          ctx.sheet.set(normalizeKey(m.source), m.target ?? 'skip');
          break;
        case 'column':
          ctx.column.set(
            `${sheetKey}::${normalizeKey(m.source)}`,
            m.target ?? '',
          );
          break;
        case 'value':
          if (m.source.startsWith('dateOrder::')) {
            if (m.target === 'dmy' || m.target === 'mdy')
              ctx.dateOrder.set(
                `${sheetKey}::${m.source.slice('dateOrder::'.length)}`,
                m.target,
              );
          } else {
            const [field, ...rest] = m.source.split('::');
            ctx.value.set(
              `${field}::${normalizeKey(rest.join('::'))}`,
              m.target ?? '',
            );
          }
          break;
        case 'account':
          ctx.accounts.set(normalizeKey(m.source), m.target ?? '');
          ctx.confirmedAccounts.add(normalizeKey(m.source));
          break;
        case 'match':
          ctx.matches.set(m.source, m.target ?? '');
          break;
        case 'cell':
          ctx.cells.set(`${sheetKey}::${m.source}`, m.target ?? '');
          break;
        case 'skip':
          ctx.skips.set(
            `${sheetKey}::${m.source}`,
            m.target || 'Skipped by the owner',
          );
          break;
      }
    }
    return ctx;
  }
}
