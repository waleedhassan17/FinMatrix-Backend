import { EntityManager } from 'typeorm';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import { PostingService } from './posting.service';

/**
 * The per-line source: a line may name its own document on its general_ledger
 * row. Everything else about the entry — and every entry that does not use
 * it — is unchanged.
 */
describe('PostingService — per-line source', () => {
  const accounts = [
    { id: 'ar', type: 'asset', isActive: true, balance: '0' },
    { id: 'clr', type: 'equity', isActive: true, balance: '0' },
  ];

  function fakeManager() {
    const saved: unknown[] = [];
    const manager = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'co', booksLockedUntil: null }),
      find: jest.fn().mockResolvedValue(accounts.map((a) => ({ ...a }))),
      createQueryBuilder: jest.fn(() => ({
        select: () => ({
          where: () => ({ getRawOne: async () => ({ count: '4' }) }),
        }),
      })),
      create: jest.fn((_entity: unknown, value: Record<string, unknown>) => ({
        ...value,
        __entity: _entity,
      })),
      save: jest.fn(async (value: any) => {
        saved.push(value);
        if (!Array.isArray(value) && value && !value.id) value.id = 'entry-1';
        return value;
      }),
      query: jest.fn(async (_sql: string, params: unknown[]) => [
        [{ balance: String(params[0]) }],
        1,
      ]),
    } as unknown as EntityManager;
    const glRows = () =>
      saved
        .filter(Array.isArray)
        .flat()
        .filter(
          (r: any) => r.__entity === GeneralLedgerEntry,
        ) as unknown as GeneralLedgerEntry[];
    return { manager, glRows };
  }

  const svc = new PostingService();

  it('writes a line’s own source on its ledger row and the entry’s on the rest', async () => {
    const { manager, glRows } = fakeManager();
    await svc.createEntry(manager, {
      companyId: 'co',
      date: '2026-06-30',
      createdBy: 'u',
      status: 'posted',
      sourceType: 'migration',
      sourceId: 'batch-1',
      lines: [
        {
          accountId: 'ar',
          debit: '100',
          credit: '0',
          source: { sourceType: 'migration', sourceId: 'inv-1' },
        },
        {
          accountId: 'ar',
          debit: '50',
          credit: '0',
          source: { sourceType: 'migration', sourceId: 'inv-2' },
        },
        { accountId: 'clr', debit: '0', credit: '150' },
      ],
    });
    const rows = glRows();
    expect(rows.map((r) => [r.sourceType, r.sourceId])).toEqual([
      ['migration', 'inv-1'],
      ['migration', 'inv-2'],
      ['migration', 'batch-1'],
    ]);
    // Running balances are unaffected by where a row points.
    expect(rows.map((r) => r.balance)).toEqual([
      '100.0000',
      '150.0000',
      '150.0000',
    ]);
  });

  it('leaves an entry without per-line sources exactly as before', async () => {
    const { manager, glRows } = fakeManager();
    await svc.createEntry(manager, {
      companyId: 'co',
      date: '2026-06-30',
      createdBy: 'u',
      status: 'posted',
      sourceType: 'invoice',
      sourceId: 'inv-9',
      lines: [
        { accountId: 'ar', debit: '10', credit: '0' },
        { accountId: 'clr', debit: '0', credit: '10', source: null },
      ],
    });
    expect(glRows().map((r) => [r.sourceType, r.sourceId])).toEqual([
      ['invoice', 'inv-9'],
      ['invoice', 'inv-9'],
    ]);
  });
});
