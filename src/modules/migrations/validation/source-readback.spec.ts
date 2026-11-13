import { EntityManager } from 'typeorm';
import { MigrationBatch } from '../entities/migration-batch.entity';
import {
  CHECK_CODES,
  MigrationChecksService,
} from './migration-checks.service';

/**
 * Check 0: every figure must read the same through both readers. The rows
 * here are what the staging table holds after analysis: the parsed value
 * beside the text as typed. A disagreement is what a bug in the first
 * reader would look like.
 */
const batch = { id: 'b1', companyId: 'c1' } as MigrationBatch;

function em(rows: Array<Record<string, unknown>>): EntityManager {
  return {
    query: jest.fn(async () =>
      rows.map((normalized, i) => ({
        sheet: 'Trial Balance',
        rowNumber: i + 2,
        entityType: (normalized.__type as string) ?? 'trial_balance',
        normalized,
      })),
    ),
  } as unknown as EntityManager;
}

const run = (rows: Array<Record<string, unknown>>) =>
  (
    new MigrationChecksService() as unknown as {
      sourceReadback: (
        e: EntityManager,
        b: MigrationBatch,
      ) => Promise<{
        code: string;
        passed: boolean;
        expected: string;
        actual: string;
        details: Array<Record<string, unknown>>;
      }>;
    }
  ).sourceReadback(em(rows), batch);

describe('SOURCE_READBACK', () => {
  it('is the first of the ten checks', () => {
    expect(CHECK_CODES[0]).toBe('SOURCE_READBACK');
    expect(CHECK_CODES).toHaveLength(10);
  });

  it('passes when every figure reads the same two ways', async () => {
    const r = await run([
      {
        debit: '150000',
        debitText: '1,50,000',
        credit: null,
        creditText: null,
      },
      {
        debit: '420500.5',
        debitText: 'Rs 4,20,500.50',
        credit: null,
        creditText: null,
      },
      {
        debit: null,
        debitText: null,
        credit: '229250.5',
        creditText: '2,29,250.50',
      },
      { debit: '120000', debitText: '۱۲۰۰۰۰', credit: null, creditText: null },
      {
        __type: 'open_invoices',
        invoiceDate: '2026-04-15',
        invoiceDateText: '15/04/2026',
        invoiceDateOrder: 'dmy',
        dueDate: null,
        dueDateText: null,
        originalAmount: '120000',
        originalAmountText: '1,20,000',
        amountDue: '-45000',
        amountDueText: '(45,000)',
      },
      {
        __type: 'stock',
        quantityOnHand: '12',
        quantityOnHandText: '12',
        unitCost: '8500',
        unitCostText: '8,500',
      },
    ]);
    expect(r.passed).toBe(true);
    expect(r.expected).toBe('9 figures');
    expect(r.actual).toBe('9 agree');
    expect(r.details).toEqual([]);
  });

  it('fails, naming the cell, when the first reader stored a different value', async () => {
    const r = await run([
      { debit: '12000', debitText: '1,20,000', credit: null, creditText: null },
      {
        debit: null,
        debitText: null,
        credit: '200000',
        creditText: '2,00,000',
      },
    ]);
    expect(r.passed).toBe(false);
    expect(r.expected).toBe('2 figures');
    expect(r.actual).toBe('1 agree');
    expect(r.details).toEqual([
      {
        sheet: 'Trial Balance',
        row: 2,
        field: 'Debit',
        asTyped: '1,20,000',
        firstReader: '12000',
        secondReader: '120000',
      },
    ]);
  });

  it('fails when a figure was dropped, read with the wrong side, or read with the wrong date order', async () => {
    const r = await run([
      { debit: null, debitText: '1,50,000', credit: null, creditText: null },
      {
        debit: '1200',
        debitSide: 'credit',
        debitText: '1,200 Dr',
        credit: null,
        creditText: null,
      },
      {
        __type: 'open_bills',
        billDate: '2026-11-12',
        billDateText: '12/11/2026',
        billDateOrder: 'mdy',
        dueDate: null,
        dueDateText: null,
        originalAmount: null,
        originalAmountText: null,
        amountDue: '5000',
        amountDueText: '5,000',
      },
    ]);
    expect(r.passed).toBe(false);
    expect(r.details.map((d) => d.field)).toEqual([
      'Debit',
      'Debit',
      'Bill date',
    ]);
  });

  it('refuses a grouping the first reader accepted by stripping commas', async () => {
    const r = await run([
      { debit: '120000', debitText: '12,0000', credit: null, creditText: null },
    ]);
    expect(r.passed).toBe(false);
    expect(String(r.details[0].secondReader)).toMatch(/not grouped/);
  });
});
