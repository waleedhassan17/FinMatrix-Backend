import { readinessOf } from '../analysis/migration-analysis.service';
import { subTypeFor } from '../commit/migration-commit.service';
import { renderCertificatePdf } from '../certificate/certificate-pdf';
import { CHECK_CODES, CHECK_LABELS } from './migration-checks.service';

const counts = (
  rows: Record<string, [number, number, number, number, number]>,
  mappings: [number, number],
) => ({
  rows: Object.fromEntries(
    Object.entries(rows).map(
      ([k, [source, imported, merged, rejected, pending]]) => [
        k,
        { source, imported, merged, rejected, pending },
      ],
    ),
  ),
  issues: { blocking: 0, warning: 0, resolved: 0 },
  mappings: { total: mappings[0], confident: mappings[1] },
});

describe('readinessOf', () => {
  const allPass = CHECK_CODES.map(() => ({ passed: true }));

  it('is 100 only when every row is decided, every mapping confident and all nine checks pass', () => {
    expect(
      readinessOf(counts({ customers: [4, 4, 0, 0, 0] }, [10, 10]), allPass),
    ).toBe(100);
    expect(
      readinessOf(counts({ customers: [4, 3, 0, 0, 1] }, [10, 10]), allPass),
    ).toBeLessThan(100);
    expect(
      readinessOf(counts({ customers: [4, 4, 0, 0, 0] }, [10, 9]), allPass),
    ).toBeLessThan(100);
    expect(
      readinessOf(
        counts({ customers: [4, 4, 0, 0, 0] }, [10, 10]),
        allPass.map((c, i) => ({ passed: i !== 3 })),
      ),
    ).toBeLessThan(100);
  });

  it('counts unrun checks as not passed and floors the percentage', () => {
    // 4 rows + 10 mappings decided, 0 of the checks → 14 / (14 + checks), floored
    expect(
      readinessOf(counts({ customers: [4, 4, 0, 0, 0] }, [10, 10]), null),
    ).toBe(Math.floor((14 / (14 + CHECK_CODES.length)) * 100));
    expect(CHECK_CODES.length).toBe(10);
    // Rejected and merged rows are decided rows.
    expect(
      readinessOf(counts({ customers: [4, 1, 2, 1, 0] }, [0, 0]), allPass),
    ).toBe(100);
  });
});

describe('subTypeFor', () => {
  it('keeps a valid kind, matches loosely, and falls back to the type catch-all', () => {
    expect(subTypeFor('asset', 'Bank')).toBe('Bank');
    expect(subTypeFor('asset', 'fixed asset')).toBe('Fixed Asset');
    expect(subTypeFor('liability', 'Notes Payable')).toBe('Notes Payable');
    expect(subTypeFor('asset', 'Debtors')).toBe('Other Asset');
    expect(subTypeFor('revenue', null)).toBe('Sales');
    expect(subTypeFor('expense', '')).toBe('Operating');
    expect(subTypeFor('equity', 'Capital')).toBe('Other Equity');
  });
});

describe('renderCertificatePdf', () => {
  it('renders every check and row count into a PDF', async () => {
    const pdf = await renderCertificatePdf({
      company: {
        name: 'Al-Noor Traders',
        address: null,
        phone: null,
        email: null,
      } as never,
      preview: {
        batchId: '11111111-2222-4333-8444-555555555555',
        companyName: 'Al-Noor Traders',
        sourceSystem: 'finmatrix_template',
        cutoverDate: '2026-06-30',
        generatedAt: '2026-11-13T00:00:00.000Z',
        mode: 'commit',
        checks: CHECK_CODES.map((code) => ({
          code,
          label: CHECK_LABELS[code],
          expected: '0.00',
          actual: '0.00',
          difference: '0.00',
          passed: true,
          details: [],
        })),
        allPassed: true,
        rowCounts: [
          {
            entity: 'customers',
            source: 4,
            imported: 4,
            merged: 0,
            rejected: 0,
            pending: 0,
          },
        ],
        rejectedRows: [
          {
            sheet: 'Trial Balance',
            rowNumber: 14,
            reason: 'A total line, not a record',
          },
        ],
        rejectedTotal: 1,
        spotChecks: [
          {
            kind: 'customer',
            name: 'Al-Noor Traders',
            documents: 2,
            asTyped: [],
            sourceBalance: '165000.00',
            finmatrixBalance: '165000.00',
            matches: true,
          },
        ],
        postings: [
          {
            reference: 'JE-001',
            memo: 'Migration: trial balance',
            lines: 9,
            total: '1092500.50',
          },
        ],
        created: { customers: 4 },
      },
      signedOff: { name: 'Owner', at: new Date('2026-11-13T00:00:00Z') },
      committedAt: new Date('2026-11-13T00:00:00Z'),
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(2000);
  });
});
