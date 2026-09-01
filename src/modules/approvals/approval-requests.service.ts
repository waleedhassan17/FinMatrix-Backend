import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { ApprovalRequest, ApprovalType } from './entities/approval-request.entity';
import { ApprovalListFilter } from './dto/approval.dto';

/** What a gated controller hands back to a staff member. */
export interface PendingApprovalResponse {
  pending: true;
  requestId: string;
  type: ApprovalType;
  summary: string;
  message: string;
}

/**
 * Filing, reading and withdrawing requests — everything EXCEPT approving one.
 *
 * This is split from ApprovalsService on purpose. The gate lives in the owning
 * controllers (inventory, bills, purchase orders, …), so those modules need to
 * inject something that can file a request. If that something also carried the
 * dispatcher, every domain module would import ApprovalsModule while
 * ApprovalsModule imported every domain module — a cycle needing forwardRef()
 * in a dozen places.
 *
 * Filing a request needs no domain service at all: it writes one row. So the
 * capability that the gates need lives here, with no domain dependencies, and
 * only the approve path — which genuinely must reach every service — sits in
 * the module that imports them.
 */
@Injectable()
export class ApprovalRequestsService {
  constructor(
    @InjectRepository(ApprovalRequest)
    private readonly repo: Repository<ApprovalRequest>,
    private readonly audit: OperationalAuditService,
  ) {}

  /**
   * File a request. Writes ONE row and touches nothing else — no ledger, no
   * documents, no stock. Everything the action needs is kept in `payload` and
   * replayed at approval time.
   */
  async createRequest(
    type: ApprovalType,
    payload: Record<string, unknown>,
    summary: string,
    user: AuthenticatedUser,
    companyId: string,
    reason?: string,
  ): Promise<PendingApprovalResponse> {
    const request = await this.repo.save(
      this.repo.create({
        companyId,
        type,
        status: 'pending',
        payload,
        summary,
        reason: reason ?? null,
        requestedBy: user.id,
      }),
    );

    await this.audit.record({
      companyId,
      actorUserId: user.id,
      action: 'approval_requested',
      targetType: 'approval_request',
      targetId: request.id,
      details: { type, summary },
    });

    return {
      pending: true,
      requestId: request.id,
      type,
      summary,
      message: 'Sent to the owner for approval.',
    };
  }

  async list(
    companyId: string,
    filter: ApprovalListFilter | undefined,
    type: ApprovalType | undefined,
    viewer: AuthenticatedUser,
  ): Promise<ApprovalRequest[]> {
    const qb = this.repo
      .createQueryBuilder('r')
      .where('r.companyId = :companyId', { companyId })
      .orderBy('r.createdAt', 'DESC');

    // Staff see only what they asked for. The owner sees the whole inbox.
    if (viewer.role !== 'admin') {
      qb.andWhere('r.requestedBy = :userId', { userId: viewer.id });
    }
    if (type) qb.andWhere('r.type = :type', { type });

    if (filter && filter !== 'all') {
      // 'approving' is a transient claim; surface it under 'pending' so a row
      // never vanishes from the inbox mid-dispatch.
      const statuses = filter === 'pending' ? ['pending', 'approving'] : [filter];
      qb.andWhere('r.status IN (:...statuses)', { statuses });
    }

    return qb.getMany();
  }

  async getById(
    companyId: string,
    id: string,
    viewer: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const request = await this.repo.findOne({ where: { id, companyId } });
    if (!request) {
      throw new NotFoundException({
        code: 'APPROVAL_NOT_FOUND',
        message: 'Request not found',
      });
    }
    if (viewer.role !== 'admin' && request.requestedBy !== viewer.id) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You can only view your own requests.',
      });
    }
    return request;
  }

  /** Requester withdraws their own pending request. Posts nothing, ever. */
  async cancel(
    id: string,
    user: AuthenticatedUser,
    companyId: string,
  ): Promise<ApprovalRequest> {
    const request = await this.repo.findOne({ where: { id, companyId } });
    if (!request) {
      throw new NotFoundException({
        code: 'APPROVAL_NOT_FOUND',
        message: 'Request not found',
      });
    }
    if (request.requestedBy !== user.id) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You can only cancel your own requests.',
      });
    }
    if (request.status !== 'pending') {
      throw new BadRequestException({
        code: 'NOT_PENDING',
        message: `This request is already ${request.status}.`,
      });
    }

    request.status = 'cancelled';
    request.reviewedAt = new Date();
    const saved = await this.repo.save(request);

    await this.audit.record({
      companyId,
      actorUserId: user.id,
      action: 'approval_cancelled',
      targetType: 'approval_request',
      targetId: request.id,
      details: { type: request.type },
    });
    return saved;
  }

  /** Pending count for the owner's inbox badge. */
  async pendingCount(companyId: string, viewer: AuthenticatedUser): Promise<number> {
    return this.repo.count({
      where: {
        companyId,
        status: In(['pending', 'approving']),
        ...(viewer.role === 'admin' ? {} : { requestedBy: viewer.id }),
      },
    });
  }
}
