import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import {
  MigrationBatch,
  MigrationStatus,
} from './entities/migration-batch.entity';

/**
 *   draft → uploaded → mapped → validated → ready → committed → closed
 *                                        ↘ (any fix) → mapped
 *   committed → rolled_back
 *
 * Uploading more files, or removing one, from any pre-commit state goes back
 * through `uploaded` (and straight on to `mapped` once analysed). Removing the
 * last file returns to `draft`. Any mapping or issue fix lands on `mapped`,
 * which is what forces a fresh validation before anything can be imported.
 */
export const MIGRATION_TRANSITIONS: Record<
  MigrationStatus,
  readonly MigrationStatus[]
> = {
  draft: ['uploaded'],
  uploaded: ['uploaded', 'mapped', 'draft'],
  mapped: ['uploaded', 'mapped', 'validated', 'ready', 'draft'],
  validated: ['uploaded', 'mapped', 'validated', 'ready', 'draft'],
  ready: ['uploaded', 'mapped', 'validated', 'ready', 'committed', 'draft'],
  committed: ['rolled_back', 'closed'],
  closed: [],
  rolled_back: [],
};

/** States in which files, mappings and issues may still change. */
export const EDITABLE_STATUSES: readonly MigrationStatus[] = [
  'draft',
  'uploaded',
  'mapped',
  'validated',
  'ready',
];

export function canTransition(
  from: MigrationStatus,
  to: MigrationStatus,
): boolean {
  return MIGRATION_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: MigrationStatus,
  to: MigrationStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({
      code: 'MIGRATION_INVALID_TRANSITION',
      message: `This migration is ${describe(from)}; it cannot ${verb(to)} from here.`,
      details: { from, to },
    });
  }
}

/** Every status from which `to` may be reached. */
export function sourcesOf(
  to: MigrationStatus,
  opts: { editableOnly?: boolean } = {},
): MigrationStatus[] {
  return (Object.keys(MIGRATION_TRANSITIONS) as MigrationStatus[]).filter(
    (from) =>
      MIGRATION_TRANSITIONS[from].includes(to) &&
      (!opts.editableOnly || EDITABLE_STATUSES.includes(from)),
  );
}

/**
 * Move a batch to `to` only if, at the moment of writing, it is still in a
 * status that allows it. The check and the write are one UPDATE, so a
 * request that read the batch before a concurrent commit, close or undo
 * landed cannot overwrite that outcome: it gets the same 409 it would have
 * got had it arrived a moment later.
 */
export async function transitionAtomically(
  em: EntityManager,
  batch: Pick<MigrationBatch, 'id' | 'companyId'>,
  to: MigrationStatus,
  changes: Partial<MigrationBatch> = {},
  opts: { from?: MigrationStatus[]; editableOnly?: boolean } = {},
): Promise<void> {
  const from = opts.from ?? sourcesOf(to, { editableOnly: opts.editableOnly });
  const res = await em.update(
    MigrationBatch,
    { id: batch.id, companyId: batch.companyId, status: In(from) },
    { ...changes, status: to } as never,
  );
  if (res.affected) return;
  const now = await em.findOne(MigrationBatch, {
    where: { id: batch.id, companyId: batch.companyId },
  });
  if (!now)
    throw new NotFoundException({
      code: 'NOT_FOUND',
      message: 'Migration not found',
    });
  if (opts.editableOnly) assertEditable(now.status);
  assertTransition(now.status, to);
  // Allowed by the table but not by `from`: report it as the transition it is.
  throw new ConflictException({
    code: 'MIGRATION_INVALID_TRANSITION',
    message: `This migration is ${describe(now.status)}; it cannot ${verb(to)} from here.`,
    details: { from: now.status, to },
  });
}

/**
 * Lock the batch row for the rest of the transaction and confirm it can still
 * be edited. Every writer that rebuilds a batch's files, mappings or staging
 * takes this lock first, so it either runs entirely before a commit, close or
 * undo (which take the same lock) or sees their outcome and stops.
 */
export async function lockEditable(
  em: EntityManager,
  companyId: string,
  id: string,
): Promise<MigrationBatch> {
  const batch = await em.findOne(MigrationBatch, {
    where: { id, companyId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!batch)
    throw new NotFoundException({
      code: 'NOT_FOUND',
      message: 'Migration not found',
    });
  assertEditable(batch.status);
  return batch;
}

export function assertEditable(status: MigrationStatus): void {
  if (!EDITABLE_STATUSES.includes(status)) {
    throw new ConflictException({
      code: 'MIGRATION_INVALID_TRANSITION',
      message: `This migration is ${describe(status)}; its files and mappings can no longer change.`,
      details: { from: status },
    });
  }
}

/** The wizard step (1–7) a batch is on, for both apps. */
export function stepFor(
  status: MigrationStatus,
  hasBlockingIssues: boolean,
): number {
  switch (status) {
    case 'draft':
      return 1;
    case 'uploaded':
      return 2;
    case 'mapped':
      return hasBlockingIssues ? 4 : 3;
    case 'validated':
      return 5;
    case 'ready':
      return 6;
    default:
      return 7;
  }
}

function describe(s: MigrationStatus): string {
  return {
    draft: 'still being set up (no files yet)',
    uploaded: 'uploaded but not yet analysed',
    mapped: 'at the matching and fixing stage',
    validated: 'checked, with checks still failing',
    ready: 'ready to import',
    committed: 'already imported',
    closed: 'closed',
    rolled_back: 'undone',
  }[s];
}

function verb(to: MigrationStatus): string {
  return {
    draft: 'go back to the start',
    uploaded: 'take more files',
    mapped: 'be re-matched',
    validated: 'be checked',
    ready: 'become ready',
    committed: 'be imported',
    closed: 'be closed',
    rolled_back: 'be undone',
  }[to];
}
