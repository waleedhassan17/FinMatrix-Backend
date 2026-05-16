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
    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoin('users', 'u', 'u.id = p.user_id')
      .addSelect('u.display_name', 'u_name')
      .addSelect('u.email', 'u_email')
      .addSelect('u.phone', 'u_phone')
      .where('p.companyId = :cid', { cid: companyId });
    if (status) qb.andWhere('p.status = :s', { s: status });
    qb.orderBy('p.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);

    const { entities, raw } = await qb.getRawAndEntities();
    const total = await qb.getCount();

    const data = entities.map((p, i) => ({
      ...p,
      name: raw[i]?.u_name ?? null,
      email: raw[i]?.u_email ?? null,
      phone: raw[i]?.u_phone ?? null,
    }));

    return { data, total, page, limit };
  }

  async getById(companyId: string, userId: string) {
    const result = await this.repo
      .createQueryBuilder('p')
      .leftJoin('users', 'u', 'u.id = p.user_id')
      .addSelect('u.display_name', 'u_name')
      .addSelect('u.email', 'u_email')
      .addSelect('u.phone', 'u_phone')
      .where('p.userId = :uid AND p.companyId = :cid', { uid: userId, cid: companyId })
      .getRawAndEntities();

    const p = result.entities[0];
    if (!p) throw new NotFoundException('Delivery personnel not found');

    return {
      ...p,
      name: result.raw[0]?.u_name ?? null,
      email: result.raw[0]?.u_email ?? null,
      phone: result.raw[0]?.u_phone ?? null,
    };
  }

  async create(companyId: string, dto: CreatePersonnelDto) {
    return this.dataSource.transaction(async (em) => {
      let userId = dto.userId;

      // If email+password provided, create a new user first
      if (!userId && dto.email && dto.password) {
        const userRepo = em.getRepository('users');
        const existing = await userRepo.findOne({ where: { email: dto.email } });
        if (existing) throw new BadRequestException('A user with this email already exists');

        const hash = await bcrypt.hash(dto.password, 12);
        const user = await userRepo.save(userRepo.create({
          email: dto.email,
          passwordHash: hash,
          displayName: dto.name ?? dto.username ?? dto.email,
          phone: dto.phone ?? null,
          role: 'delivery',
          isActive: true,
          defaultCompanyId: companyId,
        }));
        userId = user.id;

        // Create user_company membership
        await em.getRepository('user_companies').save(
          em.getRepository('user_companies').create({
            userId,
            companyId,
            role: 'delivery',
          }),
        );
      }

      if (!userId) throw new BadRequestException('Either userId or email+password must be provided');

      const profileRepo = em.getRepository(DeliveryPersonnelProfile);
      const exists = await profileRepo.findOne({ where: { userId, companyId } });
      if (exists) throw new BadRequestException('Profile already exists for this user');

      const profile = profileRepo.create({
        userId,
        companyId,
        vehicleType: dto.vehicleType ?? null,
        vehicleNumber: dto.vehicleNumber ?? null,
        zones: dto.zones ?? [],
        maxLoad: dto.maxLoad ?? '0',
        currentLoad: '0',
        isAvailable: true,
        status: 'active',
        rating: '5.00',
        totalDeliveries: 0,
        onTimeRate: '100.00',
      });
      await profileRepo.save(profile);

      return {
        userId,
        email: dto.email,
        name: dto.name ?? dto.username,
        phone: dto.phone,
        vehicleType: profile.vehicleType,
        vehicleNumber: profile.vehicleNumber,
        zones: profile.zones,
        maxLoad: profile.maxLoad,
        status: profile.status,
      };
    });
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
