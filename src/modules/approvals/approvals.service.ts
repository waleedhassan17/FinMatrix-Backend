import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import {
  ApprovalRequest,
  ApprovalType,
} from './entities/approval-request.entity';
import { ApprovalDispatcher } from './approval-dispatcher.service';
import { ApprovalListFilter, DecideApprovalDto } from './dto/approval.dto';

/** What a gated controller hands back to a staff member. */
export interface PendingApprovalResponse {
  pending: true;
  requestId: string;
  type: ApprovalType;
  summary: string;
  message: string;
}

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @InjectRepository(ApprovalRequest)
    private readonly repo: Repository<ApprovalRequest>,
    private readonly dispatcher: ApprovalDispatcher,
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
      const statuses =
        filter === 'pending' ? ['pending', 'approving'] : [filter];
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

  /**
   * Approve or reject. Owner only — enforced by @Roles('admin') on the route.
   *
   * ── Why this is not one transaction ──────────────────────────────────────
   * Every service this dispatches to (InventoryService.adjust, BillsService.pay,
   * PurchaseOrdersService.create, …) opens its OWN `dataSource.transaction`,
   * which takes a fresh connection from the pool. They cannot be enrolled in a
   * transaction owned here, and rewriting seven services to accept an
   * EntityManager would be a far riskier change than this one.
   *
   * So instead of a transaction, the row is CLAIMED: a conditional UPDATE
   * moves it pending → approving, and only one caller can win that race.
   * The claim is what makes approval idempotent — a second decide finds no
   * pending row and returns the request unchanged rather than posting twice.
   * If the dispatch throws, the claim is released back to pending with the
   * error recorded, so the owner can fix the cause and try again.
   *
   * A crash between a successful dispatch and the final UPDATE would strand a
   * row in `approving` with its work already done. That is deliberately the
   * failure we accept: it needs one manual correction and is visible in the
   * inbox, whereas the alternative ordering would risk posting the same
   * journal entry twice, which is unacceptable in a ledger.
   */
  async decide(
    id: string,
    dto: DecideApprovalDto,
    reviewer: AuthenticatedUser,
    companyId: string,
  ): Promise<ApprovalRequest> {
    const request = await this.repo.findOne({ where: { id, companyId } });
    if (!request) {
      throw new NotFoundException({
        code: 'APPROVAL_NOT_FOUND',
        message: 'Request not found',
      });
    }

    // Idempotent: a decided request is returned as-is rather than re-run.
    if (request.status !== 'pending') {
      return request;
    }

    // Maker ≠ checker. An owner who filed the request cannot also approve it;
    // the second pair of eyes is the entire control.
    if (request.requestedBy === reviewer.id) {
      throw new ForbiddenException({
        code: 'MAKER_IS_CHECKER',
        message:
          'You cannot approve your own request. Another owner has to review it.',
      });
    }

    if (dto.decision === 'reject') {
      return this.reject(request, dto, reviewer, companyId);
    }
    return this.approve(request, dto, reviewer, companyId);
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

  // ── Internals ─────────────────────────────────────────────────────────────

  private async reject(
    request: ApprovalRequest,
    dto: DecideApprovalDto,
    reviewer: AuthenticatedUser,
    companyId: string,
  ): Promise<ApprovalRequest> {
    // A rejection without a reason tells the requester nothing about what to
    // do differently, so the comment is required here and optional on approve.
    if (!dto.comment?.trim()) {
      throw new BadRequestException({
        code: 'COMMENT_REQUIRED',
        message: 'Say why you are rejecting this, so the requester knows.',
      });
    }

    request.status = 'rejected';
    request.reviewedBy = reviewer.id;
    request.reviewerRole = reviewer.role;
    request.reviewedAt = new Date();
    request.reviewerComment = dto.comment.trim();
    const saved = await this.repo.save(request);

    await this.audit.record({
      companyId,
      actorUserId: reviewer.id,
      action: 'approval_rejected',
      targetType: 'approval_request',
      targetId: request.id,
      details: { type: request.type },
    });
    return saved;
  }

  private async approve(
    request: ApprovalRequest,
    dto: DecideApprovalDto,
    reviewer: AuthenticatedUser,
    companyId: string,
  ): Promise<ApprovalRequest> {
    // Claim it. Only one caller can move a row out of 'pending', so two
    // concurrent approvals cannot both reach the dispatch below.
    const claim = await this.repo.update(
      { id: request.id, companyId, status: 'pending' },
      { status: 'approving', reviewedBy: reviewer.id, reviewerRole: reviewer.role },
    );
    if (!claim.affected) {
      // Somebody else won the race; return whatever they made of it.
      return (await this.repo.findOne({ where: { id: request.id, companyId } }))!;
    }

    let result: { journalEntryId?: string | null; id?: string | null };
    try {
      // The period lock needs no code here: every dispatch target posts
      // through PostingService.createEntry, whose assertPeriodOpen runs
      // against the posting date — which for an approval is today.
      result = await this.dispatcher.dispatch(
        request.type,
        request.payload,
        companyId,
        reviewer.id,
      );
    } catch (err) {
      const message = this.describe(err);
      // Release the claim so the owner can fix the cause and retry. The
      // request is exactly as it was: still pending, still having posted
      // nothing.
      await this.repo.update(
        { id: request.id },
        {
          status: 'pending',
          reviewedBy: null,
          reviewerRole: null,
          lastError: message,
        },
      );
      this.logger.warn(`Approval ${request.id} (${request.type}) failed: ${message}`);
      throw err;
    }

    await this.repo.update(
      { id: request.id },
      {
        status: 'approved',
        reviewedBy: reviewer.id,
        reviewerRole: reviewer.role,
        reviewedAt: new Date(),
        reviewerComment: dto.comment?.trim() ?? null,
        journalEntryId: result.journalEntryId ?? null,
        resultId: result.id ?? null,
        lastError: null,
      },
    );

    await this.audit.record({
      companyId,
      actorUserId: reviewer.id,
      action: 'approval_approved',
      targetType: 'approval_request',
      targetId: request.id,
      details: {
        type: request.type,
        journalEntryId: result.journalEntryId ?? null,
        resultId: result.id ?? null,
      },
    });

    return (await this.repo.findOne({ where: { id: request.id, companyId } }))!;
  }

  /** Pull a readable message out of a Nest exception body or an Error. */
  private describe(err: unknown): string {
    const response = (err as { response?: unknown })?.response;
    if (response && typeof response === 'object' && 'message' in response) {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join('; ');
    }
    return (err as Error)?.message ?? 'Unknown error';
  }
}
