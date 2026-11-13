import { IssueOption, IssueSeverity } from './entities/migration-issue.entity';

/**
 * Every code the Migration Center can answer with (§1.8), plus the few the
 * build needed that the list did not name. Both apps map each one to plain
 * English and Urdu; a code not in this list must not be thrown.
 */
export const MIGRATION_CODES = {
  // Batch and transport
  MIGRATION_REQUIRES_EMPTY_BOOKS: 'MIGRATION_REQUIRES_EMPTY_BOOKS',
  MIGRATION_INVALID_TRANSITION: 'MIGRATION_INVALID_TRANSITION',
  MIGRATION_FILE_TOO_LARGE: 'MIGRATION_FILE_TOO_LARGE',
  MIGRATION_FILE_UNREADABLE: 'MIGRATION_FILE_UNREADABLE',
  MIGRATION_UNKNOWN_SHEET: 'MIGRATION_UNKNOWN_SHEET',
  MIGRATION_REQUIRED_COLUMN_MISSING: 'MIGRATION_REQUIRED_COLUMN_MISSING',
  MIGRATION_FEATURE_DISABLED: 'MIGRATION_FEATURE_DISABLED',
  // Values
  AMBIGUOUS_DATE_FORMAT: 'AMBIGUOUS_DATE_FORMAT',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_DATE: 'INVALID_DATE',
  INVALID_VALUE: 'INVALID_VALUE',
  MISSING_REQUIRED_VALUE: 'MISSING_REQUIRED_VALUE',
  MAPPING_UNCONFIRMED: 'MAPPING_UNCONFIRMED',
  // Matching
  DUPLICATE_RECORD: 'DUPLICATE_RECORD',
  UNKNOWN_ACCOUNT: 'UNKNOWN_ACCOUNT',
  UNKNOWN_CUSTOMER: 'UNKNOWN_CUSTOMER',
  UNKNOWN_VENDOR: 'UNKNOWN_VENDOR',
  UNKNOWN_ITEM: 'UNKNOWN_ITEM',
  // Gates
  CHECK_FAILED: 'CHECK_FAILED',
  NOT_SIGNED_OFF: 'NOT_SIGNED_OFF',
  ROLLBACK_BLOCKED: 'ROLLBACK_BLOCKED',
  MIGRATED_DOCUMENT_IMMUTABLE: 'MIGRATED_DOCUMENT_IMMUTABLE',
} as const;

export type MigrationCode =
  (typeof MIGRATION_CODES)[keyof typeof MIGRATION_CODES];

export interface IssueDraft {
  code: MigrationCode;
  severity: IssueSeverity;
  sheet?: string | null;
  rowNumber?: number | null;
  field?: string | null;
  message: string;
  options?: IssueOption[] | null;
}

/** Issues that carry the same (code, sheet, row, field) are one issue. */
export function issueKey(
  i: Pick<IssueDraft, 'code' | 'sheet' | 'rowNumber' | 'field'>,
): string {
  return [i.code, i.sheet ?? '', i.rowNumber ?? '', i.field ?? ''].join('|');
}
