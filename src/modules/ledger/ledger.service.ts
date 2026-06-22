import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => parseFloat(v ?? '0') || 0;

interface RawLine {
  date: string;
  reference: string;
  accountCode: string;
  accountName: string;
  memo: string;
  debit: number;
  credit: number;
  sourceType: string;
  sourceId: string;
}

// Standard accounts the derived ledger posts against.
const ACC = {
  CASH: { code: '1000', name: 'Cash & Bank' },
  AR: { code: '1100', name: 'Accounts Receivable' },
  AP: { code: '2000', name: 'Accounts Payable' },
  TAX: { code: '2100', name: 'Sales Tax Payable' },
  REVENUE: { code: '4000', name: 'Sales Revenue' },
  EXPENSE: { code: '5000', name: 'Cost of Goods Sold & Expenses' },
};

@Injectable()
export class LedgerService {
  constructor(private readonly dataSource: DataSource) {}

  /** Synthesize double-entry ledger lines from posted documents. */
  private async buildLines(companyId: string, s: string, e: string): Promise<RawLine[]> {
    const lines: RawLine[] = [];

    const invoices = await this.dataSource.query(
      `SELECT id, invoice_number ref, invoice_date d, total, tax_amount tax, subtotal, discount_amount disc
       FROM invoices WHERE company_id=$1 AND status NOT IN ('void','draft') AND invoice_date BETWEEN $2 AND $3`,
      [companyId, s, e]);
    for (const i of invoices) {
      const net = num(i.subtotal) - num(i.disc);
      lines.push(mk(i.d, i.ref, ACC.AR, `Invoice ${i.ref}`, num(i.total), 0, 'invoice', i.id));
      lines.push(mk(i.d, i.ref, ACC.REVENUE, `Invoice ${i.ref}`, 0, net, 'invoice', i.id));
      if (num(i.tax) > 0) lines.push(mk(i.d, i.ref, ACC.TAX, `Invoice ${i.ref} tax`, 0, num(i.tax), 'invoice', i.id));
    }

    const bills = await this.dataSource.query(
      `SELECT id, bill_number ref, bill_date d, total FROM bills
       WHERE company_id=$1 AND status NOT IN ('void','draft') AND bill_date BETWEEN $2 AND $3`,
      [companyId, s, e]);
    for (const b of bills) {
      lines.push(mk(b.d, b.ref, ACC.EXPENSE, `Bill ${b.ref}`, num(b.total), 0, 'bill', b.id));
      lines.push(mk(b.d, b.ref, ACC.AP, `Bill ${b.ref}`, 0, num(b.total), 'bill', b.id));
    }

    const pays = await this.dataSource.query(
      `SELECT id, payment_date d, amount, reference ref FROM payments
       WHERE company_id=$1 AND payment_date BETWEEN $2 AND $3`, [companyId, s, e]).catch(() => []);
    for (const p of pays) {
      const ref = p.ref || 'Payment';
      lines.push(mk(p.d, ref, ACC.CASH, `Customer payment`, num(p.amount), 0, 'payment', p.id));
      lines.push(mk(p.d, ref, ACC.AR, `Customer payment`, 0, num(p.amount), 'payment', p.id));
    }

    const billPays = await this.dataSource.query(
      `SELECT id, payment_date d, total_amount amount, reference ref FROM bill_payments
       WHERE company_id=$1 AND payment_date BETWEEN $2 AND $3`, [companyId, s, e]).catch(() => []);
    for (const p of billPays) {
      const ref = p.ref || 'Bill payment';
      lines.push(mk(p.d, ref, ACC.AP, `Bill payment`, num(p.amount), 0, 'bill_payment', p.id));
      lines.push(mk(p.d, ref, ACC.CASH, `Bill payment`, 0, num(p.amount), 'bill_payment', p.id));
    }

    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return lines;
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

function mk(
  date: string,
  reference: string,
  acc: { code: string; name: string },
  memo: string,
  debit: number,
  credit: number,
  sourceType: string,
  sourceId: string,
): RawLine {
  return { date, reference, accountCode: acc.code, accountName: acc.name, memo, debit, credit, sourceType, sourceId };
}
