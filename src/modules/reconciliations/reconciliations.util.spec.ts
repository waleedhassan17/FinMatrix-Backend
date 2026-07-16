import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { assertNotReconciled } from './reconciliations.util';

const managerWithCount = (count: number): EntityManager => {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(count),
  };
  return {
    getRepository: jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    }),
  } as unknown as EntityManager;
};

describe('assertNotReconciled (bank-reconciliation lock)', () => {
  it('passes when none of the source docs have reconciled GL rows', async () => {
    await expect(
      assertNotReconciled(managerWithCount(0), 'co-1', ['doc-1']),
    ).resolves.toBeUndefined();
  });

  it('throws TRANSACTION_RECONCILED when any GL row is reconciled', async () => {
    await expect(
      assertNotReconciled(managerWithCount(2), 'co-1', ['doc-1'], 'payment'),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: expect.objectContaining({ code: 'TRANSACTION_RECONCILED' }),
    });
  });

  it('is a no-op for empty/null id lists (never queries)', async () => {
    const manager = managerWithCount(99);
    await expect(
      assertNotReconciled(manager, 'co-1', [null, undefined]),
    ).resolves.toBeUndefined();
    expect(manager.getRepository).not.toHaveBeenCalled();
  });
});
