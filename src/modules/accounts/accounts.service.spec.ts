import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AccountsService } from './accounts.service';
import {
  AccountUsage,
  describeUsage,
  EMPTY_USAGE,
  structureOf,
} from './account-structure.util';

/**
 * A chart of accounts in memory, behind just enough of TypeORM's surface for
 * update() and resolveMoneyAccount(): the locked read, findOne, save, and the
 * usage query.
 */
interface Row {
  id: string;
  companyId: string;
  accountNumber: string;
  name: string;
  type: string;
  subType: string;
  parentId: string | null;
  description: string | null;
  balance: string;
  isActive: boolean;
}

const COMPANY = 'company-1';

function makeService(
  rows: Row[],
  usageById: Record<string, Partial<AccountUsage>> = {},
) {
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([k, v]) => (row as unknown as Record<string, unknown>)[k] === v,
    );

  const manager = {
    getRepository: () => ({
      createQueryBuilder: () => {
        let params: Record<string, unknown> = {};
        const qb = {
          setLock: () => qb,
          where: (_sql: string, p: Record<string, unknown>) => {
            params = p;
            return qb;
          },
          getOne: async () =>
            rows.find(
              (r) => r.id === params.id && r.companyId === params.companyId,
            ) ?? null,
        };
        return qb;
      },
    }),
    findOne: async (
      _entity: unknown,
      { where }: { where: Record<string, unknown> },
    ) => rows.find((r) => matches(r, where)) ?? null,
    save: async (row: Row) => row,
    query: async (_sql: string, [, id]: [string, string]) => [
      { ...EMPTY_USAGE, ...(usageById[id] ?? {}) },
    ],
  };

  const dataSource = {
    manager,
    transaction: async (cb: (m: typeof manager) => unknown) => cb(manager),
  };

  const service = new AccountsService(
    {} as never,
    {} as never,
    dataSource as never,
    {} as never,
  );
  return { service, manager };
}

const account = (over: Partial<Row>): Row => ({
  id: 'a-meezan',
  companyId: COMPANY,
  accountNumber: '5010',
  name: 'MEEZAN BANK',
  type: 'expense',
  subType: 'Other Expense',
  parentId: null,
  description: null,
  balance: '0',
  isActive: true,
  ...over,
});

const CHART: Row[] = [
  account({
    id: 'a-cash',
    accountNumber: '1000',
    name: 'Cash',
    type: 'asset',
    subType: 'Cash',
  }),
  account({
    id: 'a-bank',
    accountNumber: '1010',
    name: 'Business Checking',
    type: 'asset',
    subType: 'Bank',
  }),
  account({
    id: 'a-rent',
    accountNumber: '6000',
    name: 'Rent Expense',
    type: 'expense',
    subType: 'Operating',
  }),
  account({
    id: 'a-assets',
    accountNumber: '1900',
    name: 'Bank accounts',
    type: 'asset',
    subType: 'Other Asset',
  }),
];

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const err = e as { getResponse?: () => { code?: string } };
    return err.getResponse?.().code ?? String(e);
  }
};

describe('AccountsService.update — a mis-filed account can be put right', () => {
  it('turns an unused expense into a bank account with a new number', async () => {
    const meezan = account({});
    const { service } = makeService([...CHART, meezan]);

    const saved = await service.update(COMPANY, meezan.id, {
      type: 'asset',
      subType: 'Bank',
      accountNumber: ' 1020 ',
    });

    expect(saved).toMatchObject({
      accountNumber: '1020',
      type: 'asset',
      subType: 'Bank',
      isSystemAccount: false,
    });
  });

  it('keeps type and number fixed once anything refers to the account', async () => {
    const meezan = account({});
    const { service } = makeService([...CHART, meezan], {
      [meezan.id]: { postings: 12, payments: 1 },
    });

    await expect(
      service.update(COMPANY, meezan.id, {
        type: 'asset',
        subType: 'Bank',
        accountNumber: '1020',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'ACCOUNT_IN_USE',
        message: expect.stringContaining('12 postings and 1 payment'),
      },
    });
    // Renaming is still fine.
    await expect(
      service.update(COMPANY, meezan.id, { name: 'Meezan Bank (old)' }),
    ).resolves.toMatchObject({ name: 'Meezan Bank (old)', type: 'expense' });
  });

  it.each([
    ['a draft journal line', { draftJournalLines: 1 }],
    ['a bill line', { documentLines: 2 }],
    ['a budget line', { other: 1 }],
  ])('counts %s as use', async (_label, usage) => {
    const meezan = account({});
    const { service } = makeService([...CHART, meezan], { [meezan.id]: usage });
    expect(
      await codeOf(
        service.update(COMPANY, meezan.id, { accountNumber: '5020' }),
      ),
    ).toBe('ACCOUNT_IN_USE');
  });

  it('fixes a system account’s type, kind and number but lets it be renamed', async () => {
    const { service } = makeService(CHART);
    expect(
      await codeOf(
        service.update(COMPANY, 'a-bank', {
          type: 'expense',
          subType: 'Operating',
        }),
      ),
    ).toBe('SYSTEM_ACCOUNT_FIXED');
    expect(
      await codeOf(
        service.update(COMPANY, 'a-bank', { subType: 'Other Asset' }),
      ),
    ).toBe('SYSTEM_ACCOUNT_FIXED');
    expect(
      await codeOf(
        service.update(COMPANY, 'a-bank', { accountNumber: '1011' }),
      ),
    ).toBe('SYSTEM_ACCOUNT_FIXED');
    await expect(
      service.update(COMPANY, 'a-bank', {
        name: 'HBL Current Account',
        subType: 'Bank',
      }),
    ).resolves.toMatchObject({ name: 'HBL Current Account', subType: 'Bank' });
  });

  it('refuses a number another account has', async () => {
    const meezan = account({});
    const { service } = makeService([...CHART, meezan]);
    await expect(
      service.update(COMPANY, meezan.id, {
        type: 'asset',
        subType: 'Bank',
        accountNumber: '1010',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a type change while sub-accounts hang off it', async () => {
    const meezan = account({});
    const { service } = makeService([...CHART, meezan], {
      [meezan.id]: { children: 2 },
    });
    expect(
      await codeOf(
        service.update(COMPANY, meezan.id, { type: 'asset', subType: 'Bank' }),
      ),
    ).toBe('ACCOUNT_HAS_CHILDREN');
  });

  it('wants a kind that belongs to the new type', async () => {
    const meezan = account({});
    const { service } = makeService([...CHART, meezan]);
    // Still "Other Expense", which is not a kind of asset.
    expect(
      await codeOf(service.update(COMPANY, meezan.id, { type: 'asset' })),
    ).toBe('INVALID_SUB_TYPE');
  });

  it('lets go of an old parent of the wrong type, but refuses one chosen now', async () => {
    const meezan = account({ parentId: 'a-rent' });
    const { service } = makeService([...CHART, meezan]);

    await expect(
      service.update(COMPANY, meezan.id, {
        type: 'asset',
        subType: 'Bank',
        accountNumber: '1020',
      }),
    ).resolves.toMatchObject({ parentId: null });

    const other = account({ id: 'a-other', accountNumber: '5020' });
    const second = makeService([...CHART, other]);
    expect(
      await codeOf(
        second.service.update(COMPANY, other.id, {
          type: 'asset',
          subType: 'Bank',
          accountNumber: '1030',
          parentId: 'a-rent',
        }),
      ),
    ).toBe('PARENT_TYPE_MISMATCH');
    await expect(
      second.service.update(COMPANY, other.id, {
        type: 'asset',
        subType: 'Bank',
        accountNumber: '1030',
        parentId: 'a-assets',
      }),
    ).resolves.toMatchObject({ parentId: 'a-assets' });
  });

  it('is scoped to the company', async () => {
    const { service } = makeService(CHART);
    await expect(
      service.update('company-2', 'a-rent', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AccountsService.resolveMoneyAccount — what a payment may move money through', () => {
  it('falls back to the account it always used when none is chosen', async () => {
    const { service, manager } = makeService(CHART);
    const spy = jest
      .spyOn(service, 'getByNumberOrFail')
      .mockResolvedValue(CHART[0] as never);
    await expect(
      service.resolveMoneyAccount(manager as never, COMPANY, undefined, '1000'),
    ).resolves.toMatchObject({ accountNumber: '1000' });
    expect(spy).toHaveBeenCalledWith(COMPANY, '1000', manager);
  });

  it('accepts any of the company’s active cash or bank accounts', async () => {
    const mcb = account({
      id: 'a-mcb',
      accountNumber: '1020',
      name: 'MCB',
      type: 'asset',
      subType: 'Bank',
    });
    const { service, manager } = makeService([...CHART, mcb]);
    await expect(
      service.resolveMoneyAccount(manager as never, COMPANY, 'a-mcb', '1000'),
    ).resolves.toMatchObject({ name: 'MCB' });
  });

  it('refuses an expense, an inactive bank, and another company’s account', async () => {
    const meezan = account({});
    const closed = account({
      id: 'a-old',
      accountNumber: '1040',
      type: 'asset',
      subType: 'Bank',
      isActive: false,
    });
    const foreign = account({
      id: 'a-foreign',
      companyId: 'company-2',
      accountNumber: '1020',
      type: 'asset',
      subType: 'Bank',
    });
    const { service, manager } = makeService([
      ...CHART,
      meezan,
      closed,
      foreign,
    ]);
    const resolve = (id: string) =>
      service.resolveMoneyAccount(manager as never, COMPANY, id, '1000');

    await expect(resolve(meezan.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await codeOf(resolve(meezan.id))).toBe('INVALID_PAYMENT_ACCOUNT');
    expect(await codeOf(resolve('a-old'))).toBe('INVALID_PAYMENT_ACCOUNT');
    expect(await codeOf(resolve('a-foreign'))).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('structureOf — what the edit form may unlock', () => {
  it('unlocks an account nothing refers to', () => {
    expect(structureOf(false, EMPTY_USAGE)).toEqual({
      editable: true,
      reason: null,
    });
  });

  it('says why it is fixed', () => {
    expect(structureOf(true, EMPTY_USAGE).reason).toMatch(/system account/);
    expect(structureOf(false, { ...EMPTY_USAGE, postings: 3 }).reason).toBe(
      'Already in use (3 postings), so its type and number are fixed.',
    );
    expect(structureOf(false, { ...EMPTY_USAGE, children: 1 }).reason).toMatch(
      /1 sub-account\. Move it first/,
    );
  });

  it('describes use in plain words', () => {
    expect(
      describeUsage({
        ...EMPTY_USAGE,
        postings: 1,
        documentLines: 2,
        payments: 1,
      }),
    ).toBe('1 posting, 2 document lines and 1 payment');
  });
});
