import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { addDaysIso } from '../../../common/utils/business-date.util';
import {
  isUniqueViolation,
  nextPartyCode,
  normalizePartyCode,
  PARTY_CODE_PATTERN,
} from '../../../common/utils/party-code.util';
import { recordMovementAtAverage } from '../../../common/utils/inventory-movement.util';
import {
  ACCOUNT_SUB_TYPES,
  ACCT_AP,
  ACCT_AR,
  ACCT_INVENTORY,
  ACCT_MIGRATION_CLEARING,
} from '../../accounts/accounts.constants';
import { AccountsService } from '../../accounts/accounts.service';
import { Account } from '../../accounts/entities/account.entity';
import { Bill } from '../../bills/entities/bill.entity';
import { BillLineItem } from '../../bills/entities/bill-line-item.entity';
import { Company } from '../../companies/entities/company.entity';
import { Address, Customer } from '../../customers/entities/customer.entity';
import { InventoryItem } from '../../inventory/entities/inventory-item.entity';
import { InventoryService } from '../../inventory/inventory.service';
import { Invoice } from '../../invoices/entities/invoice.entity';
import { InvoiceLineItem } from '../../invoices/entities/invoice-line-item.entity';
import {
  PostingLineInput,
  PostingService,
} from '../../journal-entries/posting.service';
import { dayBefore } from '../../reports/fiscal-year';
import {
  AsTypedActuals,
  AsTypedFigures,
  buildAsTyped,
} from '../certificate/as-typed';
import { assertTransition } from '../state-machine';
import { Vendor } from '../../vendors/entities/vendor.entity';
import { AccountType, PaymentTerms } from '../../../types';
import {
  MigrationBatch,
  MigrationCheckResult,
} from '../entities/migration-batch.entity';
import {
  BatchRecordType,
  MigrationBatchRecord,
} from '../entities/migration-batch-record.entity';
import { MigrationStagingRow } from '../entities/migration-staging-row.entity';
import { normalizeKey } from '../parsers/text-normalize';
import {
  CHECK_CODES,
  CHECK_LABELS,
  Materialised,
  MigrationChecksService,
} from '../validation/migration-checks.service';

/** Lines per open-item journal entry; each chunk balances on its own. */
const OPEN_ITEM_CHUNK = 1000;
const CONTROL_ACCOUNTS = new Set([ACCT_AR, ACCT_AP, ACCT_INVENTORY]);

export interface SpotCheck {
  kind: 'customer' | 'vendor';
  name: string;
  documents: number;
  /** Each open document's amount due exactly as typed in the file. */
  asTyped: string[];
  sourceBalance: string;
  finmatrixBalance: string;
  matches: boolean;
}

export interface CertificatePreview {
  batchId: string;
  companyName: string;
  sourceSystem: string;
  cutoverDate: string;
  generatedAt: string;
  mode: 'dry-run' | 'commit';
  checks: MigrationCheckResult[];
  allPassed: boolean;
  rowCounts: Array<{
    entity: string;
    source: number;
    imported: number;
    merged: number;
    rejected: number;
    pending: number;
  }>;
  rejectedRows: Array<{ sheet: string; rowNumber: number; reason: string }>;
  rejectedTotal: number;
  spotChecks: SpotCheck[];
  /** Every figure as typed, as read, and as the books now hold it. */
  asTyped?: AsTypedFigures;
  postings: Array<{
    reference: string;
    memo: string;
    lines: number;
    total: string;
  }>;
  created: Record<string, number>;
}

class RollbackSignal extends Error {
  constructor(readonly preview: CertificatePreview) {
    super('rollback');
  }
}

interface RunState {
  em: EntityManager;
  batch: MigrationBatch;
  userId: string;
  records: Array<{
    recordType: BatchRecordType;
    recordId: string;
    meta?: Record<string, unknown> | null;
  }>;
  postings: CertificatePreview['postings'];
  created: Record<string, number>;
}

const d = (v: unknown) =>
  new Decimal(v === null || v === undefined || v === '' ? 0 : String(v));

/**
 * Posts a migration batch (§1.6), and dry-runs it — one code path for both.
 *
 * Everything happens inside ONE transaction. The dry run executes every
 * step exactly as the commit would, runs the ten checks against what it
 * wrote, and then throws a private signal that rolls the transaction back;
 * the commit runs the same steps and the same checks and commits only when
 * every check passes, so a failing check can never leave half a migration in
 * the books.
 *
 * Ledger entries go through PostingService.createEntry and nowhere else
 * (period lock, balance checks and account validation included). Documents
 * are written directly because the normal create paths post revenue, tax and
 * COGS, enforce credit limits and send WhatsApp messages — none of which a
 * brought-forward balance may do — and each document points at the batch
 * entry that carries its line, so invariant I7 (every posted document has a
 * journal entry) still holds.
 *
 *   Trial balance  → one entry; AR/AP/Inventory lines land on 3950 instead
 *   Open invoices  → Dr 1100 per invoice / Cr 3950, chunked; invoice rows
 *   Open bills     → Dr 3950 / Cr 2000 per bill, chunked; bill rows
 *   Stock          → InventoryService.postOpeningStockBatchJe crediting 3950,
 *                    plus one `migration` movement per item at its cost
 *   → 3950 nets to zero exactly when the detail agrees with the trial balance.
 */
@Injectable()
export class MigrationCommitService {
  private readonly logger = new Logger(MigrationCommitService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly inventory: InventoryService,
    private readonly checks: MigrationChecksService,
  ) {}

  async dryRun(
    batch: MigrationBatch,
    userId: string,
  ): Promise<CertificatePreview> {
    try {
      await this.dataSource.transaction(async (em) => {
        const preview = await this.execute(em, batch, userId, 'dry-run');
        throw new RollbackSignal(preview);
      });
    } catch (err) {
      if (err instanceof RollbackSignal) return err.preview;
      throw err;
    }
    throw new Error('unreachable');
  }

  /** Commit, or throw CHECK_FAILED (and roll everything back) if any check fails. */
  async commit(
    batch: MigrationBatch,
    userId: string,
    onCommitted: (
      em: EntityManager,
      preview: CertificatePreview,
    ) => Promise<void>,
  ): Promise<CertificatePreview> {
    try {
      return await this.dataSource.transaction(async (em) => {
        const preview = await this.execute(em, batch, userId, 'commit');
        if (!preview.allPassed) throw new RollbackSignal(preview);
        await onCommitted(em, preview);
        return preview;
      });
    } catch (err) {
      if (err instanceof RollbackSignal) {
        throw new ConflictException({
          code: 'CHECK_FAILED',
          message: `The import was stopped and nothing was posted: ${err.preview.checks
            .filter((c) => !c.passed)
            .map((c) => c.label.toLowerCase())
            .join('; ')}.`,
          details: { checks: err.preview.checks },
        });
      }
      throw err;
    }
  }

  private async execute(
    em: EntityManager,
    batch: MigrationBatch,
    userId: string,
    mode: 'dry-run' | 'commit',
  ): Promise<CertificatePreview> {
    // One migration at a time per company, and nothing else posting meanwhile.
    const company = await em.findOneOrFail(Company, {
      where: { id: batch.companyId },
      lock: { mode: 'pessimistic_write' },
    });
    // The caller checked the batch before this transaction began; another
    // request may have committed, closed or re-analysed it while we waited
    // for the company lock. Decide on the row as it is now, under a lock of
    // its own, so a retried commit is refused rather than posted twice.
    const live = await em.findOneOrFail(MigrationBatch, {
      where: { id: batch.id, companyId: batch.companyId },
      lock: { mode: 'pessimistic_write' },
    });
    if (mode === 'commit') {
      assertTransition(live.status, 'committed');
      if (!live.signedOffAt)
        throw new ConflictException({
          code: 'NOT_SIGNED_OFF',
          message: 'Sign off the certificate before importing.',
        });
    } else {
      assertTransition(live.status, 'validated');
    }
    await assertBooksEmpty(em, batch.companyId, batch.id);

    const state: RunState = {
      em,
      batch,
      userId,
      records: [],
      postings: [],
      created: {},
    };
    const staging = await em.find(MigrationStagingRow, {
      where: { batchId: batch.id, companyId: batch.companyId },
      order: { sheet: 'ASC', rowNumber: 'ASC' },
    });
    const stagingChecks = await this.checks.stagingChecks(em, batch);
    let postingChecks: MigrationCheckResult[];

    const tbBalanced =
      stagingChecks.find((c) => c.code === 'SOURCE_TB_BALANCED')?.passed ===
      true;
    if (!tbBalanced) {
      postingChecks = notRun(
        'The source trial balance does not balance, so nothing could be posted to check against.',
      );
    } else {
      let m: Materialised | null = null;
      try {
        m = await this.post(state, company, staging);
      } catch (err) {
        if (
          err instanceof ConflictException ||
          err instanceof BadRequestException
        ) {
          const body = err.getResponse() as { code?: string; message?: string };
          postingChecks = notRun(
            `Posting stopped: ${body.message ?? err.message}${body.code ? ` (${body.code})` : ''}`,
          );
          return this.preview(
            state,
            company,
            staging,
            [...stagingChecks, ...postingChecks],
            mode,
            [],
            buildAsTyped(staging, null),
          );
        }
        throw err;
      }
      postingChecks = await this.checks.postingChecks(em, batch, m);
      const spot = await this.spotChecks(em, batch, staging, m);
      const actuals = await this.asTypedActuals(em, batch.companyId, m);
      if (mode === 'commit') await this.finish(state, company, staging);
      return this.preview(
        state,
        company,
        staging,
        [...stagingChecks, ...postingChecks],
        mode,
        spot,
        buildAsTyped(staging, actuals),
      );
    }
    return this.preview(
      state,
      company,
      staging,
      [...stagingChecks, ...postingChecks],
      mode,
      [],
      buildAsTyped(staging, null),
    );
  }

  /** What the books hold after posting, for the "as you typed them" statement. */
  private async asTypedActuals(
    em: EntityManager,
    companyId: string,
    m: Materialised,
  ): Promise<AsTypedActuals> {
    const accounts = await em.find(Account, { where: { companyId } });
    const accountBalance = new Map(
      accounts.map((a) => [
        a.accountNumber,
        { balance: String(a.balance), type: String(a.type) },
      ]),
    );
    const partyBalance = new Map<string, string>();
    for (const [table, map] of [
      ['customers', m.customers],
      ['vendors', m.vendors],
    ] as const) {
      const ids = [...new Set(map.values())];
      if (!ids.length) continue;
      const rows: Array<{ id: string; balance: string }> = await em.query(
        `SELECT id, balance::text AS balance FROM ${table} WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [companyId, ids],
      );
      const byId = new Map(rows.map((r) => [r.id, r.balance]));
      for (const [key, id] of map) {
        const b = byId.get(id);
        if (b !== undefined) partyBalance.set(key, b);
      }
    }
    const item = new Map<string, { quantity: string; cost: string }>();
    const itemIds = [...new Set(m.items.values())];
    if (itemIds.length) {
      const rows: Array<{ id: string; quantity: string; cost: string }> =
        await em.query(
          `SELECT id, quantity_on_hand::text AS quantity, unit_cost::text AS cost FROM inventory_items WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [companyId, itemIds],
        );
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const [key, id] of m.items) {
        const r = byId.get(id);
        if (r) item.set(key, { quantity: r.quantity, cost: r.cost });
      }
    }
    return { accountBalance, partyBalance, item };
  }

  // ── Posting ───────────────────────────────────────────────────────────
  private async post(
    state: RunState,
    company: Company,
    staging: MigrationStagingRow[],
  ): Promise<Materialised> {
    const { em, batch } = state;
    const companyId = batch.companyId;
    const imported = (type: string) =>
      staging.filter((r) => r.entityType === type && r.outcome === 'imported');
    const merged = (type: string) =>
      staging.filter((r) => r.entityType === type && r.outcome === 'merged');
    const n = (r: MigrationStagingRow) =>
      r.normalized as Record<string, unknown>;

    // 3950 exists for every company (migration MigrationFoundation, default chart);
    // a company that somehow lacks it gets it here, recorded so rollback knows.
    const hadClearing = await em.findOne(Account, {
      where: { companyId, accountNumber: ACCT_MIGRATION_CLEARING },
    });
    const clearing = await this.accounts.getOrCreateSystemAccount(
      em,
      companyId,
      ACCT_MIGRATION_CLEARING,
    );
    if (!hadClearing)
      state.records.push({ recordType: 'account', recordId: clearing.id });

    // Accounts from the Accounts sheet that are new to the chart.
    const accountRows = imported('accounts');
    const createdAccounts = new Map<string, Account>();
    for (const r of accountRows) {
      const v = n(r);
      const type = v.type as AccountType;
      const number = String(v.accountNumber);
      const acct = em.create(Account, {
        companyId,
        accountNumber: number,
        name: String(v.accountName ?? number).slice(0, 255),
        type,
        subType: subTypeFor(type, v.kind as string | null),
        parentId: null,
        description: `Migrated from ${batch.sourceSystem}`,
        openingBalance: '0',
        balance: '0',
        isActive: true,
      });
      await em.save(acct);
      createdAccounts.set(normalizeKey(number), acct);
      state.records.push({ recordType: 'account', recordId: acct.id });
    }
    for (const r of accountRows) {
      const parent = n(r).parentNumber ? normalizeKey(n(r).parentNumber) : '';
      if (!parent) continue;
      const self = createdAccounts.get(normalizeKey(n(r).accountNumber));
      const parentAcct =
        createdAccounts.get(parent) ??
        (await em.findOne(Account, {
          where: { companyId, accountNumber: String(n(r).parentNumber) },
        }));
      if (self && parentAcct && parentAcct.type === self.type)
        await em.update(Account, { id: self.id }, { parentId: parentAcct.id });
    }
    // Trial balance lines the owner (or the AI assistant) chose to create as
    // new accounts of a given type, with no Accounts-sheet row behind them.
    for (const r of imported('trial_balance')) {
      const v = n(r);
      const spec = v.newAccount as { type?: string; name?: string } | undefined;
      if (v.targetAccount !== 'NEW' || !spec?.type) continue;
      const number = String(v.accountNumber);
      if (createdAccounts.has(normalizeKey(number))) continue;
      if (
        await em.findOne(Account, {
          where: { companyId, accountNumber: number },
        })
      )
        continue;
      const type = spec.type as AccountType;
      const acct = em.create(Account, {
        companyId,
        accountNumber: number,
        name: String(spec.name ?? number).slice(0, 255),
        type,
        subType: subTypeFor(type, null),
        parentId: null,
        description: `Migrated from ${batch.sourceSystem}`,
        openingBalance: '0',
        balance: '0',
        isActive: true,
      });
      await em.save(acct);
      createdAccounts.set(normalizeKey(number), acct);
      state.records.push({ recordType: 'account', recordId: acct.id });
    }
    state.created.accounts = createdAccounts.size;

    // An account the books need may exist but be inactive — typically one a
    // rolled-back migration added and then deactivated. The posting engine
    // refuses inactive accounts, so it is reactivated and recorded; undoing
    // this migration deactivates it again.
    const needed = new Set<string>();
    for (const r of imported('trial_balance')) {
      const v = n(r);
      const target =
        v.targetAccount === 'NEW'
          ? String(v.accountNumber)
          : String(v.targetAccount ?? '');
      if (target)
        needed.add(
          CONTROL_ACCOUNTS.has(target) ? ACCT_MIGRATION_CLEARING : target,
        );
    }
    if (imported('open_invoices').length) needed.add(ACCT_AR);
    if (imported('open_bills').length) needed.add(ACCT_AP);
    if (imported('stock').length) needed.add(ACCT_INVENTORY);
    for (const r of merged('accounts')) needed.add(String(n(r).accountNumber));
    const inactive = await em.find(Account, {
      where: { companyId, isActive: false },
    });
    for (const acct of inactive.filter((a) => needed.has(a.accountNumber))) {
      await em.update(Account, { id: acct.id }, { isActive: true });
      state.records.push({
        recordType: 'account',
        recordId: acct.id,
        meta: { reactivated: true },
      });
    }

    const chart = await em.find(Account, { where: { companyId } });
    const accountId = new Map(chart.map((a) => [a.accountNumber, a.id]));
    const idOf = (number: string) => {
      const id = accountId.get(number);
      if (!id)
        throw new BadRequestException({
          code: 'UNKNOWN_ACCOUNT',
          message: `Account ${number} is not in the chart of accounts.`,
        });
      return id;
    };

    // ── Trial balance ─────────────────────────────────────────────────
    const tbLines: PostingLineInput[] = [];
    for (const r of imported('trial_balance')) {
      const v = n(r);
      const target =
        v.targetAccount === 'NEW'
          ? String(v.accountNumber)
          : String(v.targetAccount ?? '');
      if (!target)
        throw new BadRequestException({
          code: 'UNKNOWN_ACCOUNT',
          message: `Row ${r.rowNumber} of ${r.sheet} has no FinMatrix account.`,
        });
      const debit = d(v.debit);
      const credit = d(v.credit);
      if (debit.isZero() && credit.isZero()) continue;
      const viaClearing = CONTROL_ACCOUNTS.has(target);
      const net = debit.minus(credit);
      // decimal.js calls zero positive; compare explicitly, and a row whose
      // debit and credit cancel carries nothing to post.
      if (net.isZero()) continue;
      tbLines.push({
        accountId: viaClearing ? clearing.id : idOf(target),
        description:
          `${String(v.accountNumber)} ${String(v.accountName ?? '')}`
            .trim()
            .slice(0, 200) +
          (viaClearing ? ` → ${target} via Migration Clearing` : ''),
        debit: net.greaterThan(0) ? net.toFixed(4) : '0',
        credit: net.lessThan(0) ? net.abs().toFixed(4) : '0',
      });
    }
    if (tbLines.length >= 2) {
      await this.postEntry(
        state,
        `Migration: trial balance from ${batch.sourceSystem} as at ${batch.cutoverDate}`,
        tbLines,
      );
    }

    // ── Masters ───────────────────────────────────────────────────────
    const m: Materialised = {
      customers: new Map(),
      vendors: new Map(),
      items: new Map(),
      accounts: accountId,
      invoiceIds: [],
      billIds: [],
    };
    await this.materialiseParties(state, 'customers', staging, m.customers);
    await this.materialiseParties(state, 'vendors', staging, m.vendors);
    await this.materialiseItems(state, staging, m.items);

    // Open items may name a party the owner chose to create.
    for (const [type, map, entityKey] of [
      ['open_invoices', m.customers, 'customer'],
      ['open_bills', m.vendors, 'vendor'],
    ] as const) {
      for (const r of imported(type)) {
        const ref = n(r)[`${entityKey}Ref`] as
          | { kind: string; id: string }
          | undefined;
        if (!ref) continue;
        const key = `${ref.kind}:${ref.id}`;
        if (ref.kind === 'existing') map.set(key, ref.id);
        if (ref.kind === 'create' && !map.has(key)) {
          const id = await this.createParty(
            state,
            entityKey === 'customer' ? 'customers' : 'vendors',
            { name: ref.id },
          );
          map.set(key, id);
        }
      }
    }
    for (const r of imported('stock')) {
      const ref = n(r).skuRef as { kind: string; id: string } | undefined;
      if (ref?.kind === 'existing') m.items.set(`existing:${ref.id}`, ref.id);
    }

    // ── Open invoices ─────────────────────────────────────────────────
    const ar = idOf(ACCT_AR);
    const ap = idOf(ACCT_AP);
    const invoiceRows = imported('open_invoices');
    for (let i = 0; i < invoiceRows.length; i += OPEN_ITEM_CHUNK) {
      const chunk = invoiceRows.slice(i, i + OPEN_ITEM_CHUNK);
      const total = chunk.reduce(
        (s, r) => s.plus(d(n(r).amountDue)),
        new Decimal(0),
      );
      const lines: PostingLineInput[] = chunk.map((r) => ({
        accountId: ar,
        description:
          `Open invoice ${String(n(r).invoiceNumber)} — ${String(n(r).customer)}`.slice(
            0,
            200,
          ),
        debit: d(n(r).amountDue).toFixed(4),
        credit: '0',
      }));
      lines.push({
        accountId: clearing.id,
        description: 'Migration Clearing',
        debit: '0',
        credit: total.toFixed(4),
      });
      const entry = await this.postEntry(
        state,
        `Migration: ${chunk.length} open invoice${chunk.length === 1 ? '' : 's'} from ${batch.sourceSystem}`,
        lines,
      );
      for (const r of chunk) {
        const id = await this.createInvoice(state, r, m, entry.id);
        m.invoiceIds.push(id);
      }
    }
    state.created.invoices = invoiceRows.length;

    // ── Open bills ────────────────────────────────────────────────────
    const billRows = imported('open_bills');
    for (let i = 0; i < billRows.length; i += OPEN_ITEM_CHUNK) {
      const chunk = billRows.slice(i, i + OPEN_ITEM_CHUNK);
      const total = chunk.reduce(
        (s, r) => s.plus(d(n(r).amountDue)),
        new Decimal(0),
      );
      const lines: PostingLineInput[] = [
        {
          accountId: clearing.id,
          description: 'Migration Clearing',
          debit: total.toFixed(4),
          credit: '0',
        },
      ];
      for (const r of chunk) {
        lines.push({
          accountId: ap,
          description:
            `Open bill ${String(n(r).billNumber)} — ${String(n(r).vendor)}`.slice(
              0,
              200,
            ),
          debit: '0',
          credit: d(n(r).amountDue).toFixed(4),
        });
      }
      const entry = await this.postEntry(
        state,
        `Migration: ${chunk.length} open bill${chunk.length === 1 ? '' : 's'} from ${batch.sourceSystem}`,
        lines,
      );
      for (const r of chunk) {
        const id = await this.createBill(state, r, m, entry.id, clearing.id);
        m.billIds.push(id);
      }
    }
    state.created.bills = billRows.length;

    // ── Stock ─────────────────────────────────────────────────────────
    const stockRows = imported('stock');
    if (stockRows.length > 0) {
      const entries: Array<{ item: InventoryItem; quantity: Decimal }> = [];
      for (const r of stockRows) {
        const ref = n(r).skuRef as { kind: string; id: string };
        const itemId = m.items.get(`${ref.kind}:${ref.id}`);
        if (!itemId)
          throw new BadRequestException({
            code: 'UNKNOWN_ITEM',
            message: `Stock row ${r.rowNumber}: item ${String(n(r).sku)} could not be found.`,
          });
        const item = await em.findOneOrFail(InventoryItem, {
          where: { id: itemId, companyId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!d(item.quantityOnHand).isZero()) {
          throw new BadRequestException({
            code: 'DUPLICATE_RECORD',
            message: `${item.sku} already has stock on hand; its opening stock cannot be set by a migration.`,
          });
        }
        if (ref.kind === 'existing')
          state.records.push({
            recordType: 'item_touched',
            recordId: item.id,
            meta: {
              unitCost: item.unitCost,
              quantityOnHand: item.quantityOnHand,
            },
          });
        const qty = d(n(r).quantityOnHand);
        item.unitCost = d(n(r).unitCost).toFixed(4);
        item.quantityOnHand = qty.toFixed(4);
        await em.save(item);
        entries.push({ item, quantity: qty });
      }
      const journal = await this.inventory.postOpeningStockBatchJe(
        em,
        batch.companyId,
        state.userId,
        entries,
        batch.cutoverDate,
        `Migration: opening stock, ${entries.length} item${entries.length === 1 ? '' : 's'} from ${batch.sourceSystem}`,
        {
          creditAccountNumber: ACCT_MIGRATION_CLEARING,
          creditDescription: 'Migration Clearing',
          sourceType: 'migration',
          sourceId: batch.id,
        },
      );
      if (journal) {
        state.records.push({
          recordType: 'journal_entry',
          recordId: journal.id,
        });
        const value = entries.reduce(
          (s, e) => s.plus(e.quantity.times(d(e.item.unitCost))),
          new Decimal(0),
        );
        state.postings.push({
          reference: journal.reference,
          memo: 'Opening stock',
          lines: entries.length + 1,
          total: value.toFixed(2),
        });
      }
      for (const { item, quantity } of entries) {
        const move = await recordMovementAtAverage(em, item, {
          date: batch.cutoverDate,
          type: 'adjustment',
          quantityChange: quantity,
          balanceAfter: quantity,
          description: `Opening stock (migration from ${batch.sourceSystem})`,
          reference: journal?.reference ?? null,
          sourceType: 'migration',
          sourceId: batch.id,
          createdBy: state.userId,
        });
        state.records.push({ recordType: 'movement', recordId: move.id });
      }
      state.created.stockItems = entries.length;
    }
    return m;
  }

  private async postEntry(
    state: RunState,
    memo: string,
    lines: PostingLineInput[],
  ) {
    const entry = await this.posting.createEntry(state.em, {
      companyId: state.batch.companyId,
      date: state.batch.cutoverDate,
      memo,
      createdBy: state.userId,
      status: 'posted',
      lines: lines.map((l, i) => ({ ...l, lineOrder: i })),
      sourceType: 'migration',
      sourceId: state.batch.id,
    });
    state.records.push({ recordType: 'journal_entry', recordId: entry.id });
    state.postings.push({
      reference: entry.reference,
      memo,
      lines: lines.length,
      total: d(entry.totalDebits).toFixed(2),
    });
    return entry;
  }

  private async materialiseParties(
    state: RunState,
    key: 'customers' | 'vendors',
    staging: MigrationStagingRow[],
    map: Map<string, string>,
  ) {
    const rows = staging.filter((r) => r.entityType === key);
    let created = 0;
    for (const r of rows.filter((x) => x.outcome === 'imported')) {
      const id = await this.createParty(
        state,
        key,
        r.normalized as Record<string, unknown>,
      );
      map.set(`row:${r.sheet}:${r.rowNumber}`, id);
      created += 1;
    }
    for (const r of rows.filter((x) => x.outcome === 'merged')) {
      if (r.match?.recordId)
        map.set(`row:${r.sheet}:${r.rowNumber}`, r.match.recordId);
    }
    for (const r of rows.filter(
      (x) => x.outcome === 'merged' && x.match?.mergedIntoRowId,
    )) {
      const target = map.get(`row:${r.match!.mergedIntoRowId}`);
      if (target) map.set(`row:${r.sheet}:${r.rowNumber}`, target);
    }
    state.created[key] = (state.created[key] ?? 0) + created;
  }

  private async createParty(
    state: RunState,
    key: 'customers' | 'vendors',
    v: Record<string, unknown>,
  ): Promise<string> {
    const { em, batch } = state;
    const kind = key === 'customers' ? 'customer' : 'vendor';
    const typed = normalizePartyCode(v.code as string | null | undefined);
    const code =
      typed && PARTY_CODE_PATTERN.test(typed)
        ? typed
        : await nextPartyCode(em, batch.companyId, kind);
    const address: Address | null =
      v.address || v.city
        ? {
            ...(v.address ? { street: String(v.address) } : {}),
            ...(v.city ? { city: String(v.city) } : {}),
          }
        : null;
    const terms = (v.paymentTerms as PaymentTerms | null) ?? 'net30';
    try {
      if (key === 'customers') {
        const c = em.create(Customer, {
          companyId: batch.companyId,
          code,
          name: String(v.name).slice(0, 200),
          company: null,
          email: (v.email as string) ?? null,
          phone: (v.phone as string) ?? null,
          billingAddress: address,
          shippingAddress: null,
          creditLimit: d(v.creditLimit).toFixed(4),
          paymentTerms: terms,
          balance: '0',
          isActive: true,
          notes: `Migrated from ${batch.sourceSystem}`,
          contactPerson: null,
          taxId: (v.taxId as string) ?? null,
          collectionsPaused: false,
        });
        await em.save(c);
        state.records.push({ recordType: 'customer', recordId: c.id });
        return c.id;
      }
      const ven = em.create(Vendor, {
        companyId: batch.companyId,
        code,
        companyName: String(v.name).slice(0, 200),
        contactPerson: null,
        email: (v.email as string) ?? null,
        phone: (v.phone as string) ?? null,
        address,
        paymentTerms: terms,
        taxId: (v.taxId as string) ?? null,
        defaultExpenseAccountId: null,
        balance: '0',
        isActive: true,
        notes: `Migrated from ${batch.sourceSystem}`,
      });
      await em.save(ven);
      state.records.push({ recordType: 'vendor', recordId: ven.id });
      return ven.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException({
          code: 'DUPLICATE_RECORD',
          message: `The ${kind} code ${code} is already used by another ${kind}.`,
        });
      }
      throw err;
    }
  }

  private async materialiseItems(
    state: RunState,
    staging: MigrationStagingRow[],
    map: Map<string, string>,
  ) {
    const { em, batch } = state;
    const rows = staging.filter((r) => r.entityType === 'items');
    const stockCost = new Map<string, string>();
    for (const r of staging.filter(
      (x) => x.entityType === 'stock' && x.outcome === 'imported',
    )) {
      stockCost.set(
        normalizeKey((r.normalized as Record<string, unknown>).sku),
        String((r.normalized as Record<string, unknown>).unitCost),
      );
    }
    let created = 0;
    for (const r of rows.filter((x) => x.outcome === 'imported')) {
      const v = r.normalized as Record<string, unknown>;
      const item = em.create(InventoryItem, {
        companyId: batch.companyId,
        sku: String(v.sku).slice(0, 64),
        name: String(v.name).slice(0, 200),
        description: null,
        category: (v.category as string) ?? null,
        unitOfMeasure: ((v.unit as string) ?? 'unit').slice(0, 32),
        costMethod: 'average',
        unitCost: d(stockCost.get(normalizeKey(v.sku)) ?? v.unitCost).toFixed(
          4,
        ),
        sellingPrice: d(v.sellingPrice).toFixed(4),
        quantityOnHand: '0',
        quantityOnOrder: '0',
        quantityCommitted: '0',
        reorderPoint: d(v.reorderPoint).toFixed(4),
        isActive: true,
      });
      await em.save(item);
      state.records.push({ recordType: 'item', recordId: item.id });
      map.set(`row:${r.sheet}:${r.rowNumber}`, item.id);
      created += 1;
    }
    for (const r of rows.filter((x) => x.outcome === 'merged')) {
      if (r.match?.recordId)
        map.set(`row:${r.sheet}:${r.rowNumber}`, r.match.recordId);
    }
    for (const r of rows.filter(
      (x) => x.outcome === 'merged' && x.match?.mergedIntoRowId,
    )) {
      const target = map.get(`row:${r.match!.mergedIntoRowId}`);
      if (target) map.set(`row:${r.sheet}:${r.rowNumber}`, target);
    }
    state.created.items = created;
  }

  private async createInvoice(
    state: RunState,
    r: MigrationStagingRow,
    m: Materialised,
    journalEntryId: string,
  ): Promise<string> {
    const { em, batch } = state;
    const v = r.normalized as Record<string, unknown>;
    const ref = v.customerRef as { kind: string; id: string };
    const customerId = m.customers.get(`${ref.kind}:${ref.id}`);
    if (!customerId)
      throw new BadRequestException({
        code: 'UNKNOWN_CUSTOMER',
        message: `Open invoice ${String(v.invoiceNumber)}: customer ${String(v.customer)} could not be found.`,
      });
    const customer = await em.findOneOrFail(Customer, {
      where: { id: customerId, companyId: batch.companyId },
    });
    const original = d(v.originalAmount);
    const due = d(v.amountDue);
    const paid = original.minus(due);
    const invoiceDate = String(v.invoiceDate);
    const invoice = em.create(Invoice, {
      companyId: batch.companyId,
      customerId,
      invoiceNumber: String(v.invoiceNumber),
      invoiceDate,
      dueDate: v.dueDate ? String(v.dueDate) : addDaysIso(invoiceDate, 30),
      subtotal: original.toFixed(4),
      discountType: 'none',
      discountValue: '0',
      discountAmount: '0',
      taxAmount: '0',
      total: original.toFixed(4),
      amountPaid: paid.toFixed(4),
      balance: due.toFixed(4),
      status: paid.greaterThan(0) ? 'partial' : 'sent',
      paymentTerms: customer.paymentTerms,
      notes: `Open balance brought forward from ${batch.sourceSystem} at ${batch.cutoverDate}.`,
      journalEntryId,
      createdBy: state.userId,
      source: 'migration',
      legacyRef: String(v.invoiceNumber).slice(0, 64),
      migrationBatchId: batch.id,
    });
    try {
      await em.save(invoice);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new BadRequestException({
          code: 'DUPLICATE_RECORD',
          message: `Invoice number ${String(v.invoiceNumber)} is already used.`,
        });
      throw err;
    }
    await em.save(
      em.create(InvoiceLineItem, {
        invoiceId: invoice.id,
        description: `Opening balance brought forward — invoice ${String(v.invoiceNumber)} from ${batch.sourceSystem}`,
        quantity: '1',
        unitPrice: original.toFixed(4),
        taxRate: '0',
        taxAmount: '0',
        lineTotal: original.toFixed(4),
        accountId: null,
        itemId: null,
        lineOrder: 0,
      }),
    );
    await em.query(
      `UPDATE customers SET balance = (balance::numeric + $1)::numeric(18,4) WHERE id = $2 AND company_id = $3`,
      [due.toFixed(4), customerId, batch.companyId],
    );
    if (ref.kind === 'existing')
      state.records.push({
        recordType: 'customer_touched',
        recordId: customerId,
        meta: { delta: due.toFixed(4) },
      });
    state.records.push({ recordType: 'invoice', recordId: invoice.id });
    return invoice.id;
  }

  private async createBill(
    state: RunState,
    r: MigrationStagingRow,
    m: Materialised,
    journalEntryId: string,
    clearingId: string,
  ): Promise<string> {
    const { em, batch } = state;
    const v = r.normalized as Record<string, unknown>;
    const ref = v.vendorRef as { kind: string; id: string };
    const vendorId = m.vendors.get(`${ref.kind}:${ref.id}`);
    if (!vendorId)
      throw new BadRequestException({
        code: 'UNKNOWN_VENDOR',
        message: `Open bill ${String(v.billNumber)}: vendor ${String(v.vendor)} could not be found.`,
      });
    const original = d(v.originalAmount);
    const due = d(v.amountDue);
    const paid = original.minus(due);
    const billDate = String(v.billDate);
    const bill = em.create(Bill, {
      companyId: batch.companyId,
      vendorId,
      billNumber: String(v.billNumber),
      billDate,
      dueDate: v.dueDate ? String(v.dueDate) : addDaysIso(billDate, 30),
      subtotal: original.toFixed(4),
      taxAmount: '0',
      total: original.toFixed(4),
      amountPaid: paid.toFixed(4),
      balance: due.toFixed(4),
      status: paid.greaterThan(0) ? 'partial' : 'open',
      memo: `Open balance brought forward from ${batch.sourceSystem} at ${batch.cutoverDate}.`,
      journalEntryId,
      purchaseOrderId: null,
      source: 'migration',
      legacyRef: String(v.billNumber).slice(0, 64),
      migrationBatchId: batch.id,
    });
    await em.save(bill);
    // A bill line names an account; the migrated bill has no expense of its
    // own (it was expensed in the old books), so its line points at clearing.
    await em.save(
      em.create(BillLineItem, {
        billId: bill.id,
        accountId: clearingId,
        description: `Opening balance brought forward — bill ${String(v.billNumber)} from ${batch.sourceSystem}`,
        amount: original.toFixed(4),
        taxRate: '0',
        taxAmount: '0',
        lineOrder: 0,
        purchaseOrderLineId: null,
        quantity: null,
        grniAmount: null,
      }),
    );
    await em.query(
      `UPDATE vendors SET balance = (balance::numeric + $1)::numeric(18,4) WHERE id = $2 AND company_id = $3`,
      [due.toFixed(4), vendorId, batch.companyId],
    );
    if (ref.kind === 'existing')
      state.records.push({
        recordType: 'vendor_touched',
        recordId: vendorId,
        meta: { delta: due.toFixed(4) },
      });
    state.records.push({ recordType: 'bill', recordId: bill.id });
    return bill.id;
  }

  // ── After the checks pass (commit only) ───────────────────────────────
  private async finish(
    state: RunState,
    company: Company,
    staging: MigrationStagingRow[],
  ) {
    const { em, batch } = state;
    // Period lock: nothing may be posted before the cutover any more.
    const lock = dayBefore(batch.cutoverDate);
    state.records.push({
      recordType: 'company_touched',
      recordId: company.id,
      meta: {
        booksLockedUntil: company.booksLockedUntil,
        booksLockedAt: company.booksLockedAt
          ? company.booksLockedAt.toISOString()
          : null,
      },
    });
    if (!company.booksLockedUntil || company.booksLockedUntil < lock) {
      await em.update(
        Company,
        { id: company.id },
        { booksLockedUntil: lock, booksLockedAt: new Date() },
      );
    }
    // Document series: a migrated INV-2026-0042 must not be issued again.
    for (const [series, type, field] of [
      ['INV', 'open_invoices', 'invoiceNumber'],
      ['BILL', 'open_bills', 'billNumber'],
    ] as const) {
      const highest = new Map<number, number>();
      for (const r of staging.filter(
        (x) => x.entityType === type && x.outcome === 'imported',
      )) {
        const match = new RegExp(`^${series}-(\\d{4})-(\\d+)$`).exec(
          String((r.normalized as Record<string, unknown>)[field] ?? ''),
        );
        if (!match) continue;
        const year = Number(match[1]);
        highest.set(year, Math.max(highest.get(year) ?? 0, Number(match[2])));
      }
      for (const [year, value] of highest) {
        await em.query(
          `INSERT INTO document_sequences (company_id, doc_type, year, last_value, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (company_id, doc_type, year)
             DO UPDATE SET last_value = GREATEST(document_sequences.last_value, EXCLUDED.last_value), updated_at = now()`,
          [batch.companyId, series, year, value],
        );
      }
    }
    if (state.records.length) {
      await em.save(
        MigrationBatchRecord,
        state.records.map((r) =>
          em.create(MigrationBatchRecord, {
            companyId: batch.companyId,
            batchId: batch.id,
            recordType: r.recordType,
            recordId: r.recordId,
            meta: r.meta ?? null,
          }),
        ),
        { chunk: 500 },
      );
    }
    await em.update(
      MigrationBatch,
      { id: batch.id },
      { previousBooksLockedUntil: company.booksLockedUntil },
    );
  }

  // ── Certificate data ─────────────────────────────────────────────────
  private async spotChecks(
    em: EntityManager,
    batch: MigrationBatch,
    staging: MigrationStagingRow[],
    m: Materialised,
  ): Promise<SpotCheck[]> {
    const out: SpotCheck[] = [];
    for (const [type, kind, refField, partyMap, table] of [
      ['open_invoices', 'customer', 'customerRef', m.customers, 'customers'],
      ['open_bills', 'vendor', 'vendorRef', m.vendors, 'vendors'],
    ] as const) {
      const byParty = new Map<
        string,
        { name: string; due: Decimal; docs: number; asTyped: string[] }
      >();
      for (const r of staging.filter(
        (x) => x.entityType === type && x.outcome === 'imported',
      )) {
        const v = r.normalized as Record<string, unknown>;
        const ref = v[refField] as { kind: string; id: string } | undefined;
        const id = ref ? partyMap.get(`${ref.kind}:${ref.id}`) : undefined;
        if (!id) continue;
        const cur = byParty.get(id) ?? {
          name: String(v[kind] ?? ''),
          due: new Decimal(0),
          docs: 0,
          asTyped: [] as string[],
        };
        cur.due = cur.due.plus(d(v.amountDue));
        cur.docs += 1;
        cur.asTyped.push(String(v.amountDueText ?? v.amountDue ?? ''));
        byParty.set(id, cur);
      }
      const ids = seededPick(
        [...byParty.keys()].sort(),
        5,
        `${batch.id}:${kind}`,
      );
      if (ids.length === 0) continue;
      const nameCol = kind === 'customer' ? 'name' : 'company_name';
      const rows: Array<{ id: string; name: string; balance: string }> =
        await em.query(
          `SELECT id, ${nameCol} AS name, balance::text FROM ${table} WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [batch.companyId, ids],
        );
      for (const id of ids) {
        const exp = byParty.get(id)!;
        const row = rows.find((x) => x.id === id);
        const actual = d(row?.balance);
        out.push({
          kind,
          name: row?.name ?? exp.name,
          documents: exp.docs,
          asTyped: exp.asTyped,
          sourceBalance: exp.due.toFixed(2),
          finmatrixBalance: actual.toFixed(2),
          matches: actual.equals(exp.due),
        });
      }
    }
    return out;
  }

  private async preview(
    state: RunState,
    company: Company,
    staging: MigrationStagingRow[],
    checks: MigrationCheckResult[],
    mode: 'dry-run' | 'commit',
    spot: SpotCheck[],
    asTyped: AsTypedFigures,
  ): Promise<CertificatePreview> {
    const counts = new Map<string, CertificatePreview['rowCounts'][number]>();
    for (const r of staging) {
      const key = r.entityType ?? 'unknown';
      const c = counts.get(key) ?? {
        entity: key,
        source: 0,
        imported: 0,
        merged: 0,
        rejected: 0,
        pending: 0,
      };
      c.source += 1;
      c[r.outcome] += 1;
      counts.set(key, c);
    }
    const rejected = staging.filter((r) => r.outcome === 'rejected');
    return {
      batchId: state.batch.id,
      companyName: company.name,
      sourceSystem: state.batch.sourceSystem,
      cutoverDate: state.batch.cutoverDate,
      generatedAt: new Date().toISOString(),
      mode,
      checks,
      allPassed:
        checks.length === CHECK_CODES.length && checks.every((c) => c.passed),
      rowCounts: [...counts.values()],
      rejectedRows: rejected.slice(0, 500).map((r) => ({
        sheet: r.sheet,
        rowNumber: r.rowNumber,
        reason: r.reason ?? '',
      })),
      rejectedTotal: rejected.length,
      spotChecks: spot,
      asTyped,
      postings: state.postings,
      created: state.created,
    };
  }
}

/**
 * v1 migrates into empty books only: no posted ledger row from anything but
 * a migration that was later rolled back, and no migration already in place.
 * Draft documents and master data may exist.
 */
export async function assertBooksEmpty(
  em: EntityManager,
  companyId: string,
  exceptBatchId?: string,
): Promise<void> {
  const [ledger] = await em.query(
    `SELECT COUNT(*)::int AS n FROM general_ledger
      WHERE company_id = $1 AND source_type NOT IN ('migration', 'migration_rollback')`,
    [companyId],
  );
  const [live] = await em.query(
    `SELECT COUNT(*)::int AS n FROM migration_batches
      WHERE company_id = $1 AND status IN ('committed', 'closed') AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [companyId, exceptBatchId ?? null],
  );
  if (Number(ledger.n) > 0 || Number(live.n) > 0) {
    throw new ConflictException({
      code: 'MIGRATION_REQUIRES_EMPTY_BOOKS',
      message:
        Number(live.n) > 0
          ? 'This company already has a migration in place. Undo it before starting another.'
          : 'This company already has transactions in its books. The Migration Center can only bring opening balances into a company that has not posted anything yet — start a new company for the migration, or contact support.',
    });
  }
}

function notRun(reason: string): MigrationCheckResult[] {
  return CHECK_CODES.slice(2).map((code) => ({
    code,
    label: CHECK_LABELS[code],
    expected: '—',
    actual: '—',
    difference: '—',
    passed: false,
    details: [{ note: reason }],
  }));
}

/** The kind as a valid subtype for the type, case-insensitively; else the type's catch-all. */
export function subTypeFor(
  type: AccountType,
  kind: string | null | undefined,
): string {
  const allowed = ACCOUNT_SUB_TYPES[type] ?? [];
  const k = normalizeKey(kind);
  const hit = allowed.find((s) => normalizeKey(s) === k);
  if (hit) return hit;
  if (k) {
    const partial = allowed.find(
      (s) => normalizeKey(s).includes(k) || k.includes(normalizeKey(s)),
    );
    if (partial) return partial;
  }
  return {
    asset: 'Other Asset',
    liability: 'Other Liability',
    equity: 'Other Equity',
    revenue: 'Sales',
    expense: 'Operating',
  }[type];
}

/** A deterministic sample: the same batch always shows the same spot checks. */
function seededPick<T>(items: T[], k: number, seed: string): T[] {
  return items
    .map((item, i) => ({
      item,
      key: createHash('sha256').update(`${seed}:${i}`).digest('hex'),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, k)
    .map((x) => x.item);
}
