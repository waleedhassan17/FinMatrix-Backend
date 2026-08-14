import { Injectable, Logger } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  QueryRunner,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { AuditAction, AuditTrailEntry } from './audit-trail.entity';
import { currentActor } from '../context/request-context';

import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { Bill } from '../../modules/bills/entities/bill.entity';
import { BillPayment } from '../../modules/bills/entities/bill-payment.entity';
import { Payment } from '../../modules/payments/entities/payment.entity';
import { CreditMemo } from '../../modules/credit-memos/entities/credit-memo.entity';
import { VendorCredit } from '../../modules/vendor-credits/entities/vendor-credit.entity';
import { InventoryAdjustment } from '../../modules/inventory/entities/inventory-adjustment.entity';
import { TaxPayment } from '../../modules/tax/entities/tax-payment.entity';
import { JournalEntry } from '../../modules/journal-entries/entities/journal-entry.entity';

/**
 * The financial documents worth an audit row, mapped to the module name
 * recorded alongside. Anything not listed here is ignored, so line-item and
 * join tables do not each produce their own row — the parent document is the
 * logical unit of change.
 */
const WATCHED = new Map<Function, { module: string; resourceType: string }>([
  [Invoice, { module: 'invoices', resourceType: 'invoice' }],
  [Bill, { module: 'bills', resourceType: 'bill' }],
  [BillPayment, { module: 'bills', resourceType: 'bill_payment' }],
  [Payment, { module: 'payments', resourceType: 'payment' }],
  [CreditMemo, { module: 'credit_memos', resourceType: 'credit_memo' }],
  [VendorCredit, { module: 'vendor_credits', resourceType: 'vendor_credit' }],
  [InventoryAdjustment, { module: 'inventory', resourceType: 'inventory_adjustment' }],
  [TaxPayment, { module: 'tax', resourceType: 'tax_payment' }],
  [JournalEntry, { module: 'journal_entries', resourceType: 'journal_entry' }],
]);

interface PendingAudit {
  action: AuditAction;
  module: string;
  resourceType: string;
  resourceId: string | null;
  companyId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Writes an audit_trail row for every create / update / void / delete of a
 * financial document (audit gap G2).
 *
 * Centralised the same way posting is: one subscriber at the data layer, so
 * coverage does not depend on each of the fifteen modules remembering to call
 * an audit helper.
 *
 * Two properties matter more than completeness:
 *
 *   1. Auditing must never fail the thing it describes. Rows are buffered
 *      during the transaction and written AFTER it commits, on a separate
 *      connection, inside a try/catch. A broken audit write can therefore
 *      neither roll back a posting nor record a mutation that was rolled back.
 *
 *   2. One logical mutation = one row. Services frequently save the same
 *      document twice in a transaction (credit-memos saves the memo, posts the
 *      journal entry, then saves again to attach journal_entry_id). Events are
 *      collapsed per resource per transaction before flushing.
 */
@Injectable()
export class FinancialAuditSubscriber implements EntitySubscriberInterface {
  private readonly logger = new Logger(FinancialAuditSubscriber.name);

  /** Buffered rows keyed by the transaction's query runner. */
  private readonly pending = new Map<QueryRunner, PendingAudit[]>();

  constructor(private readonly dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  afterInsert(event: InsertEvent<unknown>): void {
    this.capture(event.queryRunner, event.metadata.target, 'create', null, event.entity);
  }

  afterUpdate(event: UpdateEvent<unknown>): void {
    const before = event.databaseEntity ?? null;
    const after = event.entity ?? null;
    // A void is an UPDATE, not a delete — detect the status transition so the
    // correction path is distinguishable from an ordinary edit.
    const action: AuditAction =
      this.statusOf(after) === 'void' && this.statusOf(before) !== 'void'
        ? 'void'
        : 'update';
    this.capture(event.queryRunner, event.metadata.target, action, before, after);
  }

  afterRemove(event: RemoveEvent<unknown>): void {
    // Bills and payments unwind the ledger through delete rather than a
    // /void route, so a hard remove is a financial mutation too.
    const before = event.databaseEntity ?? event.entity ?? null;
    this.capture(event.queryRunner, event.metadata.target, 'delete', before, null);
  }

  afterTransactionCommit(event: { queryRunner: QueryRunner }): void {
    const rows = this.pending.get(event.queryRunner);
    this.pending.delete(event.queryRunner);
    if (rows?.length) void this.flush(rows);
  }

  afterTransactionRollback(event: { queryRunner: QueryRunner }): void {
    // The mutation never happened; drop the buffer rather than record it.
    this.pending.delete(event.queryRunner);
  }

  private capture(
    queryRunner: QueryRunner,
    target: Function | string,
    action: AuditAction,
    before: unknown,
    after: unknown,
  ): void {
    try {
      const watched =
        typeof target === 'function' ? WATCHED.get(target) : undefined;
      if (!watched) return;

      const actor = currentActor();
      const source = (after ?? before) as Record<string, unknown> | null;
      const row: PendingAudit = {
        action,
        module: watched.module,
        resourceType: watched.resourceType,
        resourceId: (source?.id as string) ?? null,
        companyId: (source?.companyId as string) ?? actor.companyId,
        before: this.snapshot(before),
        after: this.snapshot(after),
        userId: actor.userId,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      };

      // Outside a transaction there is no commit hook to flush on, so write
      // straight away (still fire-and-forget).
      if (!queryRunner?.isTransactionActive) {
        void this.flush([row]);
        return;
      }
      const buffer = this.pending.get(queryRunner);
      if (buffer) buffer.push(row);
      else this.pending.set(queryRunner, [row]);
    } catch (err) {
      this.logger.error(`audit capture failed: ${(err as Error).message}`);
    }
  }

  /**
   * Collapse to one row per resource, then persist. Uses the DataSource's own
   * manager, NOT the committed transaction's query runner, so this is an
   * independent write.
   */
  private async flush(rows: PendingAudit[]): Promise<void> {
    try {
      const collapsed = this.collapse(rows).filter((r) => r.companyId);
      if (collapsed.length === 0) return;

      const repo = this.dataSource.getRepository(AuditTrailEntry);
      const entities = collapsed.map((r) => {
        const row = new AuditTrailEntry();
        row.companyId = r.companyId as string;
        row.userId = r.userId;
        row.action = r.action;
        row.module = r.module;
        row.resourceType = r.resourceType;
        row.resourceId = r.resourceId;
        row.beforeValues = r.before;
        row.afterValues = r.after;
        row.ipAddress = r.ipAddress;
        row.userAgent = r.userAgent;
        return row;
      });
      await repo.save(entities);
    } catch (err) {
      // Log and alert; never rethrow. The financial transaction has already
      // committed and must not be affected by a bookkeeping failure.
      this.logger.error(
        `Failed to write ${rows.length} audit_trail row(s): ${(err as Error).message}`,
      );
    }
  }

  /**
   * One logical mutation per resource: keep the earliest before-image and the
   * latest after-image. A create followed by updates in the same transaction
   * stays a create; any void in the group wins over a plain update.
   */
  private collapse(rows: PendingAudit[]): PendingAudit[] {
    const byResource = new Map<string, PendingAudit>();
    for (const row of rows) {
      const key = `${row.resourceType}:${row.resourceId ?? 'null'}`;
      const existing = byResource.get(key);
      if (!existing) {
        byResource.set(key, { ...row });
        continue;
      }
      existing.after = row.after ?? existing.after;
      if (existing.action !== 'create') {
        if (row.action === 'delete' || row.action === 'void') {
          existing.action = row.action;
        }
      }
      if (row.action === 'delete') existing.after = null;
    }
    return [...byResource.values()];
  }

  /**
   * Plain-object copy of the document's own columns. Relations are dropped —
   * they are separately audited or irrelevant, and a loaded graph would bloat
   * every row. Nothing financial is redacted; this is the record of what
   * changed.
   */
  private snapshot(entity: unknown): Record<string, unknown> | null {
    if (!entity || typeof entity !== 'object') return null;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entity)) {
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (value instanceof Date) {
        out[key] = value.toISOString();
      } else if (typeof value !== 'object') {
        out[key] = value;
      }
      // Arrays and nested entities (loaded relations) are intentionally skipped.
    }
    return Object.keys(out).length ? out : null;
  }

  private statusOf(entity: unknown): string | null {
    if (!entity || typeof entity !== 'object') return null;
    const status = (entity as { status?: unknown }).status;
    return typeof status === 'string' ? status : null;
  }
}
