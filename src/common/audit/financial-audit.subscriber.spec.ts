import { DataSource, QueryRunner } from 'typeorm';
import { FinancialAuditSubscriber } from './financial-audit.subscriber';
import { AuditTrailEntry } from './audit-trail.entity';
import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { CreditMemo } from '../../modules/credit-memos/entities/credit-memo.entity';
import { InvoiceLineItem } from '../../modules/invoices/entities/invoice-line-item.entity';

/**
 * The two properties that matter more than completeness (audit gap G2):
 *   1. One logical mutation produces exactly one audit row.
 *   2. A failing audit write never propagates into the financial transaction.
 */
describe('FinancialAuditSubscriber', () => {
  const COMPANY = '11111111-1111-1111-1111-111111111111';
  const INVOICE = '22222222-2222-2222-2222-222222222222';

  let saved: AuditTrailEntry[];
  let saveImpl: (rows: AuditTrailEntry[]) => Promise<unknown>;
  let subscriber: FinancialAuditSubscriber;
  let txRunner: QueryRunner;

  const makeDataSource = () =>
    ({
      subscribers: [],
      getRepository: () => ({ save: (rows: AuditTrailEntry[]) => saveImpl(rows) }),
    }) as unknown as DataSource;

  const insertEvent = (target: Function, entity: unknown) =>
    ({ queryRunner: txRunner, metadata: { target }, entity }) as any;

  const updateEvent = (target: Function, databaseEntity: unknown, entity: unknown) =>
    ({ queryRunner: txRunner, metadata: { target }, databaseEntity, entity }) as any;

  const commit = async () => {
    subscriber.afterTransactionCommit({ queryRunner: txRunner } as any);
    // flush() is deliberately fire-and-forget; let its microtasks settle.
    await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    saved = [];
    saveImpl = async (rows) => {
      saved.push(...rows);
      return rows;
    };
    txRunner = { isTransactionActive: true } as QueryRunner;
    subscriber = new FinancialAuditSubscriber(makeDataSource());
  });

  it('collapses a create plus its follow-up saves into ONE create row', async () => {
    // Mirrors credit-memos/invoices: save the document, post the journal
    // entry, then save again to attach journal_entry_id.
    const draft = { id: INVOICE, companyId: COMPANY, status: 'sent', total: '250.0000' };
    subscriber.afterInsert(insertEvent(Invoice, draft));
    subscriber.afterUpdate(
      updateEvent(Invoice, draft, { ...draft, journalEntryId: 'je-1' }),
    );
    await commit();

    expect(saved).toHaveLength(1);
    expect(saved[0].action).toBe('create');
    expect(saved[0].resourceType).toBe('invoice');
    expect(saved[0].resourceId).toBe(INVOICE);
    // The after-image is the FINAL state, not the intermediate one.
    expect(saved[0].afterValues?.journalEntryId).toBe('je-1');
  });

  it('records a status transition to void as "void", not "update"', async () => {
    subscriber.afterUpdate(
      updateEvent(
        Invoice,
        { id: INVOICE, companyId: COMPANY, status: 'sent' },
        { id: INVOICE, companyId: COMPANY, status: 'void' },
      ),
    );
    await commit();

    expect(saved).toHaveLength(1);
    expect(saved[0].action).toBe('void');
    expect(saved[0].beforeValues?.status).toBe('sent');
    expect(saved[0].afterValues?.status).toBe('void');
  });

  it('keeps distinct documents in one transaction as separate rows', async () => {
    subscriber.afterInsert(insertEvent(Invoice, { id: INVOICE, companyId: COMPANY }));
    subscriber.afterInsert(insertEvent(CreditMemo, { id: 'cm-1', companyId: COMPANY }));
    await commit();

    expect(saved.map((r) => r.resourceType).sort()).toEqual([
      'credit_memo',
      'invoice',
    ]);
  });

  it('ignores line-item tables — the parent document is the unit of change', async () => {
    subscriber.afterInsert(
      insertEvent(InvoiceLineItem, { id: 'line-1', invoiceId: INVOICE }),
    );
    await commit();

    expect(saved).toHaveLength(0);
  });

  it('discards the buffer when the transaction rolls back', async () => {
    subscriber.afterInsert(insertEvent(Invoice, { id: INVOICE, companyId: COMPANY }));
    subscriber.afterTransactionRollback({ queryRunner: txRunner } as any);
    await commit();

    expect(saved).toHaveLength(0);
  });

  it('never lets a failing audit write escape into the transaction', async () => {
    saveImpl = async () => {
      throw new Error('audit_trail is unreachable');
    };
    subscriber.afterInsert(insertEvent(Invoice, { id: INVOICE, companyId: COMPANY }));

    // The posting has already committed; a bookkeeping failure must not throw.
    await expect(commit()).resolves.toBeUndefined();
  });

  it('skips rows with no resolvable company rather than writing a broken row', async () => {
    subscriber.afterInsert(insertEvent(Invoice, { id: INVOICE }));
    await commit();

    expect(saved).toHaveLength(0);
  });
});
