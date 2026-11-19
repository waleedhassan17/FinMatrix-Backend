import { DataSource, EntityMetadata, QueryRunner } from 'typeorm';
import {
  AUDIT_WRITE_CHUNK,
  FinancialAuditSubscriber,
} from './financial-audit.subscriber';
import { AuditTrailEntry } from './audit-trail.entity';
import { Invoice } from '../../modules/invoices/entities/invoice.entity';
import { CreditMemo } from '../../modules/credit-memos/entities/credit-memo.entity';
import { InvoiceLineItem } from '../../modules/invoices/entities/invoice-line-item.entity';
import { Customer } from '../../modules/customers/entities/customer.entity';
import { Vendor } from '../../modules/vendors/entities/vendor.entity';

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
      getRepository: () => ({
        save: (rows: AuditTrailEntry[]) => saveImpl(rows),
      }),
    }) as unknown as DataSource;

  const insertEvent = (target: EntityMetadata['target'], entity: unknown) =>
    ({ queryRunner: txRunner, metadata: { target }, entity }) as any;

  const updateEvent = (
    target: EntityMetadata['target'],
    databaseEntity: unknown,
    entity: unknown,
  ) =>
    ({
      queryRunner: txRunner,
      metadata: { target },
      databaseEntity,
      entity,
    }) as any;

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
    const draft = {
      id: INVOICE,
      companyId: COMPANY,
      status: 'sent',
      total: '250.0000',
    };
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
    subscriber.afterInsert(
      insertEvent(Invoice, { id: INVOICE, companyId: COMPANY }),
    );
    subscriber.afterInsert(
      insertEvent(CreditMemo, { id: 'cm-1', companyId: COMPANY }),
    );
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
    subscriber.afterInsert(
      insertEvent(Invoice, { id: INVOICE, companyId: COMPANY }),
    );
    subscriber.afterTransactionRollback({ queryRunner: txRunner } as any);
    await commit();

    expect(saved).toHaveLength(0);
  });

  it('never lets a failing audit write escape into the transaction', async () => {
    saveImpl = async () => {
      throw new Error('audit_trail is unreachable');
    };
    subscriber.afterInsert(
      insertEvent(Invoice, { id: INVOICE, companyId: COMPANY }),
    );

    // The posting has already committed; a bookkeeping failure must not throw.
    await expect(commit()).resolves.toBeUndefined();
  });

  it('skips rows with no resolvable company rather than writing a broken row', async () => {
    subscriber.afterInsert(insertEvent(Invoice, { id: INVOICE }));
    await commit();

    expect(saved).toHaveLength(0);
  });

  describe('customers and vendors (their History tab)', () => {
    const CUSTOMER = '33333333-3333-3333-3333-333333333333';
    const base = {
      id: CUSTOMER,
      companyId: COMPANY,
      code: 'C-0007',
      name: 'Ali Traders',
      phone: null,
      creditLimit: '50000.0000',
      balance: '1200.0000',
      billingAddress: { city: 'Lahore', country: 'Pakistan' },
    };

    it('records an edit, with the address kept as a value', async () => {
      subscriber.afterUpdate(
        updateEvent(Customer, base, {
          ...base,
          creditLimit: '100000',
          billingAddress: { city: 'Karachi', country: 'Pakistan' },
        }),
      );
      await commit();

      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        resourceType: 'customer',
        module: 'customers',
        action: 'update',
      });
      expect(saved[0].afterValues).toMatchObject({
        creditLimit: '100000',
        billingAddress: { city: 'Karachi', country: 'Pakistan' },
      });
    });

    it('drops a save that only moved the balance — one line per posting is not history', async () => {
      subscriber.afterUpdate(
        updateEvent(Customer, base, {
          ...base,
          balance: '1800.0000',
          updatedAt: new Date(),
        }),
      );
      await commit();

      expect(saved).toHaveLength(0);
    });

    it('drops a form re-save that changes nothing a person would see', async () => {
      // "50000" for "50000.0000", "" for NULL, an address with empty parts.
      subscriber.afterUpdate(
        updateEvent(Customer, base, {
          ...base,
          creditLimit: '50000',
          phone: '',
          billingAddress: { country: 'Pakistan', city: 'Lahore', street: '' },
        }),
      );
      await commit();

      expect(saved).toHaveLength(0);
    });

    it('records a vendor being deactivated', async () => {
      const vendor = {
        id: CUSTOMER,
        companyId: COMPANY,
        companyName: 'Habib Oil',
        isActive: true,
        balance: '0',
      };
      subscriber.afterUpdate(
        updateEvent(Vendor, vendor, { ...vendor, isActive: false }),
      );
      await commit();

      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        resourceType: 'vendor',
        action: 'update',
      });
    });
  });

  it('writes a large transaction in chunks, so it stays under the bind-parameter limit', async () => {
    const calls: number[] = [];
    saveImpl = async (rows) => {
      calls.push(rows.length);
      saved.push(...rows);
      return rows;
    };
    const n = AUDIT_WRITE_CHUNK * 2 + 37;
    for (let i = 0; i < n; i++) {
      subscriber.afterInsert(
        insertEvent(Customer, {
          id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
          companyId: COMPANY,
          displayName: `Customer ${i}`,
        }),
      );
    }
    subscriber.afterTransactionCommit({ queryRunner: txRunner } as any);
    for (let t = 0; t < 20 && saved.length < n; t++)
      await new Promise((r) => setImmediate(r));
    expect(saved).toHaveLength(n);
    expect(calls).toEqual([AUDIT_WRITE_CHUNK, AUDIT_WRITE_CHUNK, 37]);
    // 10 bound values a row must stay far below PostgreSQL's 65,535.
    expect(AUDIT_WRITE_CHUNK * 10).toBeLessThan(65_535);
  });

  it('keeps the other chunks when one chunk fails', async () => {
    let call = 0;
    saveImpl = async (rows) => {
      call += 1;
      if (call === 1) throw new Error('boom');
      saved.push(...rows);
      return rows;
    };
    const n = AUDIT_WRITE_CHUNK + 5;
    for (let i = 0; i < n; i++) {
      subscriber.afterInsert(
        insertEvent(Customer, {
          id: `10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
          companyId: COMPANY,
          displayName: `Customer ${i}`,
        }),
      );
    }
    subscriber.afterTransactionCommit({ queryRunner: txRunner } as any);
    for (let t = 0; t < 20 && call < 2; t++)
      await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(saved).toHaveLength(5);
  });
});
