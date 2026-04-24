import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { DeliveryItem } from './entities/delivery-item.entity';
import { DeliveryStatusHistory } from './entities/delivery-status-history.entity';
import { DeliveryIssue } from './entities/delivery-issue.entity';
import { DeliveryPersonnelProfile } from '../delivery-personnel/entities/delivery-personnel-profile.entity';
import {
  CreateDeliveryDto,
  UpdateDeliveryDto,
  DeliveryStatusUpdateDto,
  DeliveryQueryDto,
  DeliveryIssueDto,
} from './dto/delivery.dto';
import { DeliveryStatus } from '../../types';

const STATUS_ORDER: Record<string, number> = {
  unassigned: 0,
  pending: 1,
  picked_up: 2,
  in_transit: 3,
  arrived: 4,
  delivered: 5,
};

@Injectable()
export class DeliveriesService {
  constructor(
    @InjectRepository(Delivery) private readonly repo: Repository<Delivery>,
    @InjectRepository(DeliveryItem) private readonly itemRepo: Repository<DeliveryItem>,
    @InjectRepository(DeliveryStatusHistory) private readonly historyRepo: Repository<DeliveryStatusHistory>,
    @InjectRepository(DeliveryIssue) private readonly issueRepo: Repository<DeliveryIssue>,
    @InjectRepository(DeliveryPersonnelProfile) private readonly personnelRepo: Repository<DeliveryPersonnelProfile>,
    private readonly dataSource: DataSource,
  ) {}

  async list(companyId: string, query: DeliveryQueryDto, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('d').where('d.companyId = :cid', { cid: companyId });
    if (query.status) qb.andWhere('d.status = :s', { s: query.status });
    if (query.personnelId) qb.andWhere('d.personnelId = :pid', { pid: query.personnelId });
    if (query.customerId) qb.andWhere('d.customerId = :cust', { cust: query.customerId });
    qb.orderBy('d.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const d = await this.repo.findOne({ where: { id, companyId }, relations: ['items'] });
    if (!d) throw new NotFoundException('Delivery not found');
    return d;
  }

  async create(companyId: string, dto: CreateDeliveryDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Delivery);
      const itemRepo = em.getRepository(DeliveryItem);
      const d = repo.create({
        companyId,
        customerId: dto.customerId,
        personnelId: dto.personnelId ?? null,
        status: dto.personnelId ? 'pending' : 'unassigned',
        priority: dto.priority ?? 'normal',
        preferredDate: dto.preferredDate ?? null,
        preferredTimeSlot: dto.preferredTimeSlot ?? null,
        notes: dto.notes ?? null,
        createdBy: userId,
      });
      if (dto.personnelId) d.assignedAt = new Date();
      await repo.save(d);

      const items = dto.items.map((it) =>
        itemRepo.create({
          deliveryId: d.id,
          itemId: it.itemId,
          orderedQty: it.orderedQty,
          unitPrice: it.unitPrice ?? '0',
          deliveredQty: '0',
          returnedQty: '0',
        }),
      );
      await itemRepo.save(items);
      return { ...d, items };
    });
  }

  async update(companyId: string, id: string, dto: UpdateDeliveryDto) {
    const d = await this.getById(companyId, id);
    if (dto.personnelId !== undefined && dto.personnelId !== d.personnelId) {
      d.personnelId = dto.personnelId;
      if (dto.personnelId && d.status === 'unassigned') {
        d.status = 'pending';
        d.assignedAt = new Date();
      }
    }
    Object.assign(d, dto);
    return this.repo.save(d);
  }

  async autoAssign(companyId: string, id: string) {
    const d = await this.getById(companyId, id);
    if (d.status !== 'unassigned') throw new BadRequestException('Delivery already assigned');
    const personnel = await this.personnelRepo.find({
      where: { companyId, isAvailable: true, status: 'active' },
      order: { currentLoad: 'ASC' },
      take: 1,
    });
    if (!personnel.length) throw new BadRequestException('No available personnel');
    d.personnelId = personnel[0].userId;
    d.status = 'pending';
    d.assignedAt = new Date();
    return this.repo.save(d);
  }

  async updateStatus(companyId: string, id: string, dto: DeliveryStatusUpdateDto, userId: string) {
    const d = await this.getById(companyId, id);
    const oldStatus = d.status;
    if (dto.status === 'cancelled') {
      if (['delivered', 'cancelled'].includes(oldStatus)) throw new BadRequestException('Cannot cancel delivered/cancelled delivery');
      d.status = dto.status;
      d.cancelReason = dto.notes ?? 'Cancelled by user';
    } else if (oldStatus === 'cancelled') {
      throw new BadRequestException('Cannot update cancelled delivery');
    } else {
      if (STATUS_ORDER[dto.status] !== undefined && STATUS_ORDER[oldStatus] !== undefined) {
        if (STATUS_ORDER[dto.status] < STATUS_ORDER[oldStatus]) {
          throw new BadRequestException('Cannot revert delivery status');
        }
      }
      d.status = dto.status;
    }
    if (dto.status === 'delivered') d.completedAt = new Date();
    await this.repo.save(d);

    const history = this.historyRepo.create({
      deliveryId: id,
      status: dto.status,
      notes: dto.notes ?? null,
      location: dto.location ?? null,
      changedBy: userId,
    });
    await this.historyRepo.save(history);
    return d;
  }

  async getHistory(companyId: string, deliveryId: string, page: number, limit: number) {
    const qb = this.historyRepo.createQueryBuilder('h')
      .innerJoin(Delivery, 'd', 'd.id = h.deliveryId')
      .where('d.companyId = :cid AND h.deliveryId = :did', { cid: companyId, did: deliveryId })
      .orderBy('h.timestamp', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async reportIssue(companyId: string, deliveryId: string, dto: DeliveryIssueDto, userId: string) {
    const d = await this.getById(companyId, deliveryId);
    const issue = this.issueRepo.create({
      deliveryId,
      issueType: dto.issueType,
      notes: dto.notes,
      photos: dto.photoUrl ? [dto.photoUrl] : [],
      reportedBy: userId,
    } as any);
    return this.issueRepo.save(issue);
  }

  async listIssues(companyId: string, deliveryId: string, page: number, limit: number) {
    const qb = this.issueRepo.createQueryBuilder('i')
      .innerJoin(Delivery, 'd', 'd.id = i.deliveryId')
      .where('d.companyId = :cid AND i.deliveryId = :did', { cid: companyId, did: deliveryId })
      .orderBy('i.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async myDeliveries(companyId: string, personnelId: string, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('d')
      .where('d.companyId = :cid AND d.personnelId = :pid', { cid: companyId, pid: personnelId })
      .andWhere('d.status IN (:...statuses)', { statuses: ['pending', 'picked_up', 'in_transit', 'arrived'] })
      .orderBy('d.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }
}
