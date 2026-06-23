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
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import {
  ACCT_INVENTORY,
  ACCT_INVENTORY_ADJUSTMENT,
} from '../accounts/accounts.constants';

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
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
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

      // Per FinMatrixGuide §3.8: an adjustment moves stock AND the Inventory GL
      // together, recording the difference as a shrinkage/adjustment expense.
      const je = await this.postInventoryAdjustmentJe(
        em,
        companyId,
        userId,
        item,
        variance,
        adj.date,
        `Inventory adjustment ${item.sku} (${dto.reason})`,
        'inventory_adjustment',
        adj.id,
      );
      if (je) {
        adj.journalEntryId = je;
        await adjRepo.save(adj);
      }

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

      // A stock transfer relocates an item between locations. quantityOnHand is
      // tracked per item (not per location), and all inventory rolls up to the
      // same Inventory GL account, so a transfer is asset-to-asset with NO P&L
      // impact and NO change to total quantity on hand (FinMatrixGuide §3.8).
      // We update the item's location and record audit movements only.
      for (const l of dto.lines) {
        const item = await itemRepo.findOne({ where: { id: l.itemId, companyId } });
        if (!item) continue;
        if (dto.toLocationId) {
          item.locationId = dto.toLocationId;
          await itemRepo.save(item);
        }
        await moveRepo.save(moveRepo.create({
          companyId,
          itemId: l.itemId,
          date: dto.transferDate,
          type: 'transfer',
          quantityChange: '0',
          balanceAfter: item.quantityOnHand,
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

  // Physical Count — records the count AND reconciles stock to the counted
  // quantity, posting the variance as an inventory adjustment (FinMatrixGuide
  // §3.8: stock and the Inventory GL move together; shrinkage is expensed).
  async createCount(companyId: string, dto: CreatePhysicalCountDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const countRepo = em.getRepository(PhysicalCount);
      const lineRepo = em.getRepository(PhysicalCountLine);
      const itemRepo = em.getRepository(InventoryItem);
      const moveRepo = em.getRepository(InventoryMovement);
      const adjRepo = em.getRepository(InventoryAdjustment);

      const count = countRepo.create({ companyId, countDate: dto.countDate, notes: dto.notes ?? null, createdBy: userId });
      await countRepo.save(count);

      const lines = [];
      for (const l of dto.lines) {
        const item = await itemRepo.findOne({ where: { id: l.itemId, companyId } });
        const sysQty = item ? item.quantityOnHand : '0';
        const counted = toDecimal(l.countedQty);
        const variance = counted.minus(toDecimal(sysQty));
        const line = lineRepo.create({
          countId: count.id,
          itemId: l.itemId,
          systemQty: sysQty,
          countedQty: l.countedQty,
          variance: variance.toFixed(4),
        });

        // Reconcile stock + post the GL adjustment for any non-zero variance.
        if (item && !variance.isZero()) {
          item.quantityOnHand = counted.toFixed(4);
          await itemRepo.save(item);

          const adj = await adjRepo.save(
            adjRepo.create({
              companyId,
              itemId: item.id,
              date: dto.countDate,
              previousQty: sysQty,
              newQty: counted.toFixed(4),
              variance: variance.toFixed(4),
              reason: 'physical_count',
              notes: `Physical count ${dto.countDate}`,
              createdBy: userId,
            }),
          );
          await moveRepo.save(
            moveRepo.create({
              companyId,
              itemId: item.id,
              date: dto.countDate,
              type: 'adjustment',
              quantityChange: variance.toFixed(4),
              balanceAfter: counted.toFixed(4),
              description: 'Physical count adjustment',
              sourceType: 'physical_count',
              sourceId: count.id,
              createdBy: userId,
            }),
          );
          const je = await this.postInventoryAdjustmentJe(
            em,
            companyId,
            userId,
            item,
            variance,
            dto.countDate,
            `Physical count ${item.sku}`,
            'physical_count',
            count.id,
          );
          if (je) {
            adj.journalEntryId = je;
            await adjRepo.save(adj);
          }
          (line as any).adjustmentId = adj.id;
        }
        lines.push(await lineRepo.save(line));
      }
      return { count, lines };
    });
  }

  /**
   * Post the balanced inventory-adjustment journal entry for a quantity
   * variance valued at the item's unit cost. Returns the entry id (or null
   * when the value is zero). Shared by adjust() and physical count.
   *   decrease (variance < 0): DR Inventory Adjustment 6400 / CR Inventory 1200
   *   increase (variance > 0): DR Inventory 1200 / CR Inventory Adjustment 6400
   */
  private async postInventoryAdjustmentJe(
    em: import('typeorm').EntityManager,
    companyId: string,
    userId: string,
    item: InventoryItem,
    variance: Decimal,
    date: string,
    memo: string,
    sourceType: string,
    sourceId: string,
  ): Promise<string | null> {
    const value = variance.abs().times(toDecimal(item.unitCost));
    if (value.lessThanOrEqualTo(0)) return null;
    const inventoryAcct = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, em);
    const adjustmentAcct = await this.accounts.getOrCreateSystemAccount(
      em,
      companyId,
      ACCT_INVENTORY_ADJUSTMENT,
    );
    const amount = value.toFixed(4);
    const increase = variance.greaterThan(0);
    const lines = increase
      ? [
          { accountId: inventoryAcct.id, debit: amount, credit: '0' },
          { accountId: adjustmentAcct.id, debit: '0', credit: amount },
        ]
      : [
          { accountId: adjustmentAcct.id, debit: amount, credit: '0' },
          { accountId: inventoryAcct.id, debit: '0', credit: amount },
        ];
    const entry = await this.posting.createEntry(em, {
      companyId,
      createdBy: userId,
      date,
      memo,
      status: 'posted',
      lines: lines.map((l, i) => ({ ...l, lineOrder: i })),
      sourceType,
      sourceId,
    });
    return entry.id;
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
