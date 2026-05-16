import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { InventoryUpdateRequest } from './entities/inventory-update-request.entity';
import { InventoryUpdateRequestLine } from './entities/inventory-update-request-line.entity';
import { InventoryApprovalAuditEntry } from './entities/inventory-approval-audit-entry.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { ShadowInventorySnapshot } from '../shadow-inventory/entities/shadow-inventory-snapshot.entity';
import { User } from '../users/entities/user.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService, StoredFile } from '../../common/storage/storage.service';
import {
  ApproveInventoryUpdateRequestDto,
  BillPhotoChangeDto,
  CreateInventoryUpdateRequestDto,
  RejectInventoryUpdateRequestDto,
  ReviewRequestDto,
  SubmitBillPhotoDto,
} from './dto/inventory-approval.dto';
import { toDecimal } from '../../common/utils/money.util';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

type RequestStatus = 'pending' | 'approved' | 'rejected' | 'all';

@Injectable()
export class InventoryApprovalsService {
  constructor(
    @InjectRepository(InventoryUpdateRequest)
    private readonly reqRepo: Repository<InventoryUpdateRequest>,
    @InjectRepository(InventoryUpdateRequestLine)
    private readonly lineRepo: Repository<InventoryUpdateRequestLine>,
    @InjectRepository(InventoryApprovalAuditEntry)
    private readonly auditRepo: Repository<InventoryApprovalAuditEntry>,
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserCompany)
    private readonly userCompanyRepo: Repository<UserCompany>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  // ==========================================================================
  //  Legacy: kept to preserve existing /inventory-approvals controller
  // ==========================================================================

  async list(companyId: string, status: string | undefined, page: number, limit: number) {
    const qb = this.reqRepo
      .createQueryBuilder('r')
      .leftJoinAndMapMany('r.lines', InventoryUpdateRequestLine, 'l', 'l.request_id = r.id')
      .where('r.companyId = :cid', { cid: companyId });
    if (status) qb.andWhere('r.status = :s', { s: status });
    qb.orderBy('r.submittedAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return rows.map((r) => this.formatRequest(r));
  }

  async getById(companyId: string, id: string) {
    const req = await this.reqRepo.findOne({
      where: { id, companyId },
      relations: ['lines'],
    });
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
        shadowStatus: 'pending',
        proofVerificationMethod: 'manual',
        submittedAt: new Date(),
      });
      await reqRepo.save(req);

      const lines: InventoryUpdateRequestLine[] = [];
      for (const l of dto.lines) {
        const item = await itemRepo.findOne({ where: { id: l.itemId, companyId } });
        const beforeQty = item ? item.quantityOnHand : '0';
        const delivered = toDecimal(l.deliveredQty);
        const returned = toDecimal(l.returnedQty ?? '0');
        const afterQty = toDecimal(beforeQty).plus(delivered).minus(returned);

        const line = lineRepo.create({
          requestId: req.id,
          itemId: l.itemId,
          itemName: item?.name ?? null,
          beforeQty,
          deliveredQty: delivered.toFixed(4),
          returnedQty: returned.toFixed(4),
          afterQty: afterQty.toFixed(4),
        });
        lines.push(await lineRepo.save(line));
      }
      return { ...req, lines };
    });
  }

  async review(
    companyId: string,
    id: string,
    dto: ReviewRequestDto,
    reviewerId: string,
  ) {
    if (dto.action === 'approved') {
      return this.approve(companyId, id, { reviewerComment: dto.notes }, reviewerId);
    }
    return this.reject(
      companyId,
      id,
      { reviewerComment: dto.notes ?? 'Rejected' },
      reviewerId,
    );
  }

  // ==========================================================================
  //  Bill-photo submission (DP)
  // ==========================================================================

  async submitBillPhoto(
    companyId: string,
    deliveryId: string,
    callerUserId: string,
    callerName: string,
    file: Express.Multer.File,
    body: SubmitBillPhotoDto,
  ) {
    // 1) Parse + validate the changes JSON BEFORE we hit the DB.
    const changes = await this.parseAndValidateChanges(body.changes);

    // Resolve the user's display name (JWT only carries email)
    const callerUser = await this.userRepo.findOne({ where: { id: callerUserId } });
    const resolvedName = callerUser?.displayName ?? callerName;

    return this.dataSource.transaction(async (em) => {
      const deliveryRepo = em.getRepository(Delivery);
      const reqRepo = em.getRepository(InventoryUpdateRequest);
      const lineRepo = em.getRepository(InventoryUpdateRequestLine);
      const itemRepo = em.getRepository(InventoryItem);

      // 2) Validate delivery + assignment + status
      const delivery = await deliveryRepo.findOne({
        where: { id: deliveryId, companyId },
      });
      if (!delivery) throw new NotFoundException('Delivery not found');
      if (delivery.personnelId !== callerUserId) {
        throw new ForbiddenException('Delivery is not assigned to you');
      }
      if (!['arrived', 'in_transit'].includes(delivery.status as string)) {
        throw new BadRequestException(
          `Delivery must be in 'arrived' or 'in_transit' status (got '${delivery.status}')`,
        );
      }

      // 3) Reject duplicate request
      const existing = await reqRepo
        .createQueryBuilder('r')
        .where('r.companyId = :cid AND r.deliveryId = :did', {
          cid: companyId,
          did: deliveryId,
        })
        .andWhere("r.status IN ('pending','approved')")
        .getOne();
      if (existing) {
        throw new ConflictException(
          'An inventory update request already exists for this delivery',
        );
      }

      // 4) Validate change shapes against current inventory (don't trust client beforeQty)
      for (const c of changes) {
        if (c.deliveredQty + c.returnedQty > c.beforeQty) {
          throw new BadRequestException(
            `Item ${c.itemName}: delivered + returned exceeds beforeQty`,
          );
        }
      }

      const now = new Date();

      // 5) Persist the request shell first so we know its id (used in the storage URL)
      const req = reqRepo.create({
        companyId,
        deliveryId,
        personnelId: callerUserId,
        personnelName: body.personnelName ?? resolvedName,
        deliveryReference: body.deliveryReference ?? delivery.referenceNo ?? `DEL-${deliveryId.slice(0, 8).toUpperCase()}`,
        routeLabel: body.routeLabel ?? this.formatRouteLabel(delivery),
        status: 'pending',
        shadowStatus: 'pending',
        submittedAt: now,
        proofSignedBy: body.signedBy,
        proofVerificationMethod: 'bill_photo',
        proofVerifiedBy: resolvedName,
        proofVerifiedAt: now,
        approvalNotes: body.note ?? null,
      });
      await reqRepo.save(req);

      // 6) Upload the bill photo to storage
      const stored = await this.storage.putBuffer({
        bucket: 'bill-photos',
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname || 'bill.jpg',
        publicPath: `/inventory-update-requests/${req.id}/bill-photo`,
      });

      // 7) Update delivery columns + request proof block with photo info
      delivery.billPhotoUrl = stored.url;
      delivery.billPhotoStorageKey = stored.key;
      delivery.billPhotoCapturedAt = now;
      delivery.billSignedBy = body.signedBy;
      await deliveryRepo.save(delivery);

      req.proofBillPhotoUrl = stored.url;
      req.proofBillPhotoStorageKey = stored.key;
      req.proofBillPhotoCapturedAt = now;
      await reqRepo.save(req);

      // 8) Insert change rows (use server-recomputed beforeQty)
      const items = await itemRepo.find({
        where: { companyId, id: In(changes.map((c) => c.itemId)) },
      });
      const itemById = new Map(items.map((i) => [i.id, i]));

      for (const c of changes) {
        const item = itemById.get(c.itemId);
        const serverBeforeQty = item ? Number(item.quantityOnHand) : c.beforeQty;
        const afterQty = serverBeforeQty - c.deliveredQty + c.returnedQty;

        await lineRepo.save(
          lineRepo.create({
            requestId: req.id,
            itemId: c.itemId,
            itemName: item?.name ?? c.itemName,
            beforeQty: String(serverBeforeQty),
            deliveredQty: String(c.deliveredQty),
            returnedQty: String(c.returnedQty),
            afterQty: String(afterQty),
          }),
        );
      }

      // 9) Upsert shadow_inventory for each change item
      const shadowRepo = em.getRepository(ShadowInventorySnapshot);
      for (const c of changes) {
        let shadow = await shadowRepo.findOne({
          where: { companyId, personnelId: callerUserId, itemId: c.itemId },
        });
        if (shadow) {
          shadow.currentQty = String(Number(shadow.currentQty) - c.deliveredQty + c.returnedQty);
          shadow.lastSyncAt = now;
          shadow.syncStatus = 'pending';
        } else {
          const item = itemById.get(c.itemId);
          shadow = shadowRepo.create({
            companyId,
            personnelId: callerUserId,
            itemId: c.itemId,
            itemName: item?.name ?? c.itemName,
            originalQty: String(c.beforeQty),
            currentQty: String(c.beforeQty - c.deliveredQty + c.returnedQty),
            lastSyncAt: now,
            syncStatus: 'pending',
          });
        }
        await shadowRepo.save(shadow);
      }

      // 10) Notify admins (best-effort)
      void this.notifyAdmins(companyId, {
        type: 'inventory_approvals',
        title: 'Bill photo received — review needed',
        message: `${resolvedName} submitted a signed bill for ${req.deliveryReference}. Review and approve to update inventory.`,
        data: { requestId: req.id, route: 'InventoryApproval' },
      });

      return {
        requestId: req.id,
        deliveryId,
        photoUrl: stored.url,
        uploadedAt: now.toISOString(),
      };
    });
  }

  // ==========================================================================
  //  Modern admin endpoints
  // ==========================================================================

  async listFormatted(
    companyId: string,
    status: RequestStatus | undefined,
    page: number,
    pageSize: number,
  ) {
    const qb = this.reqRepo
      .createQueryBuilder('r')
      .leftJoinAndMapMany(
        'r.lines',
        InventoryUpdateRequestLine,
        'l',
        'l.request_id = r.id',
      )
      .where('r.companyId = :cid', { cid: companyId });
    if (status && status !== 'all') {
      qb.andWhere('r.status = :s', { s: status });
    }
    qb.orderBy('r.submittedAt', 'DESC');
    qb.skip((page - 1) * pageSize).take(pageSize);
    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => this.formatRequest(r)),
      total,
      page,
      pageSize,
    };
  }

  async getOneFormatted(companyId: string, id: string, userId: string, role: string) {
    const req = await this.reqRepo.findOne({
      where: { id, companyId },
      relations: ['lines'],
    });
    if (!req) throw new NotFoundException('Request not found');
    if (role === 'delivery' && req.personnelId !== userId) {
      throw new ForbiddenException('Not your request');
    }
    return this.formatRequest(req);
  }

  async approve(
    companyId: string,
    id: string,
    dto: ApproveInventoryUpdateRequestDto,
    reviewerId: string,
  ) {
    return this.dataSource.transaction(async (em) => {
      const reqRepo = em.getRepository(InventoryUpdateRequest);
      const itemRepo = em.getRepository(InventoryItem);
      const moveRepo = em.getRepository(InventoryMovement);
      const auditRepo = em.getRepository(InventoryApprovalAuditEntry);
      const shadowRepo = em.getRepository(ShadowInventorySnapshot);

      const req = await reqRepo.findOne({
        where: { id, companyId },
        relations: ['lines'],
      });
      if (!req) throw new NotFoundException('Request not found');
      if (req.status !== 'pending') {
        throw new ConflictException(
          `Request is already ${req.status}; cannot approve`,
        );
      }

      // Apply each line with row-locking + negative-stock guard
      for (const line of req.lines) {
        const item = await itemRepo
          .createQueryBuilder('i')
          .setLock('pessimistic_write')
          .where('i.id = :id AND i.companyId = :cid', {
            id: line.itemId,
            cid: companyId,
          })
          .getOne();
        if (!item) {
          throw new NotFoundException(`Inventory item ${line.itemId} not found`);
        }

        const before = Number(item.quantityOnHand);
        const delivered = Number(line.deliveredQty);
        const returned = Number(line.returnedQty);
        const next = before - delivered + returned;

        if (next < 0) {
          throw new UnprocessableEntityException({
            code: 'NEGATIVE_STOCK',
            message: `Approving would drive ${item.name} below zero (current ${before}, delivered ${delivered}, returned ${returned}).`,
          });
        }

        item.quantityOnHand = String(next);
        await itemRepo.save(item);
        line.afterQty = String(next);

        await moveRepo.save(
          moveRepo.create({
            companyId,
            itemId: line.itemId,
            date: new Date().toISOString().split('T')[0],
            type: 'delivery',
            quantityChange: String(returned - delivered),
            balanceAfter: String(next),
            reference: `Approval ${req.id}`,
            sourceType: 'inventory_approval',
            sourceId: req.id,
            createdBy: reviewerId,
            description: `delivery_approved: ${req.deliveryReference ?? req.deliveryId}`,
          }),
        );
      }

      // Zero-out / delete shadow inventory entries for approved items
      if (req.lines.length > 0) {
        await shadowRepo
          .createQueryBuilder()
          .update()
          .set({ currentQty: '0', syncStatus: 'synced', lastSyncAt: new Date() })
          .where('company_id = :cid AND personnel_id = :pid AND item_id IN (:...itemIds)', {
            cid: companyId,
            pid: req.personnelId,
            itemIds: req.lines.map((l) => l.itemId),
          })
          .execute();
      }

      // Set delivery status to 'delivered' if not already
      const deliveryRepo = em.getRepository(Delivery);
      const delivery = await deliveryRepo.findOne({ where: { id: req.deliveryId, companyId } });
      if (delivery && delivery.status !== 'delivered') {
        delivery.status = 'delivered';
        delivery.completedAt = new Date();
        await deliveryRepo.save(delivery);
      }

      const now = new Date();
      req.status = 'approved';
      req.shadowStatus = 'synced';
      req.reviewedAt = now;
      req.reviewedBy = reviewerId;
      req.reviewerComment = dto.reviewerComment ?? null;
      req.approvalNotes = dto.reviewerComment ?? null;
      await reqRepo.save(req);

      await auditRepo.save(
        auditRepo.create({
          companyId,
          requestId: req.id,
          action: 'approved',
          reviewedBy: reviewerId,
          details: dto.reviewerComment ?? `Approved ${req.lines.length} item changes`,
        }),
      );

      // Notify the DP (best-effort)
      void this.notifications.create({
        companyId,
        userId: req.personnelId,
        type: 'approval_results',
        title: 'Inventory request approved',
        message: `${req.deliveryReference ?? 'Your delivery'} inventory changes were approved and synced.`,
        data: { requestId: req.id, route: 'DPHistory' },
      });

      return this.formatRequest(req);
    });
  }

  async reject(
    companyId: string,
    id: string,
    dto: RejectInventoryUpdateRequestDto,
    reviewerId: string,
  ) {
    return this.dataSource.transaction(async (em) => {
      const reqRepo = em.getRepository(InventoryUpdateRequest);
      const auditRepo = em.getRepository(InventoryApprovalAuditEntry);
      const shadowRepo = em.getRepository(ShadowInventorySnapshot);

      const req = await reqRepo.findOne({
        where: { id, companyId },
        relations: ['lines'],
      });
      if (!req) throw new NotFoundException('Request not found');
      if (req.status !== 'pending') {
        throw new ConflictException(
          `Request is already ${req.status}; cannot reject`,
        );
      }

      const now = new Date();
      req.status = 'rejected';
      req.shadowStatus = 'rejected';
      req.reviewedAt = now;
      req.reviewedBy = reviewerId;
      req.reviewerComment = dto.reviewerComment;
      req.rejectReason = dto.reviewerComment;
      await reqRepo.save(req);

      // Revert shadow_inventory: undo the qty changes from submitBillPhoto
      if (req.lines.length > 0) {
        for (const line of req.lines) {
          const shadow = await shadowRepo.findOne({
            where: { companyId, personnelId: req.personnelId, itemId: line.itemId },
          });
          if (shadow) {
            shadow.currentQty = String(
              Number(shadow.currentQty) + Number(line.deliveredQty) - Number(line.returnedQty),
            );
            shadow.syncStatus = 'rejected' as never;
            shadow.lastSyncAt = now;
            await shadowRepo.save(shadow);
          }
        }
      }

      await auditRepo.save(
        auditRepo.create({
          companyId,
          requestId: req.id,
          action: 'rejected',
          reviewedBy: reviewerId,
          details: dto.reviewerComment,
        }),
      );

      void this.notifications.create({
        companyId,
        userId: req.personnelId,
        type: 'approval_results',
        title: 'Inventory request rejected',
        message: `${req.deliveryReference ?? 'Your delivery'} inventory changes were rejected. ${dto.reviewerComment}`,
        data: { requestId: req.id, route: 'DPHistory' },
      });

      return this.formatRequest(req);
    });
  }

  async streamBillPhoto(companyId: string, requestId: string) {
    const req = await this.reqRepo.findOne({
      where: { id: requestId, companyId },
    });
    if (!req || !req.proofBillPhotoStorageKey) {
      throw new NotFoundException('Bill photo not found');
    }
    const file = await this.storage.read(req.proofBillPhotoStorageKey);
    if (!file) throw new NotFoundException('Bill photo missing on storage');
    return file;
  }

  // ==========================================================================
  //  Helpers
  // ==========================================================================

  private async parseAndValidateChanges(
    raw: string,
  ): Promise<BillPhotoChangeDto[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('changes must be a JSON-stringified array');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new BadRequestException('changes must be a non-empty array');
    }
    const dtos = plainToInstance(BillPhotoChangeDto, parsed);
    for (const d of dtos) {
      const errs = await validate(d);
      if (errs.length > 0) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Invalid change entry',
          details: errs.map((e) => ({
            field: e.property,
            constraints: e.constraints,
          })),
        });
      }
    }
    return dtos;
  }

  private async notifyAdmins(
    companyId: string,
    payload: {
      type: string;
      title: string;
      message: string;
      data?: Record<string, unknown>;
    },
  ) {
    try {
      const admins = await this.userCompanyRepo.find({
        where: { companyId, role: 'admin' as never },
      });
      await Promise.all(
        admins.map((a) =>
          this.notifications.create({
            companyId,
            userId: a.userId,
            type: payload.type,
            title: payload.title,
            message: payload.message,
            data: payload.data,
          }),
        ),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[notifyAdmins] failed:', err);
    }
  }

  private formatRouteLabel(d: Delivery): string {
    if (d.preferredDate) return `Route · ${d.preferredDate}`;
    return `Route · ${new Date().toISOString().split('T')[0]}`;
  }

  private formatRequest(r: InventoryUpdateRequest) {
    return {
      id: r.id,
      deliveryId: r.deliveryId,
      deliveryReference: r.deliveryReference,
      personnelId: r.personnelId,
      personnelName: r.personnelName,
      routeLabel: r.routeLabel,
      submittedAt: r.submittedAt,
      status: r.status,
      shadowStatus: r.shadowStatus,
      reviewedAt: r.reviewedAt,
      reviewedBy: r.reviewedBy,
      reviewerComment: r.reviewerComment ?? r.approvalNotes ?? r.rejectReason ?? null,
      changes: (r.lines ?? []).map((l) => ({
        itemId: l.itemId,
        itemName: l.itemName,
        beforeQty: Number(l.beforeQty),
        deliveredQty: Number(l.deliveredQty),
        returnedQty: Number(l.returnedQty),
      })),
      proof: {
        signedBy: r.proofSignedBy,
        billPhotoUri: r.proofBillPhotoUrl,
        note: r.approvalNotes ?? null,
      },
    };
  }
}
