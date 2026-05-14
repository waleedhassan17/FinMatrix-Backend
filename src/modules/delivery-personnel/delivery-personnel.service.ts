import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { DeliveryPersonnelProfile } from './entities/delivery-personnel-profile.entity';
import { CreatePersonnelDto, UpdatePersonnelDto, UpdateLocationDto } from './dto/delivery-personnel.dto';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { DeliveryLocationLog } from '../deliveries/entities/delivery-location-log.entity';

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

  async updateLocation(companyId: string, userId: string, dto: UpdateLocationDto) {
    const p = await this.getById(companyId, userId);
    p.currentLat = dto.lat.toFixed(7);
    p.currentLng = dto.lng.toFixed(7);
    p.heading = dto.heading ?? null;
    p.speed = dto.speed ?? null;
    p.accuracy = dto.accuracy ?? null;
    p.locationUpdatedAt = new Date();
    await this.repo.save(p);

    // Log location for any active delivery
    const activeDelivery = await this.dataSource.getRepository(Delivery).findOne({
      where: {
        personnelId: userId,
        companyId,
        status: In(['picked_up', 'in_transit', 'arrived']),
      },
    });

    if (activeDelivery) {
      const log = this.dataSource.getRepository(DeliveryLocationLog).create({
        deliveryId: activeDelivery.id,
        personnelId: userId,
        lat: dto.lat,
        lng: dto.lng,
        heading: dto.heading ?? null,
        speed: dto.speed ?? null,
        accuracy: dto.accuracy ?? null,
        status: activeDelivery.status,
      });
      await this.dataSource.getRepository(DeliveryLocationLog).save(log);
    }

    return { success: true };
  }

  async getLocation(companyId: string, userId: string) {
    const p = await this.getById(companyId, userId);
    const isOnline =
      !!p.locationUpdatedAt &&
      Date.now() - p.locationUpdatedAt.getTime() < 2 * 60 * 1000;
    return {
      lat: p.currentLat ? parseFloat(p.currentLat) : null,
      lng: p.currentLng ? parseFloat(p.currentLng) : null,
      heading: p.heading,
      speed: p.speed,
      accuracy: p.accuracy,
      locationUpdatedAt: p.locationUpdatedAt,
      isOnline,
    };
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
