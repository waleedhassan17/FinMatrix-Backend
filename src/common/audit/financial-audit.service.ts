import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditTrailEntry } from './audit-trail.entity';

export interface ListAuditQuery {
  module?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  userId?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Read side of the financial audit trail. Writes come from
 * FinancialAuditSubscriber at the data layer — nothing writes through here, so
 * the trail cannot be edited by application code.
 */
@Injectable()
export class FinancialAuditService {
  constructor(
    @InjectRepository(AuditTrailEntry)
    private readonly repo: Repository<AuditTrailEntry>,
  ) {}

  async list(
    companyId: string,
    query: ListAuditQuery,
    page = 1,
    limit = 50,
  ) {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.companyId = :companyId', { companyId });

    if (query.module) qb.andWhere('a.module = :module', { module: query.module });
    if (query.action) qb.andWhere('a.action = :action', { action: query.action });
    if (query.resourceType) {
      qb.andWhere('a.resourceType = :rt', { rt: query.resourceType });
    }
    if (query.resourceId) {
      qb.andWhere('a.resourceId = :rid', { rid: query.resourceId });
    }
    if (query.userId) qb.andWhere('a.userId = :uid', { uid: query.userId });
    if (query.startDate) {
      qb.andWhere('a.createdAt >= :start', { start: query.startDate });
    }
    if (query.endDate) {
      qb.andWhere('a.createdAt <= :end', { end: `${query.endDate} 23:59:59` });
    }

    qb.orderBy('a.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** Full change history for one document, oldest first. */
  async forResource(companyId: string, resourceType: string, resourceId: string) {
    return this.repo.find({
      where: { companyId, resourceType, resourceId },
      order: { createdAt: 'ASC' },
    });
  }
}
