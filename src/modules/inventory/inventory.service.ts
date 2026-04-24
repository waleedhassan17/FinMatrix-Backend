import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { InventoryItem } from './entities/inventory-item.entity';
import { InventoryMovement } from './entities/inventory-movement.entity';
import { InventoryAdjustment } from './entities/inventory-adjustment.entity';
import { StockTransfer } from './entities/stock-transfer.entity';
import { StockTransferLine } from './entities/stock-transfer-line.entity';
import { PhysicalCount } from './entities/physical-count.entity';
import { PhysicalCountLine } from './entities/physical-count-line.entity';
import {
  CreateInventoryItemDto,
  UpdateInventoryItemDto,
  InventoryItemQueryDto,
  AdjustQuantityDto,
  CreateStockTransferDto,
  CreatePhysicalCountDto,
  MovementQueryDto,
} from './dto/inventory.dto';
import { toDecimal } from '../../common/utils/money.util';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryItem) private readonly itemRepo: Repository<InventoryItem>,
    @InjectRepository(InventoryMovement) private readonly moveRepo: Repository<InventoryMovement>,
    @InjectRepository(InventoryAdjustment) private readonly adjRepo: Repository<InventoryAdjustment>,
    @InjectRepository(StockTransfer) private readonly xferRepo: Repository<StockTransfer>,
    @InjectRepository(StockTransferLine) private readonly xferLineRepo: Repository<StockTransferLine>,
    @InjectRepository(PhysicalCount) private readonly countRepo: Repository<PhysicalCount>,
    @InjectRepository(PhysicalCountLine) private readonly countLineRepo: Repository<PhysicalCountLine>,
    private readonly dataSource: DataSource,
  ) {}

  // Items
  async listItems(companyId: string, query: InventoryItemQueryDto, page: number, limit: number) {
    const qb = this.itemRepo.createQueryBuilder('i').where('i.companyId = :cid', { cid: companyId });
    if (query.q) qb.andWhere('(i.name ILIKE :q OR i.sku ILIKE :q)', { q: `%${query.q}%` });
    if (query.category) qb.andWhere('i.category = :cat', { cat: query.category });
    if (query.sourceAgencyId) qb.andWhere('i.sourceAgencyId = :sid', { sid: query.sourceAgencyId });
    if (query.locationId) qb.andWhere('i.locationId = :lid', { lid: query.locationId });
    if (query.isActive !== undefined) qb.andWhere('i.isActive = :a', { a: query.isActive });
    if (query.lowStock) qb.andWhere('i.quantityOnHand::numeric <= i.reorderPoint::numeric');
    qb.orderBy('i.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getItem(companyId: string, id: string) {
    const item = await this.itemRepo.findOne({ where: { id, companyId } });
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  async createItem(companyId: string, dto: CreateInventoryItemDto) {
    const exists = await this.itemRepo.findOne({ where: { companyId, sku: dto.sku } });
    if (exists) throw new BadRequestException('SKU already exists');
    const item = this.itemRepo.create({ ...dto, companyId, quantityOnHand: '0', quantityOnOrder: '0', quantityCommitted: '0' });
    return this.itemRepo.save(item);
  }

  async updateItem(companyId: string, id: string, dto: UpdateInventoryItemDto) {
    const item = await this.getItem(companyId, id);
    if (dto.sku && dto.sku !== item.sku) {
      const exists = await this.itemRepo.findOne({ where: { companyId, sku: dto.sku } });
      if (exists) throw new BadRequestException('SKU already exists');
    }
    Object.assign(item, dto);
    return this.itemRepo.save(item);
  }

  async toggleItem(companyId: string, id: string) {
    const item = await this.getItem(companyId, id);
    item.isActive = !item.isActive;
    return this.itemRepo.save(item);
  }

  // Adjust
  async adjust(companyId: string, dto: AdjustQuantityDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const itemRepo = em.getRepository(InventoryItem);
      const adjRepo = em.getRepository(InventoryAdjustment);
      const moveRepo = em.getRepository(InventoryMovement);
      const item = await itemRepo.findOne({ where: { id: dto.itemId, companyId } });
      if (!item) throw new NotFoundException('Item not found');

      const prev = toDecimal(item.quantityOnHand);
      const next = toDecimal(dto.newQty);
      const variance = next.minus(prev);

      item.quantityOnHand = next.toFixed(4);
      await itemRepo.save(item);

      const adj = adjRepo.create({
        companyId,
        itemId: dto.itemId,
        date: new Date().toISOString().split('T')[0],
        previousQty: prev.toFixed(4),
        newQty: next.toFixed(4),
        variance: variance.toFixed(4),
        reason: dto.reason,
        notes: dto.notes ?? null,
        createdBy: userId,
      });
      await adjRepo.save(adj);

      const move = moveRepo.create({
        companyId,
        itemId: dto.itemId,
        date: new Date().toISOString().split('T')[0],
        type: 'adjustment',
        quantityChange: variance.toFixed(4),
        balanceAfter: next.toFixed(4),
        description: dto.notes ?? 'Inventory adjustment',
        sourceType: 'inventory_adjustment',
        sourceId: adj.id,
        createdBy: userId,
      });
      await moveRepo.save(move);
      return { item, adjustment: adj, movement: move };
    });
  }

  // Transfer
  async createTransfer(companyId: string, dto: CreateStockTransferDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const xferRepo = em.getRepository(StockTransfer);
      const lineRepo = em.getRepository(StockTransferLine);
      const itemRepo = em.getRepository(InventoryItem);
      const moveRepo = em.getRepository(InventoryMovement);
      const xfer = xferRepo.create({
        companyId,
        fromLocationId: dto.fromLocationId ?? null,
        toLocationId: dto.toLocationId ?? null,
        transferDate: dto.transferDate,
        reference: dto.reference ?? null,
        notes: dto.notes ?? null,
        status: 'draft',
        createdBy: userId,
      });
      await xferRepo.save(xfer);

      const lines = dto.lines.map((l) => lineRepo.create({ transferId: xfer.id, itemId: l.itemId, quantity: l.quantity }));
      await lineRepo.save(lines);

      // movements
      for (const l of dto.lines) {
        const item = await itemRepo.findOne({ where: { id: l.itemId, companyId } });
        if (!item) continue;
        const q = toDecimal(item.quantityOnHand);
        const newQty = q.minus(toDecimal(l.quantity));
        item.quantityOnHand = newQty.toFixed(4);
        await itemRepo.save(item);
        await moveRepo.save(moveRepo.create({
          companyId,
          itemId: l.itemId,
          date: dto.transferDate,
          type: 'transfer',
          quantityChange: '-' + l.quantity,
          balanceAfter: newQty.toFixed(4),
          reference: dto.reference ?? null,
          sourceType: 'stock_transfer',
          sourceId: xfer.id,
          createdBy: userId,
        }));
      }
      return xfer;
    });
  }

  async completeTransfer(companyId: string, id: string) {
    const xfer = await this.xferRepo.findOne({ where: { id, companyId }, relations: ['lines'] });
    if (!xfer) throw new NotFoundException('Transfer not found');
    if (xfer.status !== 'draft') throw new BadRequestException('Transfer already processed');
    xfer.status = 'completed';
    return this.xferRepo.save(xfer);
  }

  // Physical Count
  async createCount(companyId: string, dto: CreatePhysicalCountDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const countRepo = em.getRepository(PhysicalCount);
      const lineRepo = em.getRepository(PhysicalCountLine);
      const itemRepo = em.getRepository(InventoryItem);

      const count = countRepo.create({ companyId, countDate: dto.countDate, notes: dto.notes ?? null, createdBy: userId });
      await countRepo.save(count);

      const lines = [];
      for (const l of dto.lines) {
        const item = await itemRepo.findOne({ where: { id: l.itemId, companyId } });
        const sysQty = item ? item.quantityOnHand : '0';
        const variance = toDecimal(l.countedQty).minus(toDecimal(sysQty));
        const line = lineRepo.create({
          countId: count.id,
          itemId: l.itemId,
          systemQty: sysQty,
          countedQty: l.countedQty,
          variance: variance.toFixed(4),
        });
        lines.push(await lineRepo.save(line));
      }
      return { count, lines };
    });
  }

  // Movements
  async listMovements(companyId: string, query: MovementQueryDto, page: number, limit: number) {
    const qb = this.moveRepo.createQueryBuilder('m').where('m.companyId = :cid', { cid: companyId });
    if (query.itemId) qb.andWhere('m.itemId = :iid', { iid: query.itemId });
    if (query.type) qb.andWhere('m.type = :t', { t: query.type });
    if (query.startDate) qb.andWhere('m.date >= :s', { s: query.startDate });
    if (query.endDate) qb.andWhere('m.date <= :e', { e: query.endDate });
    qb.orderBy('m.date', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  // Item movements
  async itemMovements(companyId: string, itemId: string, page: number, limit: number) {
    const qb = this.moveRepo.createQueryBuilder('m')
      .where('m.companyId = :cid AND m.itemId = :iid', { cid: companyId, iid: itemId })
      .orderBy('m.date', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }
}
