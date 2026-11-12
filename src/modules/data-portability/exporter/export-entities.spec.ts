import { EntityManager } from 'typeorm';
import {
  countSql,
  EXPORT_ENTITIES,
  exportColumns,
  scopedQuery,
} from './export-entities';

/**
 * The registry's one promise: nothing leaves this module unscoped. Each entry
 * must filter by the company — directly, or through its parent — and refuse
 * to run without a companyId at all.
 */
describe('EXPORT_ENTITIES', () => {
  it('has unique, file-safe names with parents listed before their lines', () => {
    const names = EXPORT_ENTITIES.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z_]+$/);
    for (const def of EXPORT_ENTITIES) {
      if (def.scope.kind !== 'parent') continue;
      const parentIndex = EXPORT_ENTITIES.findIndex(
        (d) => d.entity === (def.scope as { parent: unknown }).parent,
      );
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(names.indexOf(def.name));
    }
  });

  it('covers every document, line and ledger table the spec names', () => {
    const names = new Set(EXPORT_ENTITIES.map((d) => d.name));
    for (const required of [
      'accounts',
      'customers',
      'vendors',
      'items',
      'invoices',
      'invoice_lines',
      'payments',
      'payment_allocations',
      'bills',
      'bill_lines',
      'bill_payments',
      'credit_memos',
      'credit_memo_lines',
      'vendor_credits',
      'vendor_credit_lines',
      'estimates',
      'sales_orders',
      'purchase_orders',
      'deliveries',
      'journal_entries',
      'journal_lines',
      'general_ledger',
      'stock_movements',
      'tax_rates',
      'tax_payments',
    ])
      expect(names.has(required)).toBe(true);
  });
});

describe('scopedQuery', () => {
  const fakeManager = () => {
    const calls: Array<{ where: string; params: unknown }> = [];
    const qb = {
      where: (w: string, p: unknown) => {
        calls.push({ where: w, params: p });
        return qb;
      },
      orderBy: () => qb,
      limit: () => qb,
      andWhere: () => qb,
    };
    const manager = {
      createQueryBuilder: () => qb,
      connection: {
        getMetadata: (entity: { name?: string }) => ({
          tableName: `tbl_${entity.name ?? 'x'}`,
          columns: [],
          findColumnWithPropertyName: (p: string) => ({ databaseName: p }),
        }),
      },
    } as unknown as EntityManager;
    return { manager, calls };
  };

  it('refuses to build a query without a companyId', () => {
    const { manager } = fakeManager();
    for (const def of EXPORT_ENTITIES) {
      expect(() => scopedQuery(manager, def, '')).toThrow(/companyId/);
      expect(() =>
        scopedQuery(manager, def, undefined as unknown as string),
      ).toThrow(/companyId/);
    }
  });

  it('filters every entry by the company, directly or through its parent', () => {
    for (const def of EXPORT_ENTITIES) {
      const { manager, calls } = fakeManager();
      scopedQuery(manager, def, 'company-a');
      expect(calls).toHaveLength(1);
      const { where, params } = calls[0];
      expect(params).toEqual({ companyId: 'company-a' });
      if (def.scope.kind === 'company') {
        expect(where).toBe('e.companyId = :companyId');
      } else {
        expect(where).toContain(
          `e.${def.scope.foreignKey} IN (SELECT p.id FROM`,
        );
        expect(where).toContain('WHERE p.company_id = :companyId');
      }
    }
  });

  it('cross-check SQL counts by the same scope', () => {
    const { manager } = fakeManager();
    for (const def of EXPORT_ENTITIES) {
      const { sql } = countSql(manager, def);
      expect(sql).toContain('company_id = $1');
    }
  });

  it('reads columns off the metadata and honours omit', () => {
    const manager = {
      connection: {
        getMetadata: () => ({
          columns: [
            { propertyName: 'id', propertyPath: 'id', databaseName: 'id' },
            {
              propertyName: 'secret',
              propertyPath: 'secret',
              databaseName: 'secret',
            },
          ],
        }),
      },
    } as unknown as EntityManager;
    expect(
      exportColumns(manager, { ...EXPORT_ENTITIES[0], omit: ['secret'] }),
    ).toEqual([{ property: 'id', header: 'id' }]);
  });
});
