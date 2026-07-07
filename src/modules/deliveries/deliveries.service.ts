import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { DeliveryItem } from './entities/delivery-item.entity';
import { DeliveryStatusHistory } from './entities/delivery-status-history.entity';
import { DeliveryIssue } from './entities/delivery-issue.entity';
import { DeliverySignature } from './entities/delivery-signature.entity';
import { DeliveryLocationLog } from './entities/delivery-location-log.entity';
import { DeliveryPersonnelProfile } from '../delivery-personnel/entities/delivery-personnel-profile.entity';
import { Customer } from '../customers/entities/customer.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { GeocodingService } from './geocoding.service';
import { DeliveryLedgerService } from './delivery-ledger.service';
import {
  CreateDeliveryDto,
  UpdateDeliveryDto,
  DeliveryStatusUpdateDto,
  DeliveryQueryDto,
  DeliveryIssueDto,
  CaptureSignatureDto,
  ConfirmDeliveryDto,
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

// Server-enforced status machine (phase3 Chunk 1): only these transitions
// are legal. Skipping ahead (e.g. pending → delivered) is rejected, and a
// replayed/double-tapped update of the current status is a no-op instead of
// writing duplicate history.
const LEGAL_TRANSITIONS: Record<string, DeliveryStatus[]> = {
  unassigned: ['pending', 'cancelled'],
  pending: ['picked_up', 'cancelled', 'failed'],
  picked_up: ['in_transit', 'cancelled', 'failed', 'returned'],
  in_transit: ['arrived', 'cancelled', 'failed', 'returned'],
  arrived: ['delivered', 'cancelled', 'failed', 'returned'],
  // Terminal states — nothing may leave them via the status endpoint.
  delivered: [],
  failed: [],
  returned: [],
  cancelled: [],
};

@Injectable()
export class DeliveriesService {
  constructor(
    @InjectRepository(Delivery) private readonly repo: Repository<Delivery>,
    @InjectRepository(DeliveryItem) private readonly itemRepo: Repository<DeliveryItem>,
    @InjectRepository(DeliveryStatusHistory) private readonly historyRepo: Repository<DeliveryStatusHistory>,
    @InjectRepository(DeliveryIssue) private readonly issueRepo: Repository<DeliveryIssue>,
    @InjectRepository(DeliverySignature) private readonly signatureRepo: Repository<DeliverySignature>,
    @InjectRepository(DeliveryLocationLog) private readonly locationLogRepo: Repository<DeliveryLocationLog>,
    @InjectRepository(DeliveryPersonnelProfile) private readonly personnelRepo: Repository<DeliveryPersonnelProfile>,
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
    private readonly dataSource: DataSource,
    private readonly notificationsService: NotificationsService,
    private readonly geocoding: GeocodingService,
    private readonly ledger: DeliveryLedgerService,
  ) {}

  /**
   * Resolve a customer's delivery address and geocode it (best-effort).
   * Runs outside any DB transaction since it performs a network call.
   */
  private async resolveDestination(
    companyId: string,
    customerId: string,
  ): Promise<{ address: string | null; destLat: number | null; destLng: number | null; geocodedAt: Date | null }> {
    const customer = await this.customerRepo.findOne({ where: { id: customerId, companyId } });
    const address = GeocodingService.formatAddress(
      customer?.shippingAddress ?? customer?.billingAddress ?? null,
    );
    if (!address) return { address: null, destLat: null, destLng: null, geocodedAt: null };
    const geo = await this.geocoding.geocode(address);
    if (geo) {
      return { address, destLat: geo.lat, destLng: geo.lng, geocodedAt: new Date() };
    }
    // Geocode failed (missing key / network / unresolvable address) — fall
    // back to the coordinates stored on the customer record, if any.
    if (customer?.shippingLat != null && customer?.shippingLng != null) {
      return {
        address,
        destLat: Number(customer.shippingLat),
        destLng: Number(customer.shippingLng),
        geocodedAt: customer.shippingGeocodedAt ?? new Date(),
      };
    }
    return { address, destLat: null, destLng: null, geocodedAt: null };
  }

  async list(companyId: string, query: DeliveryQueryDto, page: number, limit: number, user?: { id: string; role: string }) {
    const qb = this.repo.createQueryBuilder('d')
      .leftJoinAndSelect('d.items', 'items')
      .where('d.companyId = :cid', { cid: companyId });

    // Role-based filtering: delivery personnel only see their own
    if (user && (user.role === 'delivery' || user.role === 'delivery_personnel')) {
      qb.andWhere('d.personnelId = :uid', { uid: user.id });
    }

    if (query.status) qb.andWhere('d.status = :s', { s: query.status });
    if (query.personnelId) qb.andWhere('d.personnelId = :pid', { pid: query.personnelId });
    if (query.customerId) qb.andWhere('d.customerId = :cust', { cust: query.customerId });
    qb.orderBy('d.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [rawData, total] = await qb.getManyAndCount();

    const data = rawData.map(d => ({
      ...d,
      assignedTo: d.personnelId,
      scheduledDate: d.preferredDate,
    }));

    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const d = await this.repo.findOne({ where: { id, companyId }, relations: ['items'] });
    if (!d) throw new NotFoundException('Delivery not found');
    return d;
  }

  private generateRefNo(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `DEL-${ts}-${rand}`;
  }

  /**
   * Backfill destination coordinates for deliveries that don't have them
   * yet (created before geocoding existed, or while the key was missing).
   * Bounded per call to respect Geocoding API rate limits.
   */
  async geocodePending(companyId: string, limit = 25) {
    const pending = await this.repo.find({
      where: { companyId, destLat: IsNull() },
      take: limit,
      order: { createdAt: 'DESC' },
    });
    let updated = 0;
    for (const d of pending) {
      const dest = await this.resolveDestination(companyId, d.customerId);
      if (dest.destLat != null && dest.destLng != null) {
        d.address = dest.address;
        d.destLat = dest.destLat;
        d.destLng = dest.destLng;
        d.geocodedAt = dest.geocodedAt;
        await this.repo.save(d);
        updated++;
      }
    }
    return { scanned: pending.length, updated, geocodingConfigured: this.geocoding.isConfigured };
  }

  async create(companyId: string, dto: CreateDeliveryDto, userId: string) {
    // Resolve + geocode the destination before opening the DB transaction
    // (network call must not hold a transaction open). A manual override
    // from the dispatcher wins over automatic geocoding.
    const dest =
      dto.destLat != null && dto.destLng != null
        ? {
            address: dto.destAddress ?? null,
            destLat: dto.destLat,
            destLng: dto.destLng,
            geocodedAt: new Date(),
          }
        : await this.resolveDestination(companyId, dto.customerId);
    if (dto.destAddress && !dest.address) dest.address = dto.destAddress;

    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Delivery);
      const itemRepo = em.getRepository(DeliveryItem);
      const d = repo.create({
        companyId,
        customerId: dto.customerId,
        customerName: dto.customerName ?? null,
        zone: dto.zone ?? null,
        address: dest.address,
        destLat: dest.destLat,
        destLng: dest.destLng,
        geocodedAt: dest.geocodedAt,
        referenceNo: this.generateRefNo(),
        personnelId: dto.personnelId ?? null,
        status: dto.personnelId ? 'pending' : 'unassigned',
        priority: dto.priority ?? 'normal',
        preferredDate: dto.scheduledDate ?? dto.preferredDate ?? null,
        preferredTimeSlot: dto.preferredTimeSlot ?? null,
        notes: dto.notes ?? null,
        prepaid: dto.prePaid ?? false,
        createdBy: userId,
      });
      if (dto.personnelId) d.assignedAt = new Date();
      await repo.save(d);

      const items = dto.items.map((it) =>
        itemRepo.create({
          deliveryId: d.id,
          itemId: it.itemId,
          itemName: it.itemName ?? null,
          agencyId: it.agencyId ?? null,
          agencyName: it.agencyName ?? null,
          quantity: String(it.quantity ?? it.orderedQty ?? '0'),
          orderedQty: String(it.orderedQty ?? '0'),
          unitPrice: String(it.unitPrice ?? '0'),
          taxRate: String(it.taxRate ?? '0'),
          deliveredQty: '0',
          returnedQty: '0',
        }),
      );
      await itemRepo.save(items);

      // STAGE 1 (phase1.md): assigning at creation dispatches the stock —
      // Sales Order (or prepaid Invoice+Payment) + Dr Goods in Transit /
      // Cr Inventory, atomically with the delivery itself.
      let ledgerResult = null;
      if (dto.personnelId) {
        ledgerResult = await this.ledger.commitStockOnAssign(em, companyId, userId, d.id);
      }

      const fresh = await repo.findOne({ where: { id: d.id, companyId } });
      return {
        ...(fresh ?? d),
        assignedTo: d.personnelId,
        scheduledDate: d.preferredDate,
        items,
        ledger: ledgerResult,
      };
    });
  }

  async assignDeliveries(companyId: string, deliveryIds: string[], personnelId: string, userId: string) {
    // One transaction for the whole batch: either every delivery is assigned
    // AND its stock committed to Goods in Transit, or none is (e.g. one item
    // short on stock → the admin sees the error and nothing half-happens).
    const { deliveries, ledgerResults } = await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Delivery);
      const rows = await repo.find({
        where: deliveryIds.map((id) => ({ id, companyId })),
        relations: ['items'],
      });
      for (const d of rows) {
        d.personnelId = personnelId;
        if (d.status === 'unassigned' || d.status === 'pending') {
          d.status = 'pending';
          d.assignedAt = new Date();
        }
      }
      await repo.save(rows);

      // STAGE 1 (phase1.md): dispatch posts Dr Goods in Transit / Cr
      // Inventory and creates the Sales Order — atomic with the assignment.
      const results: Record<string, unknown> = {};
      for (const d of rows) {
        results[d.id] = await this.ledger.commitStockOnAssign(em, companyId, userId, d.id);
      }
      return { deliveries: rows, ledgerResults: results };
    });

    // Notify the delivery personnel for each newly assigned delivery
    for (const d of deliveries) {
      await this.notificationsService.create({
        companyId,
        userId: personnelId,
        type: 'delivery_assigned',
        title: 'New delivery assigned',
        message: `Delivery ${d.referenceNo} has been assigned to you.`,
        data: { deliveryId: d.id, referenceNo: d.referenceNo },
      });
    }

    return {
      deliveries: deliveries.map(d => ({
        ...d,
        assignedTo: d.personnelId,
        scheduledDate: d.preferredDate,
        ledger: ledgerResults[d.id] ?? null,
      })),
    };
  }

  async update(companyId: string, id: string, dto: UpdateDeliveryDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Delivery);
      const d = await repo.findOne({ where: { id, companyId }, relations: ['items'] });
      if (!d) throw new NotFoundException('Delivery not found');
      let newlyAssigned = false;
      if (dto.personnelId !== undefined && dto.personnelId !== d.personnelId) {
        d.personnelId = dto.personnelId;
        if (dto.personnelId && d.status === 'unassigned') {
          d.status = 'pending';
          d.assignedAt = new Date();
          newlyAssigned = true;
        }
      }
      const { destAddress, ...rest } = dto;
      Object.assign(d, rest);
      if (destAddress !== undefined) d.address = destAddress;
      if (dto.destLat != null && dto.destLng != null) d.geocodedAt = new Date();
      const saved = await repo.save(d);
      // STAGE 1 (phase1.md) when the edit is what assigns the rider.
      const ledger = newlyAssigned
        ? await this.ledger.commitStockOnAssign(em, companyId, userId, d.id)
        : null;
      return { ...saved, ledger };
    });
  }

  async autoAssign(companyId: string, id: string, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Delivery);
      const d = await repo.findOne({ where: { id, companyId } });
      if (!d) throw new NotFoundException('Delivery not found');
      if (d.status !== 'unassigned') throw new BadRequestException('Delivery already assigned');
      const personnel = await em.getRepository(DeliveryPersonnelProfile).find({
        where: { companyId, isAvailable: true, status: 'active' },
        order: { currentLoad: 'ASC' },
        take: 1,
      });
      if (!personnel.length) throw new BadRequestException('No available personnel');
      d.personnelId = personnel[0].userId;
      d.status = 'pending';
      d.assignedAt = new Date();
      const saved = await repo.save(d);
      // STAGE 1 (phase1.md): dispatch consequence of the auto-assignment.
      const ledger = await this.ledger.commitStockOnAssign(em, companyId, userId, d.id);
      return { ...saved, ledger };
    });
  }

  async updateStatus(
    companyId: string,
    id: string,
    dto: DeliveryStatusUpdateDto,
    userId: string,
    userRole?: string,
  ) {
    // Row lock so two concurrent updates (double-tap, retry after timeout)
    // serialize instead of both reading the same old status.
    return this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(Delivery);
      const d = await repo
        .createQueryBuilder('d')
        .setLock('pessimistic_write')
        .where('d.id = :id AND d.companyId = :cid', { id, cid: companyId })
        .getOne();
      if (!d) throw new NotFoundException('Delivery not found');

      // Riders may only update deliveries assigned to them.
      const isRider = userRole === 'delivery' || userRole === 'delivery_personnel';
      if (isRider && d.personnelId !== userId) {
        throw new ForbiddenException({
          code: 'NOT_YOUR_DELIVERY',
          message: 'This delivery is not assigned to you.',
        });
      }
      if (isRider && dto.status === 'cancelled') {
        throw new ForbiddenException({
          code: 'RIDER_CANNOT_CANCEL',
          message: 'Delivery personnel cannot cancel a delivery. Report an issue instead.',
        });
      }

      const oldStatus = d.status;

      // Idempotent replay: re-sending the current status is a no-op — the
      // retried request succeeds but nothing advances and no duplicate
      // history row is written.
      if (dto.status === oldStatus) {
        return { ...d, idempotentReplay: true };
      }

      const allowed = LEGAL_TRANSITIONS[oldStatus] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException({
          code: 'ILLEGAL_STATUS_TRANSITION',
          message: `Cannot move a delivery from '${oldStatus}' to '${dto.status}'.`,
          from: oldStatus,
          to: dto.status,
          allowed,
        });
      }

      d.status = dto.status;
      if (dto.status === 'cancelled') d.cancelReason = dto.notes ?? 'Cancelled by user';
      if (dto.status === 'delivered') d.completedAt = new Date();
      await repo.save(d);

      const historyRepo = em.getRepository(DeliveryStatusHistory);
      await historyRepo.save(
        historyRepo.create({
          deliveryId: id,
          status: dto.status,
          notes: dto.notes ?? null,
          location: dto.location ?? null,
          changedBy: userId,
        }),
      );
      return d;
    });
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
      reportedAt: new Date(),
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

  async myDashboard(companyId: string, personnelId: string) {
    const today = new Date().toISOString().split('T')[0];
    const all = await this.repo.find({
      where: { companyId, personnelId },
    });
    const todayDeliveries = all.filter(
      (d) => d.createdAt && d.createdAt.toISOString().split('T')[0] === today,
    );
    const assigned = todayDeliveries.length;
    const completed = todayDeliveries.filter((d) => d.status === 'delivered').length;
    const inTransit = todayDeliveries.filter((d) => d.status === 'in_transit').length;
    const remaining = assigned - completed;
    const progress = assigned > 0 ? Math.round((completed / assigned) * 100) : 0;
    const nextDelivery = all.find((d) =>
      ['pending', 'picked_up', 'in_transit', 'arrived'].includes(d.status),
    );
    return {
      today: { assigned, completed, inTransit, remaining, progress },
      nextDelivery: nextDelivery ?? null,
    };
  }

  async captureSignature(companyId: string, deliveryId: string, dto: CaptureSignatureDto) {
    const d = await this.getById(companyId, deliveryId);
    const sig = this.signatureRepo.create({
      deliveryId: d.id,
      imageUrl: dto.signatureImage,
      signerName: dto.signerName ?? null,
      capturedAt: new Date(),
    });
    await this.signatureRepo.save(sig);
    return { deliveryId: d.id, signature: sig };
  }

  async confirmDelivery(
    companyId: string,
    deliveryId: string,
    dto: ConfirmDeliveryDto,
    userId: string,
    userRole?: string,
  ) {
    const d = await this.getById(companyId, deliveryId);
    const isRider = userRole === 'delivery' || userRole === 'delivery_personnel';
    if (isRider && d.personnelId !== userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_DELIVERY',
        message: 'This delivery is not assigned to you.',
      });
    }
    // STAGE 2 (phase1.md): the rider's PAID / NOT PAID flag. It posts NOTHING
    // — it only rides into the admin approval queue and decides whether the
    // Stage-3 revenue entry debits Cash or Accounts Receivable.
    if (dto.paidStatus && d.paidStatus !== dto.paidStatus) {
      d.paidStatus = dto.paidStatus;
      await this.repo.save(d);
    }

    // Idempotent replay: confirming an already-delivered delivery succeeds
    // without changing anything (a retried/double-tapped confirm must not
    // error or double-advance).
    if (d.status === 'delivered') {
      return { deliveryId: d.id, status: 'delivered', completedAt: d.completedAt };
    }
    // Allow completion from any active (non-terminal) status. A courier may mark
    // a delivery received without explicitly stepping through every milestone.
    const TERMINAL = ['failed', 'returned', 'cancelled'];
    if (TERMINAL.includes(d.status)) {
      throw new BadRequestException(`Delivery is already ${d.status}`);
    }

    // Update delivered/returned quantities. When the client didn't send a
    // per-item breakdown (simple "customer confirmed receipt"), default every
    // line to fully delivered.
    if (dto.deliveredItems && dto.deliveredItems.length) {
      for (const item of dto.deliveredItems) {
        await this.itemRepo.update(
          { deliveryId: d.id, itemId: item.itemId },
          { deliveredQty: item.deliveredQty, returnedQty: item.returnedQty ?? '0' },
        );
      }
    } else {
      const items = await this.itemRepo.find({ where: { deliveryId: d.id } });
      for (const item of items) {
        item.deliveredQty = item.orderedQty;
        item.returnedQty = '0';
      }
      if (items.length) await this.itemRepo.save(items);
    }

    // Update status to delivered
    d.status = 'delivered';
    d.completedAt = new Date();
    await this.repo.save(d);

    // Record status history
    const history = this.historyRepo.create({
      deliveryId,
      status: 'delivered',
      notes: dto.notes ?? 'Customer confirmed receipt',
      changedBy: userId,
    });
    await this.historyRepo.save(history);

    return { deliveryId: d.id, status: 'delivered', completedAt: d.completedAt };
  }

  async myHistory(companyId: string, personnelId: string, page: number, limit: number) {
    const qb = this.repo.createQueryBuilder('d')
      .where('d.companyId = :cid AND d.personnelId = :pid', { cid: companyId, pid: personnelId })
      .andWhere('d.status IN (:...statuses)', { statuses: ['delivered', 'failed', 'returned', 'cancelled'] })
      .orderBy('d.completedAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getLocationHistory(companyId: string, deliveryId: string) {
    // Verify delivery belongs to company
    await this.getById(companyId, deliveryId);
    const points = await this.locationLogRepo.find({
      where: { deliveryId },
      order: { createdAt: 'ASC' },
      select: ['lat', 'lng', 'heading', 'speed', 'status', 'createdAt'],
    });
    return {
      deliveryId,
      points: points.map(p => ({
        lat: p.lat,
        lng: p.lng,
        heading: p.heading,
        speed: p.speed,
        status: p.status,
        timestamp: p.createdAt,
      })),
    };
  }

  async getMapData(companyId: string) {
    const now = Date.now();
    const ONLINE_THRESHOLD = 2 * 60 * 1000;

    // All active (non-terminal) deliveries
    const activeDeliveries = await this.repo
      .createQueryBuilder('d')
      .where('d.companyId = :cid', { cid: companyId })
      .andWhere('d.status IN (:...statuses)', {
        statuses: ['pending', 'picked_up', 'in_transit', 'arrived'],
      })
      .leftJoinAndSelect('d.items', 'items')
      .orderBy('d.createdAt', 'DESC')
      .getMany();

    // All personnel with location data
    const allPersonnel = await this.personnelRepo.find({ where: { companyId } });

    const personnelMap = new Map(allPersonnel.map(p => [p.userId, p]));

    // Build markers — one per active delivery that has a located DP
    const markers = activeDeliveries.map(d => {
      const personnel = d.personnelId ? personnelMap.get(d.personnelId) : undefined;
      return {
        deliveryId: d.id,
        status: d.status,
        priority: d.priority,
        customerId: d.customerId,
        customerName: d.customerName ?? null,
        personnelId: d.personnelId ?? null,
        itemCount: d.items?.length ?? 0,
        assignedAt: d.assignedAt,
        createdAt: d.createdAt,
        address: d.address ?? null,
        destination:
          d.destLat != null && d.destLng != null
            ? { lat: d.destLat, lng: d.destLng, address: d.address ?? null }
            : null,
        personnel: personnel
          ? {
              vehicleType: personnel.vehicleType,
              rating: personnel.rating,
              isAvailable: personnel.isAvailable,
              lat: personnel.currentLat ? parseFloat(personnel.currentLat) : null,
              lng: personnel.currentLng ? parseFloat(personnel.currentLng) : null,
              heading: personnel.heading,
              speed: personnel.speed,
              accuracy: personnel.accuracy,
              locationUpdatedAt: personnel.locationUpdatedAt,
              isOnline:
                !!personnel.locationUpdatedAt &&
                now - personnel.locationUpdatedAt.getTime() < ONLINE_THRESHOLD,
            }
          : null,
      };
    });

    // Summary stats
    const allForSummary = await this.repo.find({ where: { companyId } });
    const summary = {
      total: allForSummary.length,
      pending: allForSummary.filter(d => d.status === 'pending').length,
      inTransit: allForSummary.filter(d => ['picked_up', 'in_transit', 'arrived'].includes(d.status)).length,
      delivered: allForSummary.filter(d => d.status === 'delivered').length,
      failed: allForSummary.filter(d => d.status === 'failed').length,
      unassigned: allForSummary.filter(d => d.status === 'unassigned').length,
    };

    const locatedPersonnel = allPersonnel.filter(p => p.currentLat !== null).length;

    return { markers, summary, locatedPersonnel };
  }
}
