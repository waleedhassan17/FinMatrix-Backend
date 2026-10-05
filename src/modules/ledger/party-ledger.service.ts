import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { businessToday } from '../../common/utils/business-date.util';
import {
  ACCT_AP,
  ACCT_AR,
  ACCT_CUSTOMER_ADVANCES,
} from '../accounts/accounts.constants';
import {
  LedgerPartyType,
  partyOpeningSql,
  partyRowsSql,
} from './party-ledger.sql';

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => parseFloat(String(v ?? '0')) || 0;

/** The control accounts a party's postings sit on. */
const CONTROL_ACCOUNTS: Record<LedgerPartyType, string[]> = {
  customer: [ACCT_AR, ACCT_CUSTOMER_ADVANCES],
  vendor: [ACCT_AP],
};

/** What each kind of posting is called on a ledger line. */
const POSTING_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  invoice_void: 'Invoice voided',
  payment: 'Receipt',
  payment_void: 'Receipt voided',
  payment_application: 'Advance applied',
  payment_application_void: 'Advance application reversed',
  credit_memo: 'Credit memo',
  credit_memo_void: 'Credit memo voided',
  credit_memo_refund: 'Refund',
  delivery_advance: 'Advance received',
  delivery_advance_release: 'Advance applied',
  bill: 'Bill',
  bill_void: 'Bill voided',
  bill_payment: 'Bill payment',
  vendor_credit: 'Vendor credit',
  vendor_credit_void: 'Vendor credit voided',
};

export const postingLabel = (postingType: string): string =>
  POSTING_LABELS[postingType] ??
  (postingType.startsWith('delivery') ? 'Delivery' : 'Posting');

/** One posting on a party's control account. */
export interface PartyLedgerRow {
  id: string;
  date: string;
  postedAt: string;
  reference: string;
  entryId: string | null;
  voided: boolean;
  accountCode: string;
  accountName: string;
  memo: string;
  debit: number;
  credit: number;
  postingType: string;
  sourceId: string;
  documentType: string | null;
  documentId: string | null;
  documentNumber: string | null;
  partyId: string | null;
}

export interface PartyDirectoryEntry {
  id: string;
  code: string | null;
  name: string;
  email: string | null;
  isActive: boolean;
  createdAt: string;
}

/** A period: both ends required by the callers that page through history. */
export interface LedgerRange {
  startDate: string;
  endDate: string;
}

const rangeOf = (startDate?: string, endDate?: string): LedgerRange => ({
  startDate: startDate || '1970-01-01',
  endDate: endDate || businessToday(),
});

/**
 * A customer's or vendor's ledger — the General Ledger's party view.
 *
 * It answers in the General Ledger's own shape (entries with a debit-positive
 * running balance, opening and closing balances, period totals), so a client
 * shows a customer the way it shows an account: one ledger, a different
 * selection. See party-ledger.sql.ts for which postings belong to a party.
 */
@Injectable()
export class PartyLedgerService {
  constructor(private readonly dataSource: DataSource) {}

  /** The ids and names of a party type's control accounts that exist here. */
  async controlAccounts(companyId: string, type: LedgerPartyType) {
    const rows: Array<{ id: string; code: string; name: string }> =
      await this.dataSource.query(
        `SELECT id, account_number AS code, name FROM accounts
        WHERE company_id = $1 AND account_number = ANY($2::text[])
        ORDER BY account_number`,
        [companyId, CONTROL_ACCOUNTS[type]],
      );
    return rows;
  }

  /** Every party of this type, for names, codes and the picker. */
  async directory(
    companyId: string,
    type: LedgerPartyType,
    ids?: string[],
  ): Promise<PartyDirectoryEntry[]> {
    const table = type === 'customer' ? 'customers' : 'vendors';
    const nameColumn = type === 'customer' ? 'name' : 'company_name';
    const rows: any[] = await this.dataSource.query(
      `SELECT id, code, ${nameColumn} AS name, email, is_active AS "isActive",
              created_at AS "createdAt"
         FROM ${table}
        WHERE company_id = $1 ${ids ? 'AND id = ANY($2::uuid[])' : ''}`,
      ids ? [companyId, ids] : [companyId],
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code ?? null,
      name: r.name ?? '',
      email: r.email ?? null,
      isActive: r.isActive !== false,
      createdAt:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : String(r.createdAt ?? ''),
    }));
  }

  /** One party, or a 404 in the party's own words. */
  async party(
    companyId: string,
    type: LedgerPartyType,
    partyId: string,
  ): Promise<PartyDirectoryEntry> {
    const [found] = await this.directory(companyId, type, [partyId]);
    if (!found) {
      throw new NotFoundException({
        code: type === 'customer' ? 'CUSTOMER_NOT_FOUND' : 'VENDOR_NOT_FOUND',
        message: `${type === 'customer' ? 'Customer' : 'Vendor'} not found`,
      });
    }
    return found;
  }

  /**
   * The postings inside a period and every party's balance before it.
   * `opening` is keyed by party id, with `null` for postings no party could be
   * found for. Balances are debit-positive.
   */
  async rows(
    companyId: string,
    type: LedgerPartyType,
    range: LedgerRange,
    partyId?: string,
  ): Promise<{
    opening: Map<string | null, number>;
    rows: PartyLedgerRow[];
    accounts: Array<{ id: string; code: string; name: string }>;
  }> {
    const accounts = await this.controlAccounts(companyId, type);
    const ids = accounts.map((a) => a.id);
    if (ids.length === 0) return { opening: new Map(), rows: [], accounts };

    const only = Boolean(partyId);
    const [openingRaw, raw] = await Promise.all([
      this.dataSource.query(
        partyOpeningSql(type, only),
        only
          ? [companyId, ids, range.startDate, partyId]
          : [companyId, ids, range.startDate],
      ),
      this.dataSource.query(
        partyRowsSql(type, only),
        only
          ? [companyId, ids, range.startDate, range.endDate, partyId]
          : [companyId, ids, range.startDate, range.endDate],
      ),
    ]);

    const opening = new Map<string | null, number>(
      (openingRaw as any[]).map((r) => [r.partyId ?? null, r2(num(r.balance))]),
    );
    const rows: PartyLedgerRow[] = (raw as any[]).map((r) => ({
      id: r.id,
      date: r.date,
      postedAt:
        r.postedAt instanceof Date
          ? r.postedAt.toISOString()
          : String(r.postedAt ?? ''),
      reference: r.reference ?? '',
      entryId: r.entryId ?? null,
      voided: r.voided === true,
      accountCode: r.accountCode ?? '',
      accountName: r.accountName ?? '',
      memo: r.memo ?? '',
      debit: r2(num(r.debit)),
      credit: r2(num(r.credit)),
      postingType: r.postingType ?? '',
      sourceId: r.sourceId,
      documentType: r.documentType ?? null,
      documentId: r.documentId ?? null,
      documentNumber: r.documentNumber ?? null,
      partyId: r.partyId ?? null,
    }));
    return { opening, rows, accounts };
  }

  /**
   * `GET /ledger?party=customer|vendor[&partyId=]` — one party's ledger, or
   * every party's, in the General Ledger's shape.
   *
   * With every party, `control` ties them to the books: the control accounts'
   * balance at the end of the period, how much of it belongs to a party, and
   * what does not (a journal posted straight to the account).
   */
  async ledger(
    companyId: string,
    type: LedgerPartyType,
    startDate?: string,
    endDate?: string,
    partyId?: string,
  ) {
    const range = rangeOf(startDate, endDate);
    const selected = partyId
      ? await this.party(companyId, type, partyId)
      : null;
    const { opening, rows, accounts } = await this.rows(
      companyId,
      type,
      range,
      partyId,
    );
    const attributed = rows.filter((r) => r.partyId);

    const involved = new Set<string>();
    for (const key of opening.keys()) if (key) involved.add(key);
    for (const r of attributed) involved.add(r.partyId as string);
    if (selected) involved.add(selected.id);
    const directory = new Map(
      (involved.size
        ? await this.directory(companyId, type, [...involved])
        : []
      ).map((p) => [p.id, p]),
    );

    const running = new Map<string, number>();
    const entries = attributed.map((r) => {
      const pid = r.partyId as string;
      const balance = r2(
        (running.get(pid) ?? opening.get(pid) ?? 0) + r.debit - r.credit,
      );
      running.set(pid, balance);
      const party = directory.get(pid);
      return {
        date: r.date,
        postedAt: r.postedAt,
        reference: r.reference,
        accountCode: r.accountCode,
        accountName: r.accountName,
        memo: r.memo,
        debit: r.debit,
        credit: r.credit,
        balance,
        voided: r.voided,
        // The same drill-through as an account's lines: the journal entry.
        sourceType: 'journal_entry',
        sourceId: r.entryId,
        postingType: r.postingType,
        label: postingLabel(r.postingType),
        documentType: r.documentType,
        documentId: r.documentId,
        documentNumber: r.documentNumber,
        partyId: pid,
        partyCode: party?.code ?? null,
        partyName: party?.name ?? '',
      };
    });

    // Opening and closing for the party selected, or for every party with a
    // balance or a movement — as the account view does for accounts.
    const partyIds = selected
      ? [selected.id]
      : [...involved].filter(
          (id) => (opening.get(id) ?? 0) !== 0 || running.has(id),
        );
    const balances = partyIds
      .map((id) => {
        const p = directory.get(id);
        return {
          partyId: id,
          partyCode: p?.code ?? null,
          partyName: p?.name ?? '',
          opening: opening.get(id) ?? 0,
          closing: running.get(id) ?? opening.get(id) ?? 0,
        };
      })
      .sort(byPartyCode);

    const totals = entries.reduce(
      (t, e) => ({ debit: t.debit + e.debit, credit: t.credit + e.credit }),
      { debit: 0, credit: 0 },
    );

    let control: null | {
      accounts: Array<{ code: string; name: string }>;
      balance: number;
      linked: number;
      unlinked: number;
    } = null;
    if (!selected) {
      const unlinkedRows = rows.filter((r) => !r.partyId);
      const unlinked = r2(
        (opening.get(null) ?? 0) +
          unlinkedRows.reduce((t, r) => t + r.debit - r.credit, 0),
      );
      const linked = r2(balances.reduce((t, b) => t + b.closing, 0));
      control = {
        accounts: accounts.map((a) => ({ code: a.code, name: a.name })),
        balance: r2(linked + unlinked),
        linked,
        unlinked,
      };
    }

    return {
      range,
      accountCode: null,
      party: {
        type,
        id: selected?.id ?? null,
        code: selected?.code ?? null,
        name: selected?.name ?? null,
      },
      entries,
      openingBalances: balances.map((b) => ({
        partyId: b.partyId,
        partyCode: b.partyCode,
        partyName: b.partyName,
        balance: r2(b.opening),
      })),
      closingBalances: balances.map((b) => ({
        partyId: b.partyId,
        partyCode: b.partyCode,
        partyName: b.partyName,
        balance: r2(b.closing),
      })),
      totals: { debit: r2(totals.debit), credit: r2(totals.credit) },
      control,
    };
  }

  /**
   * `GET /ledger/parties?type=` — every party of a type with its figures for
   * the period, for the General Ledger's picker (the twin of /ledger/accounts).
   * Parties with no postings are listed too, at zero, so any customer can be
   * found by ID or name.
   */
  async parties(
    companyId: string,
    type: LedgerPartyType,
    startDate?: string,
    endDate?: string,
  ) {
    const range = rangeOf(startDate, endDate);
    const [{ opening, rows }, directory] = await Promise.all([
      this.rows(companyId, type, range),
      this.directory(companyId, type),
    ]);
    const moved = new Map<
      string,
      { debit: number; credit: number; entries: number }
    >();
    for (const r of rows) {
      if (!r.partyId) continue;
      const m = moved.get(r.partyId) ?? { debit: 0, credit: 0, entries: 0 };
      m.debit += r.debit;
      m.credit += r.credit;
      m.entries += 1;
      moved.set(r.partyId, m);
    }
    const parties = directory
      .map((p) => {
        const m = moved.get(p.id) ?? { debit: 0, credit: 0, entries: 0 };
        const open = opening.get(p.id) ?? 0;
        return {
          partyId: p.id,
          partyCode: p.code,
          partyName: p.name,
          isActive: p.isActive,
          opening: r2(open),
          debit: r2(m.debit),
          credit: r2(m.credit),
          closing: r2(open + m.debit - m.credit),
          entries: m.entries,
        };
      })
      .sort(byPartyCode);
    return { range, type, parties };
  }

  /**
   * A party's statement for a period, from the same postings as its ledger.
   *
   * The ledger shows every posting; a statement is what the customer or vendor
   * is sent, so it is quieter: the lines of one transaction are one line (a
   * receipt partly held as an advance is one receipt), moves that change
   * nothing are left out (an advance applied to an invoice), and so is a
   * document raised and voided inside the period. Its closing balance is still
   * the ledger's.
   *
   * Amounts are signed the way the party reads them: what the customer owes, or
   * what is owed to the vendor, goes up.
   */
  async statement(
    companyId: string,
    type: LedgerPartyType,
    partyId: string,
    startDate: string,
    endDate: string,
  ) {
    const range = rangeOf(startDate, endDate);
    const party = await this.party(companyId, type, partyId);
    const { opening, rows } = await this.rows(companyId, type, range, partyId);
    const sign = type === 'customer' ? 1 : -1;

    // One line per transaction: the rows of an entry for one source.
    const merged: Array<{
      key: string;
      id: string;
      date: string;
      postingType: string;
      sourceId: string;
      documentType: string | null;
      documentId: string | null;
      reference: string;
      amount: number;
    }> = [];
    const byKey = new Map<string, (typeof merged)[number]>();
    for (const r of rows) {
      const key = `${r.reference}|${r.postingType}|${r.sourceId}`;
      const amount = sign * (r.debit - r.credit);
      const line = byKey.get(key);
      if (line) {
        line.amount = r2(line.amount + amount);
        continue;
      }
      const next = {
        key,
        id: r.id,
        date: r.date,
        postingType: r.postingType,
        sourceId: r.sourceId,
        documentType: r.documentType,
        documentId: r.documentId,
        reference: r.documentNumber || r.reference,
        amount: r2(amount),
      };
      byKey.set(key, next);
      merged.push(next);
    }

    // A document raised and voided inside the period nets to nothing and was
    // never owed: leave both out, as the old statement did.
    const bySource = new Map<string, typeof merged>();
    for (const l of merged) {
      const list = bySource.get(l.sourceId) ?? [];
      list.push(l);
      bySource.set(l.sourceId, list);
    }
    const cancelled = new Set<string>();
    for (const [sourceId, list] of bySource) {
      const hasVoid = list.some((l) => l.postingType.endsWith('_void'));
      const hasOriginal = list.some((l) => !l.postingType.endsWith('_void'));
      const net = r2(list.reduce((t, l) => t + l.amount, 0));
      if (hasVoid && hasOriginal && Math.abs(net) < 0.005)
        cancelled.add(sourceId);
    }

    let balance = r2(sign * (opening.get(partyId) ?? 0));
    const openingBalance = balance;
    const lines = merged
      .filter((l) => Math.abs(l.amount) >= 0.005 && !cancelled.has(l.sourceId))
      .map((l) => {
        balance = r2(balance + l.amount);
        return {
          id: l.id,
          date: l.date,
          kind: statementKind(l.postingType),
          label: postingLabel(l.postingType),
          reference: l.reference,
          documentType: l.documentType,
          documentId: l.documentId,
          amount: l.amount,
          balance,
        };
      });

    const sumOf = (kinds: string[]) =>
      r2(
        lines
          .filter((l) => kinds.includes(l.kind))
          .reduce((t, l) => t + l.amount, 0),
      );
    const totals =
      type === 'customer'
        ? {
            invoiced: sumOf(['invoice', 'invoice_void']),
            received: r2(-sumOf(['payment', 'payment_void', 'advance'])),
            credited: r2(-sumOf(['credit_memo', 'credit_memo_void'])),
            refunded: sumOf(['refund']),
            other: sumOf(['other']),
          }
        : {
            billed: sumOf(['bill', 'bill_void']),
            paid: r2(-sumOf(['payment'])),
            credited: r2(-sumOf(['vendor_credit', 'vendor_credit_void'])),
            other: sumOf(['other']),
          };

    return {
      partyType: type,
      party: {
        id: party.id,
        code: party.code,
        name: party.name,
        email: party.email,
      },
      period: range,
      openingBalance,
      // NOT `data` — the response envelope keeps only a top-level `data` key.
      lines,
      totals,
      closingBalance: balance,
    };
  }
}

/** A statement line's kind, from the posting that made it. */
function statementKind(postingType: string): string {
  switch (postingType) {
    case 'invoice':
    case 'invoice_void':
    case 'payment':
    case 'payment_void':
    case 'credit_memo':
    case 'credit_memo_void':
    case 'bill':
    case 'bill_void':
    case 'vendor_credit':
    case 'vendor_credit_void':
      return postingType;
    case 'bill_payment':
      return 'payment';
    case 'credit_memo_refund':
      return 'refund';
    case 'delivery_advance':
      return 'advance';
    default:
      return 'other';
  }
}

/** Natural order by ID — C-2 before C-10 — then name; parties without an ID last. */
function byPartyCode(
  a: { partyCode: string | null; partyName: string },
  b: { partyCode: string | null; partyName: string },
): number {
  if (!a.partyCode !== !b.partyCode) return a.partyCode ? -1 : 1;
  const byCode = (a.partyCode ?? '').localeCompare(b.partyCode ?? '', 'en', {
    numeric: true,
  });
  return (
    byCode ||
    a.partyName.localeCompare(b.partyName, 'en', { sensitivity: 'base' })
  );
}
