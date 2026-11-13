import { companyForPdf, pdfDate } from '../../../common/pdf/document-pdf.util';
import {
  renderReportPdf,
  ReportPdfModel,
} from '../../../common/pdf/report-table-pdf.util';
import { Company } from '../../companies/entities/company.entity';
import { CertificatePreview } from '../commit/migration-commit.service';

const SOURCE_LABELS: Record<string, string> = {
  finmatrix_template: 'FinMatrix starter workbook',
  generic_spreadsheet: 'Spreadsheet',
  tally: 'TallyPrime',
  peachtree: 'Peachtree / Sage 50',
  quickbooks_online: 'QuickBooks Online',
  xero: 'Xero',
  odoo: 'Odoo',
};

const ENTITY_LABELS: Record<string, string> = {
  accounts: 'Accounts',
  customers: 'Customers',
  vendors: 'Vendors',
  items: 'Items',
  trial_balance: 'Trial balance lines',
  open_invoices: 'Open invoices',
  open_bills: 'Open bills',
  stock: 'Stock lines',
};

/**
 * The reconciliation certificate (§1.7): proof, in one document, that the
 * books brought into FinMatrix agree with the source to the rupee. Every
 * check with its expected, actual and difference; how every source row was
 * treated; every rejected row with its reason; and who signed it off when.
 * A dry run renders the same document stamped PREVIEW.
 */
export function renderCertificatePdf(input: {
  company: Company;
  preview: CertificatePreview;
  signedOff: { name: string; at: Date } | null;
  committedAt: Date | null;
}): Promise<Buffer> {
  const { company, preview } = input;
  const pc = companyForPdf(company);
  const isPreview = preview.mode !== 'commit' || !input.committedAt;
  const model: ReportPdfModel = {
    title: isPreview
      ? 'Migration Certificate (preview)'
      : 'Migration Certificate',
    subtitle: `Opening balances as at ${pdfDate(preview.cutoverDate)}`,
    company: { name: pc.name, lines: [...pc.addressLines, ...pc.contactLines] },
    meta: [
      {
        label: 'Source',
        value: SOURCE_LABELS[preview.sourceSystem] ?? preview.sourceSystem,
      },
      { label: 'Migration', value: preview.batchId.slice(0, 8).toUpperCase() },
      {
        label: 'Result',
        value: preview.allPassed
          ? 'All nine checks passed'
          : 'Checks failing — not importable',
      },
      ...(input.signedOff
        ? [
            {
              label: 'Signed off',
              value: `${input.signedOff.name}, ${pdfDate(input.signedOff.at)}`,
            },
          ]
        : []),
      ...(input.committedAt
        ? [{ label: 'Imported', value: pdfDate(input.committedAt) }]
        : []),
    ],
    sections: [
      {
        heading: 'Reconciliation checks (zero tolerance)',
        columns: [
          { header: 'Check', width: 0.4 },
          { header: 'Expected', width: 0.17, align: 'right' },
          { header: 'Actual', width: 0.17, align: 'right' },
          { header: 'Difference', width: 0.14, align: 'right' },
          { header: 'Result', width: 0.12, align: 'right' },
        ],
        rows: preview.checks.map((c) => [
          c.label,
          c.expected,
          c.actual,
          c.difference,
          c.passed ? 'PASS' : 'FAIL',
        ]),
        note: 'Expected values are computed from the source files; actual values are read back from the posted books. The two are calculated independently.',
      },
      {
        heading: 'Source rows',
        columns: [
          { header: 'Sheet', width: 0.3 },
          { header: 'Rows', width: 0.14, align: 'right' },
          { header: 'Imported', width: 0.14, align: 'right' },
          { header: 'Matched', width: 0.14, align: 'right' },
          { header: 'Rejected', width: 0.14, align: 'right' },
          { header: 'Open', width: 0.14, align: 'right' },
        ],
        rows: preview.rowCounts.map((r) => [
          ENTITY_LABELS[r.entity] ?? r.entity,
          String(r.source),
          String(r.imported),
          String(r.merged),
          String(r.rejected),
          String(r.pending),
        ]),
      },
      {
        heading: `Rejected rows (${preview.rejectedTotal})`,
        columns: [
          { header: 'Sheet', width: 0.25 },
          { header: 'Row', width: 0.1, align: 'right' },
          { header: 'Reason', width: 0.65 },
        ],
        rows: preview.rejectedRows.map((r) => [
          r.sheet,
          String(r.rowNumber),
          r.reason,
        ]),
        note:
          preview.rejectedTotal > preview.rejectedRows.length
            ? `Showing the first ${preview.rejectedRows.length}.`
            : undefined,
      },
      {
        heading: 'Postings',
        columns: [
          { header: 'Reference', width: 0.18 },
          { header: 'What', width: 0.52 },
          { header: 'Lines', width: 0.1, align: 'right' },
          { header: 'Amount', width: 0.2, align: 'right' },
        ],
        rows: preview.postings.map((p) => [
          p.reference,
          p.memo,
          String(p.lines),
          p.total,
        ]),
        note: 'All postings are dated the cutover day and net through Migration Clearing (3950), which ends at zero.',
      },
      ...(preview.spotChecks.length
        ? [
            {
              heading: 'Spot checks',
              columns: [
                { header: 'Party', width: 0.4 },
                { header: 'Docs', width: 0.1, align: 'right' as const },
                { header: 'Source', width: 0.2, align: 'right' as const },
                { header: 'FinMatrix', width: 0.2, align: 'right' as const },
                { header: 'Match', width: 0.1, align: 'right' as const },
              ],
              rows: preview.spotChecks.map((s) => [
                `${s.name} (${s.kind})`,
                String(s.documents),
                s.sourceBalance,
                s.finmatrixBalance,
                s.matches ? 'Yes' : 'No',
              ]),
            },
          ]
        : []),
    ],
    footer: `FinMatrix migration ${preview.batchId} · generated ${pdfDate(preview.generatedAt)}`,
  };
  return renderReportPdf(model);
}
