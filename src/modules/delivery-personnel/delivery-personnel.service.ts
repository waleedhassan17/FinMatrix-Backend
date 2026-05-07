import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { DeliveryPersonnelProfile } from './entities/delivery-personnel-profile.entity';
import { CreatePersonnelDto, UpdatePersonnelDto } from './dto/delivery-personnel.dto';

@Injectable()
export class DeliveryPersonnelService {
  constructor(
    @InjectRepository(DeliveryPersonnelProfile)
    private readonly repo: Repository<DeliveryPersonnelProfile>,
    private readonly dataSource: DataSource,
  ) {}

  async list(companyId: string, page: number, limit: number, status?: string) {
    const qb = this.repo.createQueryBuilder('p').where('p.companyId = :cid', { cid: companyId });
    if (status) qb.andWhere('p.status = :s', { s: status });
    qb.orderBy('p.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, userId: string) {
    const p = await this.repo.findOne({ where: { userId, companyId } });
    if (!p) throw new NotFoundException('Delivery personnel not found');
    return p;
  }

  async create(companyId: string, dto: CreatePersonnelDto) {
    const exists = await this.repo.findOne({ where: { userId: dto.userId, companyId } });
    if (exists) throw new BadRequestException('Profile already exists');
    const profile = this.repo.create({ ...dto, companyId });
    return this.repo.save(profile);
  }

  async update(companyId: string, userId: string, dto: UpdatePersonnelDto) {
    const p = await this.getById(companyId, userId);
    Object.assign(p, dto);
    return this.repo.save(p);
  }

  async toggleAvailability(companyId: string, userId: string) {
    const p = await this.getById(companyId, userId);
    p.isAvailable = !p.isAvailable;
    return this.repo.save(p);
  }

  async updateLocation(companyId: string, userId: string, lat: number, lng: number) {
    const p = await this.getById(companyId, userId);
    p.currentLat = lat.toFixed(7);
    p.currentLng = lng.toFixed(7);
    p.locationUpdatedAt = new Date();
    return this.repo.save(p);
  }

  async resetPassword(companyId: string, userId: string) {
    const p = await this.getById(companyId, userId);
    const tempPassword = `Del@${Math.floor(1000 + Math.random() * 9000)}`;
    const hash = await bcrypt.hash(tempPassword, 10);
    await this.dataSource
      .createQueryBuilder()
      .update('users')
      .set({ passwordHash: hash })
      .where('id = :id', { id: p.userId })
      .execute();
    return {
      userId: p.userId,
      credentials: { email: p.userId, temporaryPassword: tempPassword },
      message: 'Password reset. Share credentials securely.',
    };
  }
}
