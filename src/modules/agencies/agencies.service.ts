import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agency } from './entities/agency.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { CreateAgencyDto, UpdateAgencyDto, AgencyQueryDto, AgencyInventoryItemDto, AddAgencyItemDto } from './dto/agency.dto';

@Injectable()
export class AgenciesService {
  constructor(
    @InjectRepository(Agency)
    private readonly repo: Repository<Agency>,
    @InjectRepository(InventoryItem)
    private readonly itemRepo: Repository<InventoryItem>,
  ) {}

  async list(companyId: string, query: AgencyQueryDto, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('a').where('a.companyId = :cid', { cid: companyId });
    if (query.type) qb.andWhere('a.type = :t', { t: query.type });
    if (query.isConnected !== undefined) qb.andWhere('a.isConnected = :c', { c: query.isConnected });
    if (query.q) qb.andWhere('(a.name ILIKE :q)', { q: `%${query.q}%` });
    qb.orderBy('a.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const item = await this.repo.findOne({ where: { id, companyId } });
    if (!item) throw new NotFoundException('Agency not found');
    return item;
  }

  async create(companyId: string, dto: CreateAgencyDto) {
    const agency = this.repo.create({ ...dto, companyId });
    return this.repo.save(agency);
  }

  async update(companyId: string, id: string, dto: UpdateAgencyDto) {
    const item = await this.getById(companyId, id);
    Object.assign(item, dto);
    return this.repo.save(item);
  }

  async remove(companyId: string, id: string) {
    const item = await this.getById(companyId, id);
    await this.repo.softRemove(item);
    return { id, deleted: true };
  }

  async toggleActive(companyId: string, id: string) {
    const item = await this.getById(companyId, id);
    item.isActive = !item.isActive;
    return this.repo.save(item);
  }

  async toggleConnected(companyId: string, id: string, isConnected: boolean) {
    const item = await this.getById(companyId, id);
    item.isConnected = isConnected;
    if (isConnected) item.lastSyncAt = new Date();
    return this.repo.save(item);
  }

  async assignInventory(companyId: string, id: string, itemId: string, quantity: string) {
    // Verify the agency exists
    const agency = await this.getById(companyId, id);

    // Look up the inventory item and link it to this agency
    const invItem = await this.itemRepo.findOne({ where: { id: itemId, companyId } });
    if (!invItem) throw new NotFoundException(`Inventory item ${itemId} not found`);

    // Set/update the sourceAgencyId so this item is linked to the agency
    invItem.sourceAgencyId = agency.id;
    await this.itemRepo.save(invItem);

    // Also reflect in the agency's JSONB inventory array
    const existingInv: AgencyInventoryItemDto[] = Array.isArray((agency as any).inventory)
      ? [...(agency as any).inventory]
      : [];
    const existingIdx = existingInv.findIndex(i => i.itemId === itemId);
    const inventoryEntry: AgencyInventoryItemDto = {
      itemId: invItem.id,
      itemName: invItem.name,
      name: invItem.name,
      sku: invItem.sku,
      category: invItem.category ?? undefined,
      unitOfMeasure: invItem.unitOfMeasure,
      unitCost: Number(invItem.unitCost),
      sellingPrice: Number(invItem.sellingPrice),
      quantity: Number(quantity) || Number(invItem.quantityOnHand),
      quantityOnHand: Number(invItem.quantityOnHand),
      reorderLevel: Number(invItem.reorderPoint),
      reorderPoint: Number(invItem.reorderPoint),
    };
    if (existingIdx !== -1) {
      existingInv[existingIdx] = inventoryEntry;
    } else {
      existingInv.push(inventoryEntry);
    }
    (agency as any).inventory = existingInv;
    await this.repo.save(agency);

    return {
      success: true,
      data: {
        agencyId: agency.id,
        itemId: invItem.id,
        itemName: invItem.name,
        quantityAssigned: quantity,
        assignedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Returns all InventoryItem records whose sourceAgencyId equals agencyId.
   */
  async getAgencyInventoryItems(companyId: string, agencyId: string) {
    // Verify agency exists and belongs to this company
    await this.getById(companyId, agencyId);
    const items = await this.itemRepo.find({
      where: { companyId, sourceAgencyId: agencyId },
      order: { name: 'ASC' },
    });
    return { data: items, total: items.length };
  }

  /**
   * Creates a new InventoryItem linked to the specified agency.
   */
  async addItemToAgency(companyId: string, agencyId: string, dto: AddAgencyItemDto) {
    // Verify agency exists and belongs to this company
    const agency = await this.getById(companyId, agencyId);

    const item = this.itemRepo.create({
      companyId,
      sourceAgencyId: agency.id,
      name: dto.name,
      sku: dto.sku,
      category: dto.category ?? null,
      unitCost: dto.unitCost ?? '0',
      sellingPrice: dto.sellingPrice ?? '0',
      quantityOnHand: dto.quantityOnHand ?? '0',
      quantityOnOrder: '0',
      quantityCommitted: '0',
      reorderPoint: '0',
      reorderQuantity: '0',
      minStock: '0',
      maxStock: '0',
      unitOfMeasure: dto.unitOfMeasure ?? 'unit',
      costMethod: 'average',
      serialTracking: false,
      lotTracking: false,
      barcodeData: null,
      isActive: true,
      description: null,
      locationId: null,
    });
    return this.itemRepo.save(item);
  }

  async syncInventory(companyId: string, id: string, inventory: AgencyInventoryItemDto[]) {
    const item = await this.getById(companyId, id);

    item.inventory = inventory as any;
    item.lastSyncAt = new Date();
    await this.repo.save(item);

    return { ...item, itemCount: inventory.length };
  }
}
