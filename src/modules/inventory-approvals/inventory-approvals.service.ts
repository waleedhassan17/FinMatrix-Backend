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
import { DeliveryItem } from '../deliveries/entities/delivery-item.entity';
import { DeliveryLedgerService } from '../deliveries/delivery-ledger.service';
import { ShadowInventorySnapshot } from '../shadow-inventory/entities/shadow-inventory-snapshot.entity';
import { User } from '../users/entities/user.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { ACCT_COGS, ACCT_INVENTORY } from '../accounts/accounts.constants';
import { JournalEntry } from '../journal-entries/entities/journal-entry.entity';
import { JournalEntryLine } from '../journal-entries/entities/journal-entry-line.entity';
import { StorageService, StoredFile } from '../../common/storage/storage.service';
import {
  ApproveInventoryUpdateRequestDto,
  BillPhotoChangeDto,
  CreateInventoryUpdateRequestDto,
  RejectInventoryUpdateRequestDto,
  ReviewRequestDto,
  SubmitBillPhotoDto,
} from './dto/inventory-approval.dto';
import { toDecimal, MONEY_TOLERANCE } from '../../common/utils/money.util';
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
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly deliveryLedger: DeliveryLedgerService,
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
    return this.enrichWithDelivery(companyId, rows.map((r) => this.formatRequest(r)));
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
      if (['delivered', 'cancelled'].includes(delivery.status as string)) {
        throw new BadRequestException(
          `Cannot submit bill photo for a delivery in '${delivery.status}' status`,
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

      // 4) Validate the rider's counts against SERVER data. For deliveries
      // whose stock was committed to Goods in Transit at assignment, the
      // bound is the DISPATCHED quantity on the delivery line (the goods are
      // already off the shelf, so warehouse on-hand — the old beforeQty
      // check — is irrelevant and would wrongly block an exact-stock
      // dispatch). Legacy pre-GIT deliveries keep the beforeQty bound.
      if (delivery.stockCommittedAt) {
        const deliveryLines = await em.getRepository(DeliveryItem).find({
          where: { deliveryId: delivery.id },
        });
        const dispatchedByItem = new Map(
          deliveryLines.map((l) => [l.itemId, Number(l.orderedQty) || Number(l.quantity) || 0]),
        );
        for (const c of changes) {
          const dispatched = dispatchedByItem.get(c.itemId) ?? 0;
          if (c.deliveredQty + c.returnedQty > dispatched) {
            throw new BadRequestException(
              `Item ${c.itemName}: delivered + returned (${c.deliveredQty + c.returnedQty}) exceeds the ${dispatched} dispatched with this delivery`,
            );
          }
        }
      } else {
        for (const c of changes) {
          if (c.deliveredQty + c.returnedQty > c.beforeQty) {
            throw new BadRequestException(
              `Item ${c.itemName}: delivered + returned exceeds beforeQty`,
            );
          }
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

      // 7) Update delivery columns + request proof block with photo info.
      // STAGE 2 (phase1.md): record the rider's PAID / NOT PAID choice. This
      // posts NOTHING — it rides into the admin approval queue and decides
      // whether Stage 3 debits Cash or Accounts Receivable.
      delivery.paidStatus = body.paidStatus ?? delivery.paidStatus ?? 'unpaid';
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
      items: await this.enrichWithDelivery(
        companyId,
        rows.map((r) => this.formatRequest(r)),
      ),
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
    const [enriched] = await this.enrichWithDelivery(companyId, [this.formatRequest(req)]);
    return enriched;
  }

  async approve(
    companyId: string,
    id: string,
    dto: ApproveInventoryUpdateRequestDto,
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
          `Request is already ${req.status}; cannot approve`,
        );
      }

      // STAGE 3 (phase1.md) — deliveries dispatched under the Goods-in-Transit
      // flow: on-hand already fell at assignment, so approval must NOT touch
      // it again. Instead: SO → Invoice (Cash or A/R per the rider's flag),
      // Dr COGS / Cr Goods in Transit for the delivered part and
      // Dr Inventory / Cr Goods in Transit (+restock) for the rest — all
      // through DeliveryLedgerService in THIS transaction.
      const approvalDelivery = await em.getRepository(Delivery).findOne({
        where: { id: req.deliveryId, companyId },
      });
      let ledgerResult: import('../deliveries/delivery-ledger.service').ApprovalLedgerResult | null =
        null;
      let journalEntryId: string | null = null;

      if (approvalDelivery?.stockCommittedAt) {
        const deliveredByItem = new Map<string, string>();
        for (const line of req.lines) {
          deliveredByItem.set(line.itemId, String(line.deliveredQty));
        }
        ledgerResult = await this.deliveryLedger.commitApproval(
          em,
          companyId,
          reviewerId,
          req.deliveryId,
          deliveredByItem,
        );
        journalEntryId = ledgerResult.cogsJournalEntryId;
      } else {
        // Legacy path (delivery predates the Goods-in-Transit flow): apply
        // each line with row-locking + negative-stock guard and post
        // Dr COGS / Cr Inventory as before.
        journalEntryId = await this.applyLegacyApproval(em, companyId, req, reviewerId);
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
      req.journalEntryId = journalEntryId;
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
          details:
            dto.reviewerComment ??
            (ledgerResult
              ? `Approved (${ledgerResult.paidStatus.toUpperCase()}) — invoice ${ledgerResult.invoiceNumber ?? 'n/a'}, COGS ${ledgerResult.cogsAmount}`
              : `Approved ${req.lines.length} item changes`),
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

      return { ...this.formatRequest(req), ledger: ledgerResult };
    });
  }

  /**
   * Pre-Goods-in-Transit approval: reduce on-hand at approval and post
   * Dr COGS / Cr Inventory (chunk 2 behaviour), unchanged for old deliveries.
   * Returns the journal entry id (or null when the net cost is ~0).
   */
  private async applyLegacyApproval(
    em: import('typeorm').EntityManager,
    companyId: string,
    req: InventoryUpdateRequest,
    reviewerId: string,
  ): Promise<string | null> {
    const itemRepo = em.getRepository(InventoryItem);
    const moveRepo = em.getRepository(InventoryMovement);

    let netCost = toDecimal(0);
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
        netCost = netCost.plus(
          toDecimal(delivered - returned).times(toDecimal(item.unitCost)),
        );

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

      // Ledger commit (chunk 2): goods dispatched to the customer leave stock,
      // so the GL must move with the quantity — Dr COGS / Cr Inventory at the
      // item's (weighted-average) unit cost. A net return (returned >
      // delivered) posts the mirror entry. Without this, Inventory Valuation
      // and the Balance Sheet Inventory line diverge. Same transaction as the
      // quantity change, so both commit or neither does.
      let journalEntryId: string | null = null;
      if (netCost.abs().greaterThan(MONEY_TOLERANCE)) {
        const inventoryAcct = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, em);
        const cogsAcct = await this.accounts.getByNumberOrFail(companyId, ACCT_COGS, em);
        const value = netCost.abs().toFixed(4);
        const outbound = netCost.greaterThan(0);
        const entry = await this.posting.createEntry(em, {
          companyId,
          date: new Date().toISOString().split('T')[0],
          memo: `Delivery ${req.deliveryReference ?? req.deliveryId} approved — stock committed`,
          createdBy: reviewerId,
          status: 'posted',
          sourceType: 'delivery_approval',
          sourceId: req.id,
          lines: outbound
            ? [
                { accountId: cogsAcct.id, description: 'Cost of goods delivered', debit: value, credit: '0', lineOrder: 0 },
                { accountId: inventoryAcct.id, description: 'Inventory relieved on delivery', debit: '0', credit: value, lineOrder: 1 },
              ]
            : [
                { accountId: inventoryAcct.id, description: 'Inventory returned on delivery', debit: value, credit: '0', lineOrder: 0 },
                { accountId: cogsAcct.id, description: 'COGS reversed on returned goods', debit: '0', credit: value, lineOrder: 1 },
              ],
        });
        journalEntryId = entry.id;
      }

    return journalEntryId;
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

      // Reject/return path (phase1.md Stage 3): for a delivery dispatched
      // under the Goods-in-Transit flow, reverse Stage 1 — Dr Inventory /
      // Cr Goods in Transit at the frozen cost, restock everything. NO
      // revenue reverses (nothing was sold). Same transaction as the request
      // status change. Legacy deliveries never touched stock, so no-op.
      const rejectDelivery = await em.getRepository(Delivery).findOne({
        where: { id: req.deliveryId, companyId },
      });
      let ledgerReversal: { reversed: boolean; journalEntryId: string | null; restockedCost: string } | null =
        null;
      if (rejectDelivery?.stockCommittedAt) {
        ledgerReversal = await this.deliveryLedger.releaseOnReject(
          em,
          companyId,
          reviewerId,
          req.deliveryId,
        );
        if (rejectDelivery.status !== 'returned') {
          rejectDelivery.status = 'returned';
          rejectDelivery.completedAt = new Date();
          await em.getRepository(Delivery).save(rejectDelivery);
        }
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

      return { ...this.formatRequest(req), ledger: ledgerReversal };
    });
  }

  /**
   * POST /inventory-update-requests/:id/undo
   * Reverses an already-approved request:
   *  - Adds back the delivered qty (undo the deduction)
   *  - Subtracts the returned qty (undo the addition)
   *  - Sets status to 'rejected'
   *  - Creates an audit entry
   */
  async undoApproval(companyId: string, id: string, reviewerId: string) {
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
      if (req.status !== 'approved') {
        throw new ConflictException(
          `Only approved requests can be undone (current status: ${req.status})`,
        );
      }

      // Approvals posted under the Goods-in-Transit flow produced an invoice
      // (and possibly a payment) — a blanket undo would leave revenue and cash
      // dangling. Voids/returns must reverse, never delete: use the invoice
      // void / credit-memo flows instead.
      const undoDelivery = await em.getRepository(Delivery).findOne({
        where: { id: req.deliveryId, companyId },
      });
      if (undoDelivery?.ledgerStatus === 'committed') {
        throw new ConflictException({
          code: 'LEDGER_COMMITTED',
          message:
            'This delivery was posted to the ledger (invoice/COGS). Undo is not available — void the invoice or issue a credit memo instead.',
        });
      }

      // Reverse inventory changes with row-locking
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
          // Item may have been deleted; skip gracefully
          continue;
        }

        const before = Number(item.quantityOnHand);
        const delivered = Number(line.deliveredQty);
        const returned = Number(line.returnedQty);
        // Undo: add back delivered, subtract returned
        const restored = before + delivered - returned;

        item.quantityOnHand = String(Math.max(0, restored));
        await itemRepo.save(item);

        await moveRepo.save(
          moveRepo.create({
            companyId,
            itemId: line.itemId,
            date: new Date().toISOString().split('T')[0],
            type: 'adjustment',
            quantityChange: String(delivered - returned),
            balanceAfter: String(Math.max(0, restored)),
            reference: `Undo Approval ${req.id}`,
            sourceType: 'inventory_approval',
            sourceId: req.id,
            createdBy: reviewerId,
            description: `approval_undone: ${req.deliveryReference ?? req.deliveryId}`,
          }),
        );
      }

      // Reverse the approval's ledger commit EXACTLY (swap Dr/Cr of the
      // original lines) so the undo restores the GL to the paisa even if the
      // item's average cost has drifted since approval. Voids reverse — the
      // original entry is never deleted.
      if (req.journalEntryId) {
        const jeRepo = em.getRepository(JournalEntry);
        const jeLineRepo = em.getRepository(JournalEntryLine);
        const originalEntry = await jeRepo.findOne({
          where: { id: req.journalEntryId, companyId },
        });
        const originalLines = await jeLineRepo.find({
          where: { entryId: req.journalEntryId },
          order: { lineOrder: 'ASC' },
        });
        if (originalEntry && originalLines.length >= 2) {
          await this.posting.createEntry(em, {
            companyId,
            date: new Date().toISOString().split('T')[0],
            memo: `Undo approval ${req.deliveryReference ?? req.deliveryId} — reverses ${originalEntry.reference}`,
            createdBy: reviewerId,
            status: 'posted',
            sourceType: 'delivery_approval_undo',
            sourceId: req.id,
            reversalOfId: originalEntry.id,
            lines: originalLines.map((l, i) => ({
              accountId: l.accountId,
              description: `Reversal: ${l.description ?? originalEntry.reference}`,
              debit: l.credit,
              credit: l.debit,
              lineOrder: i,
            })),
          });
        }
        req.journalEntryId = null;
      }

      // Reset shadow inventory for the personnel: restore qty to reflect undo
      for (const line of req.lines) {
        const shadow = await shadowRepo.findOne({
          where: { companyId, personnelId: req.personnelId, itemId: line.itemId },
        });
        if (shadow) {
          shadow.currentQty = String(
            Number(shadow.currentQty) + Number(line.deliveredQty) - Number(line.returnedQty),
          );
          // Back to pending review (not rejected) — admin will re-decide.
          shadow.syncStatus = 'pending' as never;
          shadow.lastSyncAt = new Date();
          await shadowRepo.save(shadow);
        }
      }

      // Undo returns the request to the PENDING review queue so the admin can
      // approve or reject it again — it is NOT a rejection.
      req.status = 'pending';
      req.shadowStatus = 'pending';
      req.reviewedAt = null;
      req.reviewedBy = null;
      req.reviewerComment = null;
      req.rejectReason = null;
      await reqRepo.save(req);

      await auditRepo.save(
        auditRepo.create({
          companyId,
          requestId: req.id,
          action: 'undone',
          reviewedBy: reviewerId,
          details: `Approval undone — ${req.lines.length} item change(s) reversed; request returned to pending for ${req.deliveryReference ?? req.deliveryId}`,
        }),
      );

      // Notify the DP (best-effort)
      void this.notifications.create({
        companyId,
        userId: req.personnelId,
        type: 'approval_results',
        title: 'Inventory approval reversed',
        message: `The approval for ${req.deliveryReference ?? 'your delivery'} was undone and sent back for re-review. Inventory quantities have been restored.`,
        data: { requestId: req.id, route: 'DPHistory' },
      });

      return this.formatRequest(req);
    });
  }

  async streamBillPhoto(
    companyId: string,
    requestId: string,
    viewer?: { id: string; role: string },
  ) {
    const req = await this.reqRepo.findOne({
      where: { id: requestId, companyId },
    });
    if (!req || !req.proofBillPhotoStorageKey) {
      throw new NotFoundException('Bill photo not found');
    }
    // Proof-of-delivery photos are visible to admins/staff and the rider who
    // submitted them — never to another rider in the same company.
    if (viewer && viewer.role === 'delivery' && req.personnelId !== viewer.id) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_REQUEST',
        message: 'You can only view proof photos for your own deliveries.',
      });
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

  /**
   * Attach the accounting context the approval queue needs (phase1.md Phase B):
   * the rider's PAID/NOT PAID flag, the customer, and the sale amount that
   * approval will invoice (delivered qty x delivery unit price, tax included).
   */
  private async enrichWithDelivery<
    T extends { deliveryId: string; changes: { itemId: string; deliveredQty: number }[] },
  >(companyId: string, formatted: T[]): Promise<
    (T & {
      paidStatus: 'paid' | 'unpaid';
      prepaid: boolean;
      ledgerStatus: string;
      customerId: string | null;
      customerName: string | null;
      saleAmount: string;
    })[]
  > {
    const deliveryIds = [...new Set(formatted.map((f) => f.deliveryId).filter(Boolean))];
    const deliveries = deliveryIds.length
      ? await this.deliveryRepo.find({
          where: deliveryIds.map((did) => ({ id: did, companyId })),
          relations: ['items'],
        })
      : [];
    const byId = new Map(deliveries.map((d) => [d.id, d]));

    return formatted.map((f) => {
      const d = byId.get(f.deliveryId);
      let saleAmount = toDecimal(0);
      if (d) {
        const itemByItemId = new Map((d.items ?? []).map((i) => [i.itemId, i]));
        for (const c of f.changes) {
          const line = itemByItemId.get(c.itemId);
          if (!line) continue;
          const price = toDecimal(line.unitPrice);
          const taxRate = toDecimal(line.taxRate ?? '0');
          const base = toDecimal(c.deliveredQty).times(price);
          saleAmount = saleAmount.plus(base).plus(base.times(taxRate).dividedBy(100));
        }
      }
      return {
        ...f,
        paidStatus: (d?.paidStatus ?? 'unpaid') as 'paid' | 'unpaid',
        prepaid: d?.prepaid ?? false,
        ledgerStatus: d?.ledgerStatus ?? 'none',
        customerId: d?.customerId ?? null,
        customerName: d?.customerName ?? null,
        saleAmount: saleAmount.toFixed(2),
      };
    });
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
      reviewedAt: r.reviewedAt ?? null,
      reviewedBy: r.reviewedBy ?? null,
      reviewerComment: r.reviewerComment ?? r.approvalNotes ?? r.rejectReason ?? null,
      changes: (r.lines ?? []).map((l) => ({
        itemId: l.itemId,
        itemName: l.itemName,
        beforeQty: Number(l.beforeQty),
        deliveredQty: Number(l.deliveredQty),
        returnedQty: Number(l.returnedQty),
      })),
      proof: {
        signedBy: r.proofSignedBy ?? null,
        billPhotoUri: r.proofBillPhotoUrl ?? null,
        billPhotoCapturedAt: r.proofBillPhotoCapturedAt ?? null,
        verificationMethod: r.proofVerificationMethod ?? 'bill_photo',
        verifiedBy: r.proofVerifiedBy ?? null,
      },
    };
  }
}
