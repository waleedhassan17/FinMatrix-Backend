import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditTrail } from './entities/audit-trail.entity';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditTrail) private readonly repo: Repository<AuditTrail>,
  ) {}

  async list(companyId: string, query: { module?: string; resourceType?: string; resourceId?: string; userId?: string }, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('a').where('a.companyId = :cid', { cid: companyId });
    if (query.module) qb.andWhere('a.module = :m', { m: query.module });
    if (query.resourceType) qb.andWhere('a.resourceType = :rt', { rt: query.resourceType });
    if (query.resourceId) qb.andWhere('a.resourceId = :rid', { rid: query.resourceId });
    if (query.userId) qb.andWhere('a.userId = :uid', { uid: query.userId });
    qb.orderBy('a.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async byResource(companyId: string, resourceType: string, resourceId: string, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('a')
      .where('a.companyId = :cid AND a.resourceType = :rt AND a.resourceId = :rid', { cid: companyId, rt: resourceType, rid: resourceId })
      .orderBy('a.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async summary(companyId: string) {
    const rows = await this.repo.createQueryBuilder('a')
      .select('a.module', 'module')
      .addSelect('COUNT(*)', 'count')
      .where('a.companyId = :cid', { cid: companyId })
      .groupBy('a.module')
      .getRawMany();
    return rows;
  }
}
