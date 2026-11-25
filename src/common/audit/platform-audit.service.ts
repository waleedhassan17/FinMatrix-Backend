import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { PlatformAuditEvent } from './platform-audit-event.entity';

export interface PlatformAuditInput {
  actorUserId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  reason?: string | null;
  details?: Record<string, unknown> | null;
}

@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);

  constructor(
    @InjectRepository(PlatformAuditEvent)
    private readonly repo: Repository<PlatformAuditEvent>,
  ) {}

  private build(input: PlatformAuditInput): Partial<PlatformAuditEvent> {
    return {
      actorUserId: input.actorUserId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      companyId: input.companyId ?? null,
      companyName: input.companyName ?? null,
      reason: input.reason ?? null,
      details: input.details ?? null,
    };
  }

  /**
   * Best-effort append after the fact: auditing must never break the action
   * it describes, so failures are logged rather than thrown.
   */
  async record(input: PlatformAuditInput): Promise<void> {
    try {
      await this.repo.save(this.repo.create(this.build(input)));
    } catch (err) {
      this.logger.error(
        `Failed to record platform audit event ${input.action}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Append INSIDE a transaction: the record commits or rolls back with the
   * change it describes. Used where the record is part of the guarantee
   * (a deletion must never happen without its audit row).
   */
  async recordIn(
    em: EntityManager,
    input: PlatformAuditInput,
  ): Promise<PlatformAuditEvent> {
    const repo = em.getRepository(PlatformAuditEvent);
    return repo.save(repo.create(this.build(input)));
  }

  async list(filter: {
    action?: string;
    actions?: string[];
    companyId?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
  }) {
    const qb = this.repo
      .createQueryBuilder('e')
      .orderBy('e.createdAt', 'DESC')
      .take(Math.min(Math.max(filter.limit ?? 50, 1), 500));
    if (filter.action) qb.andWhere('e.action = :a', { a: filter.action });
    if (filter.actions?.length)
      qb.andWhere('e.action IN (:...as)', { as: filter.actions });
    if (filter.companyId)
      qb.andWhere('e.companyId = :c', { c: filter.companyId });
    if (filter.targetType)
      qb.andWhere('e.targetType = :t', { t: filter.targetType });
    if (filter.targetId) qb.andWhere('e.targetId = :i', { i: filter.targetId });
    return qb.getMany();
  }
}
