import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OperationalAuditEvent } from './operational-audit-event.entity';

export interface AuditRecordInput {
  companyId: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
}

@Injectable()
export class OperationalAuditService {
  private readonly logger = new Logger(OperationalAuditService.name);

  constructor(
    @InjectRepository(OperationalAuditEvent)
    private readonly repo: Repository<OperationalAuditEvent>,
  ) {}

  /**
   * Best-effort append. Auditing must never break the action it describes,
   * so failures are logged rather than thrown.
   */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          companyId: input.companyId,
          actorUserId: input.actorUserId ?? null,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          details: input.details ?? null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to record audit event ${input.action}: ${(err as Error).message}`,
      );
    }
  }

  async listForTarget(companyId: string, targetType: string, targetId: string, limit = 50) {
    return this.repo.find({
      where: { companyId, targetType, targetId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
