import Decimal from 'decimal.js';
import { toDecimal } from '../../../common/utils/money.util';

export const BACKUP_FORMAT = 'finmatrix-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface ManifestEntity {
  rows: number;
  sha256: string;
}

export interface ManifestTrialBalanceAccount {
  number: string;
  name: string;
  debit: string;
  credit: string;
  /** debit − credit, signed: positive is a debit balance. */
  balance: string;
}

export interface ManifestInput {
  backendCommit: string;
  company: {
    id: string;
    name: string;
    currency: string;
    fiscalYearStart: string;
  };
  exportedAt: Date;
  exportedBy: { userId: string; name: string };
  asOf: string;
  includeXlsx: boolean;
  entities: Record<string, ManifestEntity>;
  trialBalance: {
    totalDebits: number | string;
    totalCredits: number | string;
    rows: Array<{
      accountCode: string;
      accountName: string;
      debit: number | string;
      credit: number | string;
    }>;
  };
  reports: string[];
  attachments: { included: number; missing: number };
}

/** Manifest amounts are strings with two decimals, via Decimal, never a float. */
export function money2(value: number | string | Decimal): string {
  return toDecimal(value).toFixed(2);
}

/**
 * manifest.json of a backup: what the ZIP holds, who made it and when, a
 * checksum per data file and the trial balance the books footed to at the
 * moment of export — so a reader can prove, without FinMatrix, that the files
 * are complete and that they balance.
 */
export function buildManifest(input: ManifestInput) {
  const accounts: ManifestTrialBalanceAccount[] = input.trialBalance.rows.map(
    (r) => ({
      number: r.accountCode,
      name: r.accountName,
      debit: money2(r.debit),
      credit: money2(r.credit),
      balance: money2(toDecimal(r.debit).minus(toDecimal(r.credit))),
    }),
  );
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: { backendCommit: input.backendCommit },
    company: input.company,
    exportedAt: input.exportedAt.toISOString(),
    exportedBy: input.exportedBy,
    asOf: input.asOf,
    contents: {
      data: Object.keys(input.entities).map((name) => `data/${name}.csv`),
      workbook: input.includeXlsx ? 'FinMatrix-Export.xlsx' : null,
      reports: input.reports,
      attachments: input.attachments,
    },
    entities: input.entities,
    trialBalance: {
      totalDebits: money2(input.trialBalance.totalDebits),
      totalCredits: money2(input.trialBalance.totalCredits),
      accounts,
    },
  };
}

/**
 * The build this backup came from. Set by the deploy (GIT_SHA on ECS, where
 * CI tags the image; SOURCE_VERSION on Heroku), else the package version.
 */
export function backendCommit(): string {
  return (
    process.env.GIT_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.HEROKU_SLUG_COMMIT ||
    `package@${process.env.npm_package_version ?? 'unknown'}`
  );
}

/** `FinMatrix-Backup-<company-slug>-<YYYY-MM-DD>.zip` */
export function backupFileName(companyName: string, asOf: string): string {
  return `FinMatrix-Backup-${slugify(companyName)}-${asOf}.zip`;
}

export function slugify(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return ascii || 'company';
}
