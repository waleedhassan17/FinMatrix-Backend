import Decimal from 'decimal.js';
import { backupFileName, buildManifest, money2, slugify } from './manifest';

describe('manifest', () => {
  it('writes every amount with two decimals, through Decimal', () => {
    expect(money2(1234.5)).toBe('1234.50');
    expect(money2('1234.5678')).toBe('1234.57');
    expect(money2(new Decimal('0.005'))).toBe('0.01');
    expect(money2(0.1 + 0.2)).toBe('0.30');
    expect(money2(-15)).toBe('-15.00');
  });

  it('builds the documented shape with per-file checksums and the TB', () => {
    const m = buildManifest({
      backendCommit: 'abc123',
      company: {
        id: 'c1',
        name: 'Al-Noor Traders',
        currency: 'PKR',
        fiscalYearStart: '2026-07-01',
      },
      exportedAt: new Date(Date.UTC(2026, 10, 12, 8, 0, 0)),
      exportedBy: { userId: 'u1', name: 'Owner' },
      asOf: '2026-11-12',
      includeXlsx: true,
      entities: { invoices: { rows: 3, sha256: 'deadbeef' } },
      trialBalance: {
        totalDebits: 1000,
        totalCredits: 1000,
        rows: [
          { accountCode: '1000', accountName: 'Cash', debit: 1000, credit: 0 },
          {
            accountCode: '3000',
            accountName: 'Equity',
            debit: 0,
            credit: 1000,
          },
        ],
      },
      reports: ['reports/trial-balance.pdf'],
      attachments: { included: 2, missing: 0 },
    });
    expect(m.format).toBe('finmatrix-backup');
    expect(m.formatVersion).toBe(1);
    expect(m.app).toEqual({ backendCommit: 'abc123' });
    expect(m.exportedAt).toBe('2026-11-12T08:00:00.000Z');
    expect(m.entities.invoices).toEqual({ rows: 3, sha256: 'deadbeef' });
    expect(m.contents.data).toEqual(['data/invoices.csv']);
    expect(m.contents.workbook).toBe('FinMatrix-Export.xlsx');
    expect(m.trialBalance.totalDebits).toBe('1000.00');
    expect(m.trialBalance.accounts).toEqual([
      {
        number: '1000',
        name: 'Cash',
        debit: '1000.00',
        credit: '0.00',
        balance: '1000.00',
      },
      {
        number: '3000',
        name: 'Equity',
        debit: '0.00',
        credit: '1000.00',
        balance: '-1000.00',
      },
    ]);
  });

  it('names the file after an ASCII slug of the company and the as-of day', () => {
    expect(slugify('Al-Noor Traders (Pvt) Ltd.')).toBe(
      'Al-Noor-Traders-Pvt-Ltd',
    );
    expect(slugify('  Café  Déjà Vu ')).toBe('Cafe-Deja-Vu');
    expect(slugify('گلیکسی ٹریڈرز')).toBe('company');
    expect(backupFileName('Al-Noor Traders', '2026-11-12')).toBe(
      'FinMatrix-Backup-Al-Noor-Traders-2026-11-12.zip',
    );
  });
});
