import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';

/**
 * Reconciled-transaction lock (bankreconcillation.md behavior 9).
 *
 * A GL row with `reconciliation_id` set is part of a finalised bank
 * reconciliation: its net is baked into that statement's ending balance and
 * therefore into every later beginning balance. Altering or reversing its
 * source document silently would break the roll-forward, so every mutation
 * path that can touch Cash/Bank-posting documents (payment delete, manual
 * journal-entry void, …) must call this first. The only way back is the
 * admin-only reconciliation UNDO, which un-stamps the rows and is recorded
 * in the operational audit trail.
 *
 * GL rows are looked up by `source_id` — PostingService stamps every row
 * with the source document's id (manual JEs: the entry id itself).
 */
export async function assertNotReconciled(
  manager: EntityManager,
  companyId: string,
  sourceIds: Array<string | null | undefined>,
  what = 'transaction',
): Promise<void> {
  const ids = sourceIds.filter((v): v is string => Boolean(v));
  if (ids.length === 0) return;

  const reconciled = await manager
    .getRepository(GeneralLedgerEntry)
    .createQueryBuilder('g')
    .where('g.companyId = :companyId', { companyId })
    .andWhere('g.sourceId IN (:...ids)', { ids })
    .andWhere('g.reconciliationId IS NOT NULL')
    .getCount();

  if (reconciled > 0) {
    throw new BadRequestException({
      code: 'TRANSACTION_RECONCILED',
      message:
        `This ${what} is part of a completed bank reconciliation and is locked. ` +
        'Altering it would break the reconciled beginning balance. ' +
        'An admin must undo that reconciliation first.',
    });
  }
}
