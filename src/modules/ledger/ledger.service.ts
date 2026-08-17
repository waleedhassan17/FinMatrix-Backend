import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => parseFloat(v ?? '0') || 0;

interface RawLine {
  date: string;
  postedAt: string;
  reference: string;
  accountCode: string;
  accountName: string;
  memo: string;
  debit: number;
  credit: number;
  sourceType: string;
  sourceId: string;
}

@Injectable()
export class LedgerService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The general ledger, read from the ledger.
   *
   * This used to SYNTHESIZE entries from documents: it selected invoices,
   * bills and payments and invented a two-line entry for each against six
   * hardcoded "standard accounts" — every bill was reported as
   * DR 5000 Cost of Goods Sold, whatever had actually been posted. So a bill
   * that correctly cleared GRNI (DR 2050 / CR 2000) appeared in the general
   * ledger as an expense, and entries that are not invoice/bill/payment —
   * goods receipts, inventory adjustments, opening stock, reversals of deleted
   * documents, and every manual journal entry — did not appear at all. A
   * report that contradicts the book of record is worse than no report.
   *
   * It now reads journal_entry_lines joined to their accounts, so it shows the
   * entries that exist, with the account each one really hit.
   */
  private async buildLines(companyId: string, s: string, e: string): Promise<RawLine[]> {
    const rows = await this.dataSource.query(
      `SELECT je.date::text                                   AS date,
              je.created_at                                   AS "postedAt",
              je.reference                                    AS reference,
              COALESCE(NULLIF(l.description, ''), je.memo, '') AS memo,
              a.account_number                                AS "accountCode",
              a.name                                          AS "accountName",
              l.debit                                         AS debit,
              l.credit                                        AS credit,
              je.id                                           AS "entryId"
         FROM journal_entry_lines l
         JOIN journal_entries je ON je.id = l.entry_id
         JOIN accounts a        ON a.id = l.account_id
        WHERE je.company_id = $1
          AND je.status = 'posted'
          AND je.date BETWEEN $2 AND $3
        ORDER BY je.date ASC, je.created_at ASC, l.line_order ASC`,
      [companyId, s, e],
    );

    return rows.map((r: any) => ({
      date: r.date,
      // The posting date is the accounting date and is a DATE column, so it
      // carries no time. created_at is when the entry was actually recorded —
      // that is the timestamp an audit trail needs.
      postedAt: r.postedAt instanceof Date ? r.postedAt.toISOString() : String(r.postedAt ?? ''),
      reference: r.reference ?? '',
      accountCode: r.accountCode ?? '',
      accountName: r.accountName ?? '',
      memo: r.memo ?? '',
      debit: num(r.debit),
      credit: num(r.credit),
      sourceType: 'journal_entry',
      sourceId: r.entryId,
    }));
  }

  /** Chronological ledger, optionally filtered to a single account code. */
  async query(companyId: string, startDate?: string, endDate?: string, accountCode?: string) {
    const s = startDate || '1970-01-01';
    const e = endDate || new Date().toISOString().slice(0, 10);
    let lines = await this.buildLines(companyId, s, e);
    if (accountCode) lines = lines.filter((l) => l.accountCode === accountCode);

    // Running balance per account (debit positive).
    const runningByAccount = new Map<string, number>();
    const entries = lines.map((l) => {
      const prev = runningByAccount.get(l.accountCode) ?? 0;
      const balance = r2(prev + l.debit - l.credit);
      runningByAccount.set(l.accountCode, balance);
      return {
        date: l.date,
        postedAt: l.postedAt,
        reference: l.reference,
        accountCode: l.accountCode,
        accountName: l.accountName,
        memo: l.memo,
        debit: r2(l.debit),
        credit: r2(l.credit),
        balance,
        sourceType: l.sourceType,
        sourceId: l.sourceId,
      };
    });

    const totals = entries.reduce((t, x) => ({ debit: t.debit + x.debit, credit: t.credit + x.credit }), { debit: 0, credit: 0 });
    return {
      range: { startDate: s, endDate: e },
      accountCode: accountCode ?? null,
      entries,
      totals: { debit: r2(totals.debit), credit: r2(totals.credit) },
    };
  }

  /** Per-account roll-up for drill-down ("investigate account balance"). */
  async accounts(companyId: string, startDate?: string, endDate?: string) {
    const s = startDate || '1970-01-01';
    const e = endDate || new Date().toISOString().slice(0, 10);
    const lines = await this.buildLines(companyId, s, e);
    const map = new Map<string, { accountCode: string; accountName: string; debit: number; credit: number; entries: number }>();
    for (const l of lines) {
      if (!map.has(l.accountCode)) map.set(l.accountCode, { accountCode: l.accountCode, accountName: l.accountName, debit: 0, credit: 0, entries: 0 });
      const a = map.get(l.accountCode)!;
      a.debit += l.debit;
      a.credit += l.credit;
      a.entries += 1;
    }
    const accounts = Array.from(map.values())
      .map((a) => ({ ...a, debit: r2(a.debit), credit: r2(a.credit), balance: r2(a.debit - a.credit) }))
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return { range: { startDate: s, endDate: e }, accounts };
  }
}
