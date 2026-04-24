import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShadowInventorySnapshot } from './entities/shadow-inventory-snapshot.entity';
import { CreateSnapshotDto, UpdateSnapshotDto } from './dto/shadow-inventory.dto';

@Injectable()
export class ShadowInventoryService {
  constructor(
    @InjectRepository(ShadowInventorySnapshot)
    private readonly repo: Repository<ShadowInventorySnapshot>,
  ) {}

  async list(companyId: string, personnelId: string | undefined, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('s').where('s.companyId = :cid', { cid: companyId });
    if (personnelId) qb.andWhere('s.personnelId = :pid', { pid: personnelId });
    qb.orderBy('s.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const s = await this.repo.findOne({ where: { id, companyId } });
    if (!s) throw new NotFoundException('Snapshot not found');
    return s;
  }

  async create(companyId: string, dto: CreateSnapshotDto) {
    const snap = this.repo.create({ ...dto, companyId, syncStatus: 'synced', lastSyncAt: new Date() });
    return this.repo.save(snap);
  }

  async update(companyId: string, id: string, dto: UpdateSnapshotDto) {
    const s = await this.getById(companyId, id);
    Object.assign(s, dto);
    if (dto.currentQty !== undefined || dto.syncStatus !== undefined) s.lastSyncAt = new Date();
    return this.repo.save(s);
  }

  async syncAll(companyId: string, personnelId: string) {
    await this.repo.update(
      { companyId, personnelId, syncStatus: 'pending' },
      { syncStatus: 'synced', lastSyncAt: new Date() },
    );
    return { synced: true };
  }
}
