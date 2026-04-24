import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { InventoryUpdateRequest } from './entities/inventory-update-request.entity';
import { InventoryUpdateRequestLine } from './entities/inventory-update-request-line.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { CreateInventoryUpdateRequestDto, ReviewRequestDto } from './dto/inventory-approval.dto';
import { toDecimal } from '../../common/utils/money.util';

@Injectable()
export class InventoryApprovalsService {
  constructor(
    @InjectRepository(InventoryUpdateRequest) private readonly reqRepo: Repository<InventoryUpdateRequest>,
    @InjectRepository(InventoryUpdateRequestLine) private readonly lineRepo: Repository<InventoryUpdateRequestLine>,
    private readonly dataSource: DataSource,
  ) {}

  async list(companyId: string, status: string | undefined, page: number, limit: number) {
    const qb = this.reqRepo.createQueryBuilder('r').where('r.companyId = :cid', { cid: companyId });
    if (status) qb.andWhere('r.status = :s', { s: status });
    qb.orderBy('r.submittedAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const req = await this.reqRepo.findOne({ where: { id, companyId }, relations: ['lines'] });
    if (!req) throw new NotFoundException('Request not found');
    return req;
  }

  async create(companyId: string, dto: CreateInventoryUpdateRequestDto) {
    return this.dataSource.transaction(async (em) => {
      const reqRepo = em.getRepository(InventoryUpdateRequest);
      const lineRepo = em.getRepository(InventoryUpdateRequestLine);
      const itemRepo = em.getRepository(InventoryItem);

      const req = reqRepo.create({
        companyId,
        deliveryId: dto.deliveryId,
        personnelId: dto.personnelId,
        status: 'pending',
        submittedAt: new Date(),
      });
      await reqRepo.save(req);

      const lines = [];
      for (const l of dto.lines) {
        const item = await itemRepo.findOne({ where: { id: l.itemId, companyId } });
        const beforeQty = item ? item.quantityOnHand : '0';
        const delivered = toDecimal(l.deliveredQty);
        const returned = toDecimal(l.returnedQty ?? '0');
        const afterQty = toDecimal(beforeQty).plus(delivered).minus(returned);

        const line = lineRepo.create({
          requestId: req.id,
          itemId: l.itemId,
          beforeQty: beforeQty,
          deliveredQty: delivered.toFixed(4),
          returnedQty: returned.toFixed(4),
          afterQty: afterQty.toFixed(4),
        });
        lines.push(await lineRepo.save(line));
      }
      return { ...req, lines };
    });
  }

  async review(companyId: string, id: string, dto: ReviewRequestDto, reviewerId: string) {
    if (dto.action !== 'approved' && dto.action !== 'rejected') throw new BadRequestException('Invalid action');
    return this.dataSource.transaction(async (em) => {
      const reqRepo = em.getRepository(InventoryUpdateRequest);
      const lineRepo = em.getRepository(InventoryUpdateRequestLine);
      const itemRepo = em.getRepository(InventoryItem);
      const moveRepo = em.getRepository(InventoryMovement);

      const req = await reqRepo.findOne({ where: { id, companyId }, relations: ['lines'] });
      if (!req) throw new NotFoundException('Request not found');
      if (req.status !== 'pending') throw new BadRequestException('Request already reviewed');

      req.status = dto.action;
      req.reviewedAt = new Date();
      req.reviewedBy = reviewerId;
      req.approvalNotes = dto.notes ?? null;
      if (dto.action === 'rejected') req.rejectReason = dto.notes ?? 'Rejected';
      await reqRepo.save(req);

      if (dto.action === 'approved') {
        for (const line of req.lines) {
          const item = await itemRepo.findOne({ where: { id: line.itemId, companyId } });
          if (!item) continue;
          item.quantityOnHand = line.afterQty;
          await itemRepo.save(item);

          await moveRepo.save(moveRepo.create({
            companyId,
            itemId: line.itemId,
            date: new Date().toISOString().split('T')[0],
            type: 'delivery',
            quantityChange: toDecimal(line.deliveredQty).minus(toDecimal(line.returnedQty)).toFixed(4),
            balanceAfter: line.afterQty,
            reference: `Approval ${req.id}`,
            sourceType: 'inventory_approval',
            sourceId: req.id,
          }));
        }
      }
      return req;
    });
  }
}
