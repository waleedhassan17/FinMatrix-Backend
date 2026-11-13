import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import {
  ACCT_AP,
  ACCT_AR,
  ACCT_INVENTORY,
  ACCT_MIGRATION_CLEARING,
} from '../../accounts/accounts.constants';
import {
  exportColumns,
  EXPORT_ENTITIES,
} from '../../data-portability/exporter/export-entities';
import { serializeRow } from '../../data-portability/exporter/row-serializer';
import {
  MigrationBatch,
  MigrationCheckResult,
} from '../entities/migration-batch.entity';
import { normalizeKey } from '../parsers/text-normalize';
import {
  expectedAccountNets,
  expectedControlNet,
  expectedOpenItemsByParty,
  expectedOpenItemsTotal,
  expectedRoundTripRows,
  expectedRowsAccounted,
  expectedSourceTrialBalance,
  expectedStockByItem,
  expectedStockTotal,
} from './migration-expected.sql';

/** What the commit created, so the actual side can find it. */
export interface Materialised {
  /** `${kind}:${id}` reference key (as the staging rows carry it) → record id. */
  customers: Map<string, string>;
  vendors: Map<string, string>;
  items: Map<string, string>;
  /** FinMatrix account number → account id, every account the batch touched. */
  accounts: Map<string, string>;
  invoiceIds: string[];
  billIds: string[];
}

export const CHECK_LABELS: Record<string, string> = {
  ROWS_ACCOUNTED: 'Every source row accounted for',
  SOURCE_TB_BALANCED: 'Source trial balance balances',
  ACCOUNT_BY_ACCOUNT: 'Each account balance equals its source',
  CLEARING_ZERO: 'Migration Clearing is zero',
  AR_MATCHES: 'Receivables match the open invoices',
  AP_MATCHES: 'Payables match the open bills',
  INVENTORY_MATCHES: 'Stock matches the inventory balance',
  BALANCE_SHEET_BALANCES: 'Assets = Liabilities + Equity',
  ROUND_TRIP: 'Imported records read back as the source',
};

export const CHECK_CODES = Object.keys(CHECK_LABELS);

const d = (v: unknown) =>
  new Decimal(v === null || v === undefined || v === '' ? 0 : String(v));
const s = (v: Decimal) => v.toFixed(2);

/**
 * The nine hard checks (§1.7), zero tolerance.
 *
 * `expected` comes from migration-expected.sql.ts — plain SQL over the staging
 * rows. `actual` is read back here from what the posting engine and the
 * document services wrote: account balances, invoice and bill balances,
 * customer and vendor balances, item quantities and movement values, and the
 * export serializer for the round trip. The two sides never share a line of
 * arithmetic. Every comparison is exact Decimal equality.
 *
 * Checks 1–2 need only the staging rows; 3–9 need the postings, so they run
 * inside the dry-run (and again inside the real commit) transaction, through
 * the same EntityManager, where the uncommitted postings are visible.
 */
@Injectable()
export class MigrationChecksService {
  async stagingChecks(
    em: EntityManager,
    batch: MigrationBatch,
  ): Promise<MigrationCheckResult[]> {
    return [
      await this.rowsAccounted(em, batch),
      await this.sourceTbBalanced(em, batch),
    ];
  }

  async postingChecks(
    em: EntityManager,
    batch: MigrationBatch,
    m: Materialised,
  ): Promise<MigrationCheckResult[]> {
    return [
      await this.accountByAccount(em, batch, m),
      await this.clearingZero(em, batch),
      await this.openItems(em, batch, m, 'open_invoices'),
      await this.openItems(em, batch, m, 'open_bills'),
      await this.inventoryMatches(em, batch, m),
      await this.balanceSheetBalances(em, batch),
      await this.roundTrip(em, batch, m),
    ];
  }

  // 1 ──────────────────────────────────────────────────────────────────
  private async rowsAccounted(
    em: EntityManager,
    batch: MigrationBatch,
  ): Promise<MigrationCheckResult> {
    const rows = await expectedRowsAccounted(em, batch.id, batch.companyId);
    let source = 0;
    let accounted = 0;
    const details: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      source += r.source;
      accounted += r.imported + r.merged + r.rejected - r.rejectedWithoutReason;
      details.push({
        entity: r.entity,
        source: r.source,
        imported: r.imported,
        merged: r.merged,
        rejected: r.rejected,
        pending: r.pending,
        rejectedWithoutReason: r.rejectedWithoutReason,
      });
    }
    return this.result(
      'ROWS_ACCOUNTED',
      new Decimal(source),
      new Decimal(accounted),
      details.filter(
        (x) =>
          (x.pending as number) > 0 ||
          (x.rejectedWithoutReason as number) > 0 ||
          details.length <= 8,
      ),
    );
  }

  // 2 ──────────────────────────────────────────────────────────────────
  private async sourceTbBalanced(
    em: EntityManager,
    batch: MigrationBatch,
  ): Promise<MigrationCheckResult> {
    const tb = await expectedSourceTrialBalance(em, batch.id, batch.companyId);
    const details =
      tb.rows === 0
        ? [{ note: 'No trial balance rows will be imported.' }]
        : [
            {
              rows: tb.rows,
              debits: s(d(tb.debits)),
              credits: s(d(tb.credits)),
            },
          ];
    const r = this.result(
      'SOURCE_TB_BALANCED',
      d(tb.debits),
      d(tb.credits),
      details,
    );
    if (tb.rows === 0) r.passed = false;
    return r;
  }

  // 3 ──────────────────────────────────────────────────────────────────
  private async accountByAccount(
    em: EntityManager,
    batch: MigrationBatch,
    m: Materialised,
  ): Promise<MigrationCheckResult> {
    const expected = await expectedAccountNets(em, batch.id, batch.companyId);
    const accounts = await em.find(Account, {
      where: { companyId: batch.companyId },
    });
    const byNumber = new Map(accounts.map((a) => [a.accountNumber, a]));
    const details: Array<Record<string, unknown>> = [];
    let expectedTotal = new Decimal(0);
    let actualTotal = new Decimal(0);
    let failures = 0;
    for (const e of expected) {
      const acct = byNumber.get(e.account);
      const exp = d(e.net);
      // accounts.balance is signed by normal balance; compare as debit − credit.
      const act = acct
        ? acct.type === 'asset' || acct.type === 'expense'
          ? d(acct.balance)
          : d(acct.balance).negated()
        : new Decimal(0);
      const diff = act.minus(exp);
      expectedTotal = expectedTotal.plus(exp.abs());
      actualTotal = actualTotal.plus(act.abs());
      if (!diff.isZero()) failures += 1;
      if (!diff.isZero() || details.length < 12) {
        details.push({
          account: e.account,
          name: acct?.name ?? '(missing)',
          expected: s(exp),
          actual: s(act),
          difference: s(diff),
          ok: diff.isZero(),
        });
      }
    }
    const r = this.result(
      'ACCOUNT_BY_ACCOUNT',
      expectedTotal,
      actualTotal,
      details,
    );
    r.passed = failures === 0 && expected.length > 0;
    r.difference = failures === 0 ? '0.00' : `${failures} account(s) differ`;
    void m;
    return r;
  }

  // 4 ──────────────────────────────────────────────────────────────────
  private async clearingZero(
    em: EntityManager,
    batch: MigrationBatch,
  ): Promise<MigrationCheckResult> {
    const acct = await em.findOne(Account, {
      where: {
        companyId: batch.companyId,
        accountNumber: ACCT_MIGRATION_CLEARING,
      },
    });
    const actual = acct ? d(acct.balance) : new Decimal(0);
    return this.result('CLEARING_ZERO', new Decimal(0), actual, [
      {
        account: ACCT_MIGRATION_CLEARING,
        balance: s(actual),
        note: actual.isZero()
          ? 'Clearing nets to zero.'
          : 'The open items or stock disagree with the trial balance by this amount.',
      },
    ]);
  }

  // 5 & 6 ──────────────────────────────────────────────────────────────
  private async openItems(
    em: EntityManager,
    batch: MigrationBatch,
    m: Materialised,
    entity: 'open_invoices' | 'open_bills',
  ): Promise<MigrationCheckResult> {
    const isAr = entity === 'open_invoices';
    const expectedParties = await expectedOpenItemsByParty(
      em,
      batch.id,
      batch.companyId,
      entity,
    );
    const expectedTotal = d(
      await expectedOpenItemsTotal(em, batch.id, batch.companyId, entity),
    );
    const control = d(
      await expectedControlNet(
        em,
        batch.id,
        batch.companyId,
        isAr ? ACCT_AR : ACCT_AP,
      ),
    );
    const controlNet = isAr ? control : control.negated(); // AP is a credit balance
    const table = isAr ? 'invoices' : 'bills';
    const partyCol = isAr ? 'customer_id' : 'vendor_id';
    const actualRows: Array<{ party: string; balance: string; n: string }> =
      await em.query(
        `SELECT ${partyCol} AS party, COALESCE(SUM(balance), 0)::text AS balance, COUNT(*)::int AS n
         FROM ${table} WHERE company_id = $1 AND migration_batch_id = $2 GROUP BY ${partyCol}`,
        [batch.companyId, batch.id],
      );
    const actualByParty = new Map(actualRows.map((r) => [r.party, r]));
    const refs = isAr ? m.customers : m.vendors;
    const details: Array<Record<string, unknown>> = [];
    let failures = 0;
    let actualTotal = new Decimal(0);
    for (const r of actualRows) actualTotal = actualTotal.plus(d(r.balance));
    for (const e of expectedParties) {
      const id = refs.get(e.refKey);
      const act = id ? d(actualByParty.get(id)?.balance ?? 0) : new Decimal(0);
      const exp = d(e.due);
      const diff = act.minus(exp);
      if (!diff.isZero()) failures += 1;
      if (!diff.isZero() || details.length < 12)
        details.push({
          party: e.refName,
          documents: e.count,
          expected: s(exp),
          actual: s(act),
          difference: s(diff),
          ok: diff.isZero(),
        });
    }
    // The party balance columns must agree too: that is what statements read.
    const partyTable = isAr ? 'customers' : 'vendors';
    const partyBalances: Array<{ id: string; balance: string }> =
      await em.query(
        `SELECT id, balance::text FROM ${partyTable} WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [batch.companyId, [...new Set(refs.values())]],
      );
    for (const pb of partyBalances) {
      const docs = d(actualByParty.get(pb.id)?.balance ?? 0);
      if (!d(pb.balance).equals(docs)) {
        failures += 1;
        details.push({
          partyId: pb.id,
          note: `${isAr ? 'Customer' : 'Vendor'} balance ${s(d(pb.balance))} differs from its open ${isAr ? 'invoices' : 'bills'} ${s(docs)}.`,
        });
      }
    }
    const totalDiff = actualTotal.minus(controlNet);
    details.push({
      note: `Total of open ${isAr ? 'invoices' : 'bills'}`,
      expectedFromTrialBalance: s(controlNet),
      fromSourceDetail: s(expectedTotal),
      actual: s(actualTotal),
      difference: s(totalDiff),
    });
    const r = this.result(
      isAr ? 'AR_MATCHES' : 'AP_MATCHES',
      controlNet,
      actualTotal,
      details,
    );
    r.passed =
      failures === 0 && totalDiff.isZero() && expectedTotal.equals(controlNet);
    return r;
  }

  // 7 ──────────────────────────────────────────────────────────────────
  private async inventoryMatches(
    em: EntityManager,
    batch: MigrationBatch,
    m: Materialised,
  ): Promise<MigrationCheckResult> {
    const expectedItems = await expectedStockByItem(
      em,
      batch.id,
      batch.companyId,
    );
    const expectedValue = d(
      await expectedStockTotal(em, batch.id, batch.companyId),
    );
    const control = d(
      await expectedControlNet(em, batch.id, batch.companyId, ACCT_INVENTORY),
    );
    const details: Array<Record<string, unknown>> = [];
    let failures = 0;
    const ids = [...new Set(m.items.values())];
    const actualItems: Array<{
      id: string;
      sku: string;
      quantity_on_hand: string;
      unit_cost: string;
    }> = ids.length
      ? await em.query(
          `SELECT id, sku, quantity_on_hand::text, unit_cost::text FROM inventory_items WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [batch.companyId, ids],
        )
      : [];
    const byId = new Map(actualItems.map((i) => [i.id, i]));
    for (const e of expectedItems) {
      const id = m.items.get(e.refKey);
      const act = id ? byId.get(id) : undefined;
      const qtyDiff = d(act?.quantity_on_hand ?? 0).minus(d(e.quantity));
      if (!qtyDiff.isZero()) failures += 1;
      if (!qtyDiff.isZero() || details.length < 12)
        details.push({
          sku: e.sku,
          expectedQty: d(e.quantity).toFixed(4),
          actualQty: d(act?.quantity_on_hand ?? 0).toFixed(4),
          difference: qtyDiff.toFixed(4),
          ok: qtyDiff.isZero(),
        });
    }
    const [mv] = await em.query(
      `SELECT COALESCE(SUM(value_change), 0)::text AS value FROM inventory_movements WHERE company_id = $1 AND source_type = 'migration' AND source_id = $2`,
      [batch.companyId, batch.id],
    );
    const movementValue = d(mv.value);
    const inventoryAcct = await em.findOne(Account, {
      where: { companyId: batch.companyId, accountNumber: ACCT_INVENTORY },
    });
    const ledgerValue = inventoryAcct
      ? d(inventoryAcct.balance)
      : new Decimal(0);
    details.push({
      note: 'Stock value',
      expectedFromTrialBalance: s(control),
      fromSourceDetail: s(expectedValue),
      movements: s(movementValue),
      ledger1200: s(ledgerValue),
    });
    const r = this.result('INVENTORY_MATCHES', control, ledgerValue, details);
    r.passed =
      failures === 0 &&
      expectedValue.equals(control) &&
      movementValue.equals(control) &&
      ledgerValue.equals(control);
    return r;
  }

  // 8 ──────────────────────────────────────────────────────────────────
  private async balanceSheetBalances(
    em: EntityManager,
    batch: MigrationBatch,
  ): Promise<MigrationCheckResult> {
    const rows: Array<{ type: string; total: string }> = await em.query(
      `SELECT type, COALESCE(SUM(balance), 0)::text AS total FROM accounts WHERE company_id = $1 GROUP BY type`,
      [batch.companyId],
    );
    const t = (k: string) => d(rows.find((r) => r.type === k)?.total ?? 0);
    const assets = t('asset');
    const liabilities = t('liability');
    const equity = t('equity');
    const income = t('revenue').minus(t('expense'));
    const rhs = liabilities.plus(equity).plus(income);
    return this.result('BALANCE_SHEET_BALANCES', assets, rhs, [
      {
        assets: s(assets),
        liabilities: s(liabilities),
        equity: s(equity),
        netIncomeToDate: s(income),
        liabilitiesPlusEquity: s(rhs),
      },
    ]);
  }

  // 9 ──────────────────────────────────────────────────────────────────
  /**
   * Re-read what was written through the backup's own serializer (the export
   * registry) and compare, field by field, with the staging values — the
   * proof that an export of these books says what the source said.
   */
  private async roundTrip(
    em: EntityManager,
    batch: MigrationBatch,
    m: Materialised,
  ): Promise<MigrationCheckResult> {
    const details: Array<Record<string, unknown>> = [];
    let compared = 0;
    let mismatches = 0;
    const read = async (
      name: string,
      ids: string[],
    ): Promise<Map<string, Record<string, string>>> => {
      const def = EXPORT_ENTITIES.find((e) => e.name === name)!;
      const out = new Map<string, Record<string, string>>();
      if (ids.length === 0) return out;
      const cols = exportColumns(em, def);
      const rows = await em
        .createQueryBuilder(def.entity, 'e')
        .where('e.companyId = :companyId', { companyId: batch.companyId })
        .andWhere('e.id IN (:...ids)', { ids })
        .getMany();
      for (const row of rows) {
        const values = serializeRow(row as Record<string, unknown>, cols);
        const rec: Record<string, string> = {};
        cols.forEach((c, i) => (rec[c.property] = values[i]));
        out.set(String(row.id), rec);
      }
      return out;
    };
    const same = (a: unknown, b: unknown, kind: 'text' | 'amount' | 'date') => {
      if (kind === 'amount') return d(a).equals(d(b));
      if (kind === 'date') return String(a ?? '') === String(b ?? '');
      return normalizeKey(a) === normalizeKey(b);
    };
    const compare = (
      what: string,
      rowRef: string,
      pairs: Array<[string, unknown, unknown, 'text' | 'amount' | 'date']>,
    ) => {
      for (const [field, exp, act, kind] of pairs) {
        if (exp === null || exp === undefined || exp === '') continue;
        compared += 1;
        if (!same(exp, act, kind)) {
          mismatches += 1;
          if (details.length < 30)
            details.push({
              record: what,
              row: rowRef,
              field,
              source: exp,
              readBack: act,
            });
        }
      }
    };

    const refKeyOf = (n: Record<string, unknown>, ref: string) => {
      const r = n[ref] as { kind: string; id: string } | undefined;
      return r ? `${r.kind}:${r.id}` : '';
    };

    // Customers and vendors created by the batch.
    for (const [entity, name, map, nameField] of [
      ['customers', 'customers', m.customers, 'name'],
      ['vendors', 'vendors', m.vendors, 'companyName'],
    ] as const) {
      const staged = await expectedRoundTripRows(
        em,
        batch.id,
        batch.companyId,
        entity,
      );
      const records = await read(name, [...new Set(map.values())]);
      for (const st of staged) {
        const id = map.get(`row:${st.sheet}:${st.rowNumber}`);
        const rec = id ? records.get(id) : undefined;
        if (!rec) continue;
        compare(entity, `${st.sheet}:${st.rowNumber}`, [
          ['name', st.normalized.name, rec[nameField], 'text'],
          ['phone', st.normalized.phone, rec.phone, 'text'],
          ['email', st.normalized.email, rec.email, 'text'],
          ['taxId', st.normalized.taxId, rec.taxId, 'text'],
        ]);
      }
    }
    // Items.
    {
      const staged = await expectedRoundTripRows(
        em,
        batch.id,
        batch.companyId,
        'items',
      );
      const records = await read('items', [...new Set(m.items.values())]);
      for (const st of staged) {
        const id = m.items.get(`row:${st.sheet}:${st.rowNumber}`);
        const rec = id ? records.get(id) : undefined;
        if (!rec) continue;
        compare('items', `${st.sheet}:${st.rowNumber}`, [
          ['sku', st.normalized.sku, rec.sku, 'text'],
          ['name', st.normalized.name, rec.name, 'text'],
          [
            'sellingPrice',
            st.normalized.sellingPrice,
            rec.sellingPrice,
            'amount',
          ],
        ]);
      }
    }
    // Open invoices and bills, by legacy reference.
    for (const [
      entity,
      name,
      ids,
      numberField,
      dateField,
      partyRef,
      partyMap,
    ] of [
      [
        'open_invoices',
        'invoices',
        m.invoiceIds,
        'invoiceNumber',
        'invoiceDate',
        'customerRef',
        m.customers,
      ],
      [
        'open_bills',
        'bills',
        m.billIds,
        'billNumber',
        'billDate',
        'vendorRef',
        m.vendors,
      ],
    ] as const) {
      const staged = await expectedRoundTripRows(
        em,
        batch.id,
        batch.companyId,
        entity,
      );
      const records = await read(name, ids);
      const byLegacy = new Map<string, Record<string, string>>();
      for (const rec of records.values())
        byLegacy.set(normalizeKey(rec.legacyRef), rec);
      for (const st of staged) {
        const rec = byLegacy.get(normalizeKey(st.normalized[numberField]));
        if (!rec) {
          compared += 1;
          mismatches += 1;
          if (details.length < 30)
            details.push({
              record: entity,
              row: `${st.sheet}:${st.rowNumber}`,
              field: numberField,
              source: st.normalized[numberField],
              readBack: null,
            });
          continue;
        }
        compare(entity, `${st.sheet}:${st.rowNumber}`, [
          ['amountDue', st.normalized.amountDue, rec.balance, 'amount'],
          ['originalAmount', st.normalized.originalAmount, rec.total, 'amount'],
          [dateField, st.normalized[dateField], rec[dateField], 'date'],
          ['dueDate', st.normalized.dueDate, rec.dueDate, 'date'],
          [
            'party',
            partyMap.get(refKeyOf(st.normalized, partyRef)),
            rec[entity === 'open_invoices' ? 'customerId' : 'vendorId'],
            'text',
          ],
        ]);
      }
    }
    const r = this.result(
      'ROUND_TRIP',
      new Decimal(compared),
      new Decimal(compared - mismatches),
      details,
    );
    r.expected = `${compared} values`;
    r.actual = `${compared - mismatches} match`;
    r.difference = String(mismatches);
    r.passed = mismatches === 0;
    return r;
  }

  private result(
    code: string,
    expected: Decimal,
    actual: Decimal,
    details: Array<Record<string, unknown>>,
  ): MigrationCheckResult {
    const difference = actual.minus(expected);
    return {
      code,
      label: CHECK_LABELS[code],
      expected: s(expected),
      actual: s(actual),
      difference: s(difference),
      passed: difference.isZero(),
      details,
    };
  }
}
