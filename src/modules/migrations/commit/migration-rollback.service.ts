import { ConflictException, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, In } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Bill } from '../../bills/entities/bill.entity';
import { BillLineItem } from '../../bills/entities/bill-line-item.entity';
import { Company } from '../../companies/entities/company.entity';
import { Customer } from '../../customers/entities/customer.entity';
import { InventoryItem } from '../../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../../inventory/entities/inventory-movement.entity';
import { Invoice } from '../../invoices/entities/invoice.entity';
import { InvoiceLineItem } from '../../invoices/entities/invoice-line-item.entity';
import { JournalEntry } from '../../journal-entries/entities/journal-entry.entity';
import { assertTransition } from '../state-machine';
import { PostingService } from '../../journal-entries/posting.service';
import { Vendor } from '../../vendors/entities/vendor.entity';
import { MigrationBatch } from '../entities/migration-batch.entity';
import {
  BatchRecordType,
  MigrationBatchRecord,
} from '../entities/migration-batch-record.entity';

export interface RollbackBlocker {
  kind: string;
  id: string;
  label: string;
}

/**
 * Undo a committed migration (decision D3), in one transaction.
 *
 * The ledger is never edited. Each journal entry the batch posted gets a
 * reversing entry through PostingService.createEntry (debits and credits
 * swapped, reversalOfId set, dated the cutover day) and is marked void — the
 * same thing voiding a manual journal entry does — so the trial balance
 * returns exactly to what it was and the audit trail keeps both.
 *
 * What the batch created is then removed: its invoices and bills with their
 * lines, its stock movements, and the customers, vendors and items it added.
 * Masters it only changed get their prior values back. Accounts it added are
 * deactivated rather than deleted, because the void entries still name them.
 * The period lock goes back to what it was.
 *
 * Refused (409 ROLLBACK_BLOCKED, with the list) as soon as anything outside
 * the batch depends on it: a payment or credit applied to a migrated
 * document, a document raised for a migrated party or item, stock moved on a
 * migrated item, a posting on an account the batch created, or a period
 * closed through the cutover day.
 */
@Injectable()
export class MigrationRollbackService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
  ) {}

  async rollback(
    batch: MigrationBatch,
    userId: string,
  ): Promise<{ reversed: number; removed: Record<string, number> }> {
    return this.dataSource.transaction(async (em) => {
      const company = await em.findOneOrFail(Company, {
        where: { id: batch.companyId },
        lock: { mode: 'pessimistic_write' },
      });
      // The caller checked the status before this transaction; a commit or
      // close may have landed since. Decide on the row as it is now.
      const live = await em.findOneOrFail(MigrationBatch, {
        where: { id: batch.id, companyId: batch.companyId },
        lock: { mode: 'pessimistic_write' },
      });
      assertTransition(live.status, 'rolled_back');
      const records = await em.find(MigrationBatchRecord, {
        where: { batchId: batch.id, companyId: batch.companyId },
      });
      const ids = (t: BatchRecordType) =>
        records.filter((r) => r.recordType === t).map((r) => r.recordId);

      const blockers = await this.blockers(em, batch, company, ids);
      if (blockers.length > 0) {
        throw new ConflictException({
          code: 'ROLLBACK_BLOCKED',
          message: `This migration can no longer be undone: ${blockers.length} record${blockers.length === 1 ? '' : 's'} outside it now depend${blockers.length === 1 ? 's' : ''} on what it brought in. Remove ${blockers.length === 1 ? 'it' : 'them'} first, or keep the migration and correct it with ordinary entries.`,
          details: { blockers: blockers.slice(0, 100), total: blockers.length },
        });
      }

      // 1. Ledger: reverse every entry the batch posted, then mark it void.
      const entries = await em.find(JournalEntry, {
        where: { id: In(ids('journal_entry')), companyId: batch.companyId },
        relations: { lines: true },
      });
      for (const entry of entries) {
        if (entry.status !== 'posted') continue;
        await this.posting.createEntry(em, {
          companyId: batch.companyId,
          date: batch.cutoverDate,
          memo: `Undo migration: reverses ${entry.reference}`,
          createdBy: userId,
          status: 'posted',
          lines: entry.lines
            .slice()
            .sort((a, b) => a.lineOrder - b.lineOrder)
            .map((l, i) => ({
              accountId: l.accountId,
              description: l.description,
              debit: l.credit,
              credit: l.debit,
              lineOrder: i,
            })),
          reversalOfId: entry.id,
          sourceType: 'migration_rollback',
          sourceId: batch.id,
        });
        entry.status = 'void';
        entry.voidReason = 'Migration undone';
        await em.save(entry);
      }

      // 2. Documents.
      const invoiceIds = ids('invoice');
      const billIds = ids('bill');
      if (invoiceIds.length) {
        await em.delete(InvoiceLineItem, { invoiceId: In(invoiceIds) });
        await em.delete(Invoice, {
          id: In(invoiceIds),
          companyId: batch.companyId,
        });
      }
      if (billIds.length) {
        await em.delete(BillLineItem, { billId: In(billIds) });
        await em.delete(Bill, { id: In(billIds), companyId: batch.companyId });
      }
      const movementIds = ids('movement');
      if (movementIds.length)
        await em.delete(InventoryMovement, {
          id: In(movementIds),
          companyId: batch.companyId,
        });

      // 3. Masters it changed get their prior values back…
      for (const r of records.filter(
        (x) =>
          x.recordType === 'customer_touched' ||
          x.recordType === 'vendor_touched',
      )) {
        const table =
          r.recordType === 'customer_touched' ? 'customers' : 'vendors';
        const delta = new Decimal(String(r.meta?.delta ?? 0));
        await em.query(
          `UPDATE ${table} SET balance = (balance::numeric - $1)::numeric(18,4) WHERE id = $2 AND company_id = $3`,
          [delta.toFixed(4), r.recordId, batch.companyId],
        );
      }
      for (const r of records.filter((x) => x.recordType === 'item_touched')) {
        await em.update(
          InventoryItem,
          { id: r.recordId, companyId: batch.companyId },
          {
            unitCost: String(r.meta?.unitCost ?? '0'),
            quantityOnHand: String(r.meta?.quantityOnHand ?? '0'),
          },
        );
      }
      // …and the ones it created go.
      const customerIds = ids('customer');
      const vendorIds = ids('vendor');
      const itemIds = ids('item');
      if (customerIds.length)
        await em.delete(Customer, {
          id: In(customerIds),
          companyId: batch.companyId,
        });
      if (vendorIds.length)
        await em.delete(Vendor, {
          id: In(vendorIds),
          companyId: batch.companyId,
        });
      if (itemIds.length)
        await em.delete(InventoryItem, {
          id: In(itemIds),
          companyId: batch.companyId,
        });

      // 4. Accounts it added: deactivated, never deleted (the void entries name them).
      const accountIds = ids('account');
      if (accountIds.length)
        await em.update(
          Account,
          { id: In(accountIds), companyId: batch.companyId },
          { isActive: false },
        );

      // 5. The period lock goes back.
      const lock = records.find((r) => r.recordType === 'company_touched');
      await em.update(
        Company,
        { id: company.id },
        {
          booksLockedUntil:
            (lock?.meta?.booksLockedUntil as string | null) ?? null,
          booksLockedAt: lock?.meta?.booksLockedAt
            ? new Date(String(lock.meta.booksLockedAt))
            : null,
        },
      );

      await em.update(
        MigrationBatch,
        { id: batch.id },
        { status: 'rolled_back', rolledBackAt: new Date() },
      );
      return {
        reversed: entries.length,
        removed: {
          invoices: invoiceIds.length,
          bills: billIds.length,
          movements: movementIds.length,
          customers: customerIds.length,
          vendors: vendorIds.length,
          items: itemIds.length,
          accountsDeactivated: accountIds.length,
        },
      };
    });
  }

  private async blockers(
    em: EntityManager,
    batch: MigrationBatch,
    company: Company,
    ids: (t: BatchRecordType) => string[],
  ): Promise<RollbackBlocker[]> {
    const c = batch.companyId;
    const out: RollbackBlocker[] = [];
    const add = (rows: Array<{ id: string; label: string }>, kind: string) =>
      rows.forEach((r) => out.push({ kind, id: r.id, label: r.label }));
    const q = (sql: string, params: unknown[]) =>
      em.query(sql, params) as Promise<Array<{ id: string; label: string }>>;

    if (
      company.booksLockedUntil &&
      company.booksLockedUntil >= batch.cutoverDate
    ) {
      out.push({
        kind: 'period_closed',
        id: company.id,
        label: `The books are closed through ${company.booksLockedUntil}, which includes the cutover day ${batch.cutoverDate}. Reopen the period first.`,
      });
    }
    const invoices = ids('invoice');
    const bills = ids('bill');
    const customers = [...ids('customer'), ...ids('customer_touched')];
    const vendors = [...ids('vendor'), ...ids('vendor_touched')];
    const items = [...ids('item'), ...ids('item_touched')];
    const createdAccounts = ids('account');
    const entries = ids('journal_entry');

    if (invoices.length) {
      add(
        await q(
          `SELECT pa.id, 'Payment ' || COALESCE(p.payment_number, p.id::text) || ' applied to ' || i.invoice_number AS label
                     FROM payment_applications pa JOIN payments p ON p.id = pa.payment_id JOIN invoices i ON i.id = pa.invoice_id
                    WHERE i.company_id = $1 AND pa.invoice_id = ANY($2::uuid[])`,
          [c, invoices],
        ),
        'payment',
      );
      add(
        await q(
          `SELECT i.id, 'Invoice ' || i.invoice_number || ' was paid or credited after the migration' AS label
                     FROM invoices i JOIN migration_batch_records r ON r.record_id = i.id AND r.batch_id = $3
                    WHERE i.company_id = $1 AND i.id = ANY($2::uuid[]) AND i.amount_paid <> (i.total - (SELECT (s.normalized->>'amountDue')::numeric FROM migration_staging_rows s WHERE s.batch_id = $3 AND s.entity_type = 'open_invoices' AND s.outcome = 'imported' AND s.normalized->>'invoiceNumber' = i.legacy_ref LIMIT 1))`,
          [c, invoices, batch.id],
        ),
        'invoice_settled',
      );
      add(
        await q(
          `SELECT cm.id, 'Credit memo ' || COALESCE(cm.credit_memo_number, cm.id::text) || ' against ' || i.invoice_number AS label
                     FROM credit_memos cm JOIN invoices i ON i.id = cm.original_invoice_id
                    WHERE cm.company_id = $1 AND cm.original_invoice_id = ANY($2::uuid[])`,
          [c, invoices],
        ),
        'credit_memo',
      );
    }
    if (bills.length) {
      add(
        await q(
          `SELECT a.id, 'Bill payment applied to ' || b.bill_number AS label
                     FROM bill_payment_applications a JOIN bills b ON b.id = a.bill_id
                    WHERE b.company_id = $1 AND a.bill_id = ANY($2::uuid[])`,
          [c, bills],
        ),
        'bill_payment',
      );
      add(
        await q(
          `SELECT vc.id, 'Vendor credit ' || COALESCE(vc.vendor_credit_number, vc.id::text) || ' against ' || b.bill_number AS label
                     FROM vendor_credits vc JOIN bills b ON b.id = vc.original_bill_id
                    WHERE vc.company_id = $1 AND vc.original_bill_id = ANY($2::uuid[])`,
          [c, bills],
        ),
        'vendor_credit',
      );
    }
    if (customers.length) {
      for (const [table, numberCol, label] of [
        ['invoices', 'invoice_number', 'Invoice'],
        ['payments', 'payment_number', 'Receipt'],
        ['credit_memos', 'credit_memo_number', 'Credit memo'],
        ['estimates', 'estimate_number', 'Estimate'],
        ['sales_orders', 'order_number', 'Sales order'],
        ['deliveries', 'reference_no', 'Delivery'],
      ] as const) {
        add(
          await q(
            `SELECT t.id, '${label} ' || COALESCE(t.${numberCol}::text, t.id::text) || ' for a migrated customer' AS label
                       FROM ${table} t WHERE t.company_id = $1 AND t.customer_id = ANY($2::uuid[])
                        ${table === 'invoices' ? 'AND (t.migration_batch_id IS DISTINCT FROM $3::uuid)' : 'AND $3::uuid IS NOT NULL'}`,
            [c, customers, batch.id],
          ),
          `${table}_for_customer`,
        );
      }
    }
    if (vendors.length) {
      for (const [table, numberCol, label] of [
        ['bills', 'bill_number', 'Bill'],
        ['bill_payments', 'reference', 'Bill payment'],
        ['vendor_credits', 'vendor_credit_number', 'Vendor credit'],
        ['purchase_orders', 'po_number', 'Purchase order'],
      ] as const) {
        add(
          await q(
            `SELECT t.id, '${label} ' || COALESCE(t.${numberCol}::text, t.id::text) || ' for a migrated vendor' AS label
                       FROM ${table} t WHERE t.company_id = $1 AND t.vendor_id = ANY($2::uuid[])
                        ${table === 'bills' ? 'AND (t.migration_batch_id IS DISTINCT FROM $3::uuid)' : 'AND $3::uuid IS NOT NULL'}`,
            [c, vendors, batch.id],
          ),
          `${table}_for_vendor`,
        );
      }
    }
    if (items.length) {
      add(
        await q(
          `SELECT m.id, 'Stock movement on ' || i.sku || ' (' || COALESCE(m.source_type, m.type) || ')' AS label
                     FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id
                    WHERE m.company_id = $1 AND m.item_id = ANY($2::uuid[])
                      AND NOT (m.source_type = 'migration' AND m.source_id = $3::uuid)`,
          [c, items, batch.id],
        ),
        'stock_movement',
      );
      add(
        await q(
          `SELECT l.id, 'Invoice line for ' || i.sku AS label
                     FROM invoice_line_items l JOIN inventory_items i ON i.id = l.item_id
                    WHERE i.company_id = $1 AND l.item_id = ANY($2::uuid[])`,
          [c, items],
        ),
        'invoice_line',
      );
    }
    if (createdAccounts.length) {
      add(
        await q(
          `SELECT g.id, 'Posting ' || g.reference || ' on account ' || a.account_number AS label
                     FROM general_ledger g JOIN accounts a ON a.id = g.account_id
                    WHERE g.company_id = $1 AND g.account_id = ANY($2::uuid[])
                      AND NOT (g.source_type IN ('migration', 'migration_rollback') AND g.source_id = $3::uuid)`,
          [c, createdAccounts, batch.id],
        ),
        'posting_on_new_account',
      );
    }
    if (entries.length) {
      add(
        await q(
          `SELECT g.id, 'Posting ' || g.reference || ' is part of a completed bank reconciliation' AS label
                     FROM general_ledger g JOIN journal_entries e ON e.reference = g.reference AND e.company_id = g.company_id
                    WHERE g.company_id = $1 AND e.id = ANY($2::uuid[]) AND g.reconciliation_id IS NOT NULL`,
          [c, entries],
        ),
        'reconciled',
      );
    }
    return out;
  }
}
