import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { DeliveryPersonnelProfile } from './entities/delivery-personnel-profile.entity';
import { CreatePersonnelDto, UpdatePersonnelDto, UpdateLocationDto } from './dto/delivery-personnel.dto';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { DeliveryLocationLog } from '../deliveries/entities/delivery-location-log.entity';
import { User } from '../users/entities/user.entity';
import { ManagedCredential } from '../users/entities/managed-credential.entity';
import { CredentialVaultService } from '../users/credential-vault.service';
import { getPlanConfig } from '../billing/plan-config';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';

@Injectable()
export class DeliveryPersonnelService {
  private readonly logger = new Logger(DeliveryPersonnelService.name);

  constructor(
    @InjectRepository(DeliveryPersonnelProfile)
    private readonly repo: Repository<DeliveryPersonnelProfile>,
    private readonly dataSource: DataSource,
    private readonly audit: OperationalAuditService,
    private readonly vault: CredentialVaultService,
  ) {}

  async list(companyId: string, page: number, limit: number, status?: string) {
    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoin('users', 'u', 'u.id = p.user_id')
      .addSelect('u.display_name', 'u_name')
      .addSelect('u.email', 'u_email')
      .addSelect('u.username', 'u_username')
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
      username: raw[i]?.u_username ?? null,
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
      .addSelect('u.username', 'u_username')
      .addSelect('u.phone', 'u_phone')
      .where('p.userId = :uid AND p.companyId = :cid', { uid: userId, cid: companyId })
      .getRawAndEntities();

    const p = result.entities[0];
    if (!p) throw new NotFoundException('Delivery personnel not found');

    return {
      ...p,
      name: result.raw[0]?.u_name ?? null,
      email: result.raw[0]?.u_email ?? null,
      username: result.raw[0]?.u_username ?? null,
      phone: result.raw[0]?.u_phone ?? null,
    };
  }

  async create(companyId: string, dto: CreatePersonnelDto, actorUserId?: string) {
    return this.dataSource.transaction(async (em) => {
      // phase2.md — plan-based limit (authoritative, server-side). Free = 1,
      // paid = 3 active personnel. A downgrade never deletes extras; it only
      // blocks creating new ones until the company is within the limit again.
      const companyRow: Array<{ subscription_plan: string | null }> = await em.query(
        `SELECT subscription_plan FROM companies WHERE id = $1 LIMIT 1`,
        [companyId],
      );
      const planConfig = getPlanConfig(companyRow[0]?.subscription_plan);
      const activeCountRow: Array<{ count: string }> = await em.query(
        `SELECT COUNT(*)::int AS count FROM delivery_personnel_profiles
          WHERE company_id = $1 AND status = 'active'`,
        [companyId],
      );
      const activeCount = Number(activeCountRow[0]?.count ?? 0);
      if (activeCount >= planConfig.deliveryPersonnelLimit) {
        throw new BadRequestException({
          code: 'DELIVERY_PERSONNEL_LIMIT_REACHED',
          message:
            `Your ${planConfig.label} plan allows ${planConfig.deliveryPersonnelLimit} ` +
            `delivery ${planConfig.deliveryPersonnelLimit === 1 ? 'person' : 'people'}. ` +
            `Upgrade your plan to add more delivery personnel.`,
          limit: planConfig.deliveryPersonnelLimit,
          currentCount: activeCount,
        });
      }

      let userId = dto.userId;

      // Riders never sign themselves up: the owner or a staff member creates
      // the account here and hands the credentials over in person. The login
      // handle is the USERNAME — email is an optional contact detail, where
      // this once demanded an email and silently created no account at all
      // when only a username was supplied.
      const username = dto.username?.trim().toLowerCase() || null;
      const email = dto.email?.trim().toLowerCase() || null;
      if (!userId && username && dto.password) {
        const userRepo = em.getRepository(User);
        if (await userRepo.findOne({ where: { username } })) {
          throw new BadRequestException({
            code: 'USERNAME_TAKEN',
            message: `The username "${username}" is already in use. Choose another.`,
          });
        }
        if (email && (await userRepo.findOne({ where: { email } }))) {
          throw new BadRequestException('A user with this email already exists');
        }

        const hash = await bcrypt.hash(dto.password, 12);
        const user = await userRepo.save(
          userRepo.create({
            email,
            username,
            passwordHash: hash,
            displayName: dto.name ?? username,
            phone: dto.phone ?? null,
            role: 'delivery',
            isActive: true,
            // Nothing to verify: the company vouched for this account by
            // creating it, and there may be no inbox to send to.
            isEmailVerified: true,
            emailVerifiedAt: new Date(),
            defaultCompanyId: companyId,
          }),
        );
        userId = user.id;

        // Create user_company membership
        await em.getRepository('user_companies').save(
          em.getRepository('user_companies').create({
            userId,
            companyId,
            role: 'delivery',
          }),
        );

        // The creator is the custodian of this password: riders have no
        // self-service reset, so the encrypted copy is what lets the personnel
        // screen show the credentials again when the rider forgets them.
        await this.storeCredential(em, companyId, userId, dto.password, actorUserId);
      }

      if (!userId) {
        throw new BadRequestException(
          'Either userId, or a username plus a password, must be provided',
        );
      }

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
        username,
        // Returned once so the creator can pass them on; also stored
        // encrypted, so the screen can show them again later.
        credentials: username
          ? { username, password: dto.password }
          : undefined,
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

  async update(
    companyId: string,
    userId: string,
    dto: UpdatePersonnelDto,
    actorUserId?: string,
  ) {
    const p = await this.getById(companyId, userId);
    const previousStatus = p.status;
    Object.assign(p, dto);
    const saved = await this.repo.save(p);
    if (dto.status && dto.status !== previousStatus) {
      await this.audit.record({
        companyId,
        actorUserId: actorUserId ?? null,
        action:
          dto.status === 'inactive'
            ? 'personnel_deactivated'
            : dto.status === 'active'
              ? 'personnel_reactivated'
              : 'personnel_status_changed',
        targetType: 'delivery_personnel',
        targetId: userId,
        details: { from: previousStatus, to: dto.status },
      });
    }
    return saved;
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

  /**
   * Re-issue the rider's password and hand it back once, for the creator to
   * pass on. This is the only recovery path: a rider account has no inbox and
   * no self-service reset (see AuthService.forgotPassword).
   */
  async resetPassword(companyId: string, userId: string, actorUserId?: string) {
    const p = await this.getById(companyId, userId);
    const password = this.vault.generatePassword();
    const hash = await bcrypt.hash(password, 12);

    await this.dataSource.transaction(async (em) => {
      await em.getRepository(User).update(p.userId, { passwordHash: hash });
      await this.storeCredential(em, companyId, p.userId, password, actorUserId);
    });

    await this.audit.record({
      companyId,
      actorUserId: actorUserId ?? null,
      action: 'personnel_password_reset',
      targetType: 'delivery_personnel',
      targetId: p.userId,
      // Never the password itself.
      details: { username: p.username ?? null },
    });
    return {
      userId: p.userId,
      credentials: { username: p.username ?? '', password },
      message: 'Password reset. Share the credentials with the rider.',
    };
  }

  /**
   * Show the stored credentials again. Audited on every read: the vault exists
   * so a locked-out rider can be helped, and the audit row is what makes that
   * help traceable.
   */
  async revealCredential(companyId: string, userId: string, actorUserId?: string) {
    const p = await this.getById(companyId, userId);
    const record = await this.dataSource
      .getRepository(ManagedCredential)
      .findOne({ where: { companyId, userId: p.userId } });

    await this.audit.record({
      companyId,
      actorUserId: actorUserId ?? null,
      action: 'personnel_credential_viewed',
      targetType: 'delivery_personnel',
      targetId: p.userId,
      details: { username: p.username ?? null },
    });

    return {
      userId: p.userId,
      username: p.username ?? null,
      // Null when nothing was stored, or the encryption key has rotated. The
      // screen offers "reset password" then, rather than showing a stale value.
      password: record ? this.vault.decrypt(record.secret) : null,
    };
  }

  /**
   * Upsert: re-issuing replaces the custodian's copy rather than accumulating
   * a history of passwords nobody should still be able to use.
   */
  private async storeCredential(
    em: EntityManager,
    companyId: string,
    userId: string,
    password: string,
    issuedBy?: string,
  ): Promise<void> {
    if (!this.vault.isConfigured) {
      // Encryption unavailable — do NOT fall back to clear text. The account
      // still works; only the convenience copy is skipped.
      this.logger.warn(
        'CREDENTIAL_ENCRYPTION_KEY is not set — the shareable password was not stored.',
      );
      return;
    }
    const repo = em.getRepository(ManagedCredential);
    const existing = await repo.findOne({ where: { userId } });
    const secret = this.vault.encrypt(password);
    if (existing) {
      Object.assign(existing, {
        secret,
        companyId,
        issuedBy: issuedBy ?? existing.issuedBy,
        issuedAt: new Date(),
      });
      await repo.save(existing);
      return;
    }
    await repo.save(
      repo.create({
        companyId,
        userId,
        secret,
        issuedBy: issuedBy ?? userId,
        issuedAt: new Date(),
      }),
    );
  }
}
