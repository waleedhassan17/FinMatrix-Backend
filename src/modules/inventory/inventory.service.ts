import {
  ConflictException,
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
  SetOpeningStockDto,
  CreateStockTransferDto,
  CreatePhysicalCountDto,
  MovementQueryDto,
} from './dto/inventory.dto';
import { MONEY_TOLERANCE, toDecimal } from '../../common/utils/money.util';
import { InventoryAdjustmentReason } from '../../types';
import { assertNonNegativeQuantity } from '../../common/utils/stock.util';
import { assertNotFutureDate, todayIso } from '../../common/utils/date.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import {
  ACCT_INVENTORY,
  ACCT_INVENTORY_ADJUSTMENT,
  ACCT_INVENTORY_COUNT_VARIANCE,
  ACCT_OPENING_BALANCE_EQUITY,
  ADJUSTMENT_REASON_ACCOUNTS,
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

    // Unit cost is an OUTPUT of the receipt history, not an input. The single
    // cost method is weighted average, and a purchase receipt recomputes it as
    // (Q·A + q·P) / (Q + q) — so a hand-typed figure is overwritten by the very
    // next receipt anyway.
    //
    // Worse, Object.assign below used to copy it straight onto the entity with
    // no journal entry. Inventory Valuation reports qty × unit_cost, so editing
    // the cost of 100 units from 800 to 900 moved the subledger by 10,000 while
    // GL 1200 stayed exactly where it was — invariant I13, by hand.
    //
    // Zero on-hand is still free to edit: 0 × anything is 0, nothing can drift,
    // and setOpeningStock requires a cost to be set before it will post.
    if (dto.unitCost !== undefined) {
      const incoming = toDecimal(dto.unitCost);
      const current = toDecimal(item.unitCost);
      const onHand = toDecimal(item.quantityOnHand);
      if (!incoming.equals(current) && onHand.greaterThan(0)) {
        throw new BadRequestException({
          code: 'UNIT_COST_LOCKED',
          message:
            'Unit cost is the weighted average of what you actually paid, so it cannot be edited while stock is on hand. Receive stock at the new price and the average re-computes itself, or correct the quantity with a Stock Adjustment.',
          quantityOnHand: item.quantityOnHand,
          unitCost: item.unitCost,
        });
      }
    }

    Object.assign(item, dto);
    return this.itemRepo.save(item);
  }

  async toggleItem(companyId: string, id: string) {
    const item = await this.getItem(companyId, id);
    item.isActive = !item.isActive;
    return this.itemRepo.save(item);
  }

  /**
   * Record stock the company already owned before it started using FinMatrix.
   *
   * Deliberately a separate, one-time action rather than a field on the item
   * form. Creating an item is reference data and posts nothing; opening stock
   * is a real balance-sheet event and must post. Keeping them apart is what
   * stops someone typing a number into a form and silently minting an asset.
   */
  async setOpeningStock(
    companyId: string,
    id: string,
    dto: SetOpeningStockDto,
    userId: string,
  ) {
    return this.dataSource.transaction(async (em) => {
      const itemRepo = em.getRepository(InventoryItem);
      const moveRepo = em.getRepository(InventoryMovement);

      const item = await itemRepo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i.companyId = :cid', { id, cid: companyId })
        .getOne();
      if (!item) throw new NotFoundException('Item not found');

      // One-time only. Opening stock states what was on the shelf on day one;
      // anything after that is a correction and belongs to adjust(), which
      // records a reason and is reversible. Without this guard it becomes a
      // second adjustment route with no reason code and no reversal path.
      const onHand = toDecimal(item.quantityOnHand);
      const movements = await moveRepo.count({ where: { companyId, itemId: item.id } });
      if (!onHand.isZero() || movements > 0) {
        throw new BadRequestException({
          code: 'OPENING_STOCK_ALREADY_SET',
          message:
            'This item already has stock or movement history. Use a Stock Adjustment to correct the quantity.',
          quantityOnHand: item.quantityOnHand,
          movements,
        });
      }

      const qty = toDecimal(dto.quantity);
      assertNonNegativeQuantity(item.name, qty);
      if (toDecimal(item.unitCost).lessThanOrEqualTo(0)) {
        throw new BadRequestException({
          code: 'UNIT_COST_REQUIRED',
          message: 'Set the item unit cost before recording opening stock — stock with no cost has no value to post.',
        });
      }

      const date = dto.asOfDate ?? todayIso();
      item.quantityOnHand = qty.toFixed(4);
      await itemRepo.save(item);

      const move = await moveRepo.save(
        moveRepo.create({
          companyId,
          itemId: item.id,
          date,
          type: 'adjustment',
          quantityChange: qty.toFixed(4),
          balanceAfter: qty.toFixed(4),
          description: dto.notes ?? 'Opening stock',
          sourceType: 'opening_stock',
          sourceId: item.id,
          createdBy: userId,
        }),
      );

      const journalEntryId = await this.postOpeningStockJe(em, companyId, userId, item, qty, date);
      return { item, movement: move, journalEntryId };
    });
  }

  // Adjust
  //
  // `dto.date` sets the GL/report PERIOD the adjustment lands in. It does NOT
  // rewind stock: the quantity change always applies to CURRENT on-hand,
  // because you cannot un-consume stock that has already been sold or
  // delivered since. Same semantics as QuickBooks' inventory qty adjustment.
  //
  // No period check here on purpose — PostingService.createEntry runs
  // assertPeriodOpen against the JE date for every posted entry, and this whole
  // method is one transaction, so a PERIOD_LOCKED throw rolls the item,
  // adjustment and movement back with it.
  /**
   * Resolve an APPROVED adjustment request against today's stock, then post it.
   *
   * ── The problem this exists to solve ────────────────────────────────────
   * `adjust` takes an ABSOLUTE target and computes the variance against
   * on-hand at execution time. That is correct when filing and posting are the
   * same instant, which is how it always worked when only owners could adjust.
   * Under the approval flow they are not: staff file a target, and the owner
   * approves it minutes or days later.
   *
   * On-hand 100, staff find 20 damaged and file "set to 80". A delivery ships
   * 30 before approval, leaving 70. Plain `adjust` would compute 80 − 70 = +10
   * and INCREASE stock by 10 — the damaged units still on the books, shrinkage
   * credited instead of debited. Nothing errors and the trial balance still
   * balances, because the entry is internally consistent. It is simply not
   * what anyone asked for.
   *
   * ── Why the reason decides ──────────────────────────────────────────────
   * The reasons already mean different things, and the fix is to read them:
   *
   *   physical_count  an ASSERTION about the shelf — "I counted 80". If stock
   *                   moved since, the count is stale and posting it would
   *                   post a number nobody verified. Refuse; ask for a recount.
   *
   *   everything else a DELTA — "20 broke", "3 were stolen". The intent
   *                   survives however much stock moved, so apply the delta
   *                   the requester meant rather than their arithmetic.
   *
   * `observedQty` is on-hand as the requester saw it, captured by the gate at
   * filing time. Absent (a request filed before this shipped) the old
   * behaviour stands — there is nothing to compare against, and refusing every
   * historical request would be worse than the risk.
   */
  async adjustFromApprovedRequest(
    companyId: string,
    payload: AdjustQuantityDto & { observedQty?: string },
    userId: string,
  ) {
    if (payload.observedQty == null) {
      return this.adjust(companyId, payload, userId);
    }

    const item = await this.itemRepo.findOne({
      where: { id: payload.itemId, companyId },
    });
    if (!item) throw new NotFoundException('Item not found');

    const observed = toDecimal(payload.observedQty);
    const current = toDecimal(item.quantityOnHand);

    if (payload.reason === 'physical_count') {
      if (!current.minus(observed).abs().lessThanOrEqualTo(MONEY_TOLERANCE)) {
        throw new ConflictException({
          code: 'STOCK_MOVED_SINCE_COUNT',
          message:
            `${item.name} was ${observed.toFixed(0)} when this count was taken and is ` +
            `${current.toFixed(0)} now. Ask for a fresh count rather than posting the old one.`,
          observedQty: observed.toFixed(4),
          currentQty: current.toFixed(4),
        });
      }
      return this.adjust(companyId, payload, userId);
    }

    // A shrinkage keeps its meaning: re-base the same delta onto today's stock.
    const delta = toDecimal(payload.newQty).minus(observed);
    const rebased = current.plus(delta);

    // The delta can outlive the stock it referred to — 420 units written off
    // against a shelf that has since fallen to 95. Say so, rather than letting
    // the negative-quantity guard report a bare "quantity cannot be negative"
    // that gives the owner nothing to act on.
    if (rebased.lessThan(0)) {
      throw new ConflictException({
        code: 'ADJUSTMENT_EXCEEDS_STOCK',
        message:
          `This asked to remove ${delta.abs().toFixed(0)} × ${item.name}, but only ` +
          `${current.toFixed(0)} remain (there were ${observed.toFixed(0)} when it was ` +
          'requested). Ask for it to be raised again against current stock.',
        observedQty: observed.toFixed(4),
        currentQty: current.toFixed(4),
        requestedDelta: delta.toFixed(4),
      });
    }

    return this.adjust(
      companyId,
      { ...payload, newQty: rebased.toFixed(4) },
      userId,
    );
  }

  async adjust(companyId: string, dto: AdjustQuantityDto, userId: string) {
    // Resolved once and shared by the adjustment, its movement and the journal
    // entry. These used to be two independent new Date() calls, so a request
    // straddling UTC midnight could date the adjustment and its movement a day
    // apart.
    const date = dto.date ?? todayIso();
    assertNotFutureDate(date, 'An inventory adjustment');

    return this.dataSource.transaction(async (em) => {
      const itemRepo = em.getRepository(InventoryItem);
      const adjRepo = em.getRepository(InventoryAdjustment);
      const moveRepo = em.getRepository(InventoryMovement);
      // Locked, like setOpeningStock: what follows is a read-modify-write on
      // quantityOnHand, and two concurrent adjustments reading the same `prev`
      // would each post a journal entry while only the last write survives —
      // leaving the subledger adrift from GL 1200 (invariant I13).
      const item = await itemRepo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i.companyId = :cid', { id: dto.itemId, cid: companyId })
        .getOne();
      if (!item) throw new NotFoundException('Item not found');

      const prev = toDecimal(item.quantityOnHand);
      const next = toDecimal(dto.newQty);
      // An adjustment sets an absolute quantity; a negative target would trip
      // chk_no_negative_stock as a raw 500 (I11).
      assertNonNegativeQuantity(item.name, next);
      const variance = next.minus(prev);

      item.quantityOnHand = next.toFixed(4);
      await itemRepo.save(item);

      // The reason picks the offsetting account, so damage, theft and
      // obsolescence are separable in the P&L rather than pooled in one line.
      const offsetAccountNumber = ADJUSTMENT_REASON_ACCOUNTS[dto.reason];

      const adj = adjRepo.create({
        companyId,
        itemId: dto.itemId,
        date,
        previousQty: prev.toFixed(4),
        newQty: next.toFixed(4),
        variance: variance.toFixed(4),
        reason: dto.reason,
        notes: dto.notes ?? null,
        offsetAccountNumber,
        createdBy: userId,
      });
      await adjRepo.save(adj);

      const move = moveRepo.create({
        companyId,
        itemId: dto.itemId,
        date,
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
        offsetAccountNumber,
      );
      if (je) {
        adj.journalEntryId = je;
        await adjRepo.save(adj);
      }

      return { item, adjustment: adj, movement: move };
    });
  }

  /**
   * Unwind an inventory adjustment (audit gap G7).
   *
   * Adjustments had no correction path: a shrinkage written off against the
   * wrong item, or the wrong quantity, could only be fixed by adjusting again
   * — which leaves two unexplained entries instead of one reversal.
   *
   * Puts the quantity back, values the reversal at the SAME unit cost the
   * original used (recomputed from the entry's own value, not today's average,
   * so a drifted cost cannot leave residue in Inventory or 6400), and posts a
   * mirrored entry through the shared engine so the period lock applies.
   */
  async reverseAdjustment(companyId: string, id: string, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const adjRepo = em.getRepository(InventoryAdjustment);
      const itemRepo = em.getRepository(InventoryItem);
      const moveRepo = em.getRepository(InventoryMovement);

      const adj = await adjRepo.findOne({ where: { id, companyId } });
      if (!adj) throw new NotFoundException('Inventory adjustment not found');
      if (adj.reason === 'reversal') {
        throw new BadRequestException('That adjustment is itself a reversal');
      }

      // Locked for the same reason adjust() is: this recomputes both
      // quantityOnHand and unitCost from what it reads.
      const item = await itemRepo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i.companyId = :cid', { id: adj.itemId, cid: companyId })
        .getOne();
      if (!item) throw new NotFoundException('Item not found');

      // Value the reversal at the ORIGINAL cost basis, recovered from the
      // entry that was posted, so it cancels that entry exactly.
      const variance = toDecimal(adj.variance);
      const originalValue = await this.originalAdjustmentValue(em, adj);
      const originalUnitCost = variance.isZero()
        ? new Decimal(0)
        : originalValue.dividedBy(variance.abs());

      const onHand = toDecimal(item.quantityOnHand);
      const restored = onHand.minus(variance);
      assertNonNegativeQuantity(item.name, restored);

      // Keep the subledger tied to GL 1200: total value must move by exactly
      // the amount the reversing entry posts (see credit-memo restock).
      if (restored.greaterThan(0)) {
        const nextValue = onHand
          .times(toDecimal(item.unitCost))
          .minus(variance.times(originalUnitCost));
        item.unitCost = nextValue
          .dividedBy(restored)
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
          .toFixed(4);
      }
      item.quantityOnHand = restored.toFixed(4);
      await itemRepo.save(item);

      const today = todayIso();
      // Mirror the account the ORIGINAL used, not whatever today's reason map
      // would pick. Rows written before that column existed all went to 6400.
      const offsetAccountNumber = adj.offsetAccountNumber ?? ACCT_INVENTORY_ADJUSTMENT;

      const reversal = await adjRepo.save(
        adjRepo.create({
          companyId,
          itemId: adj.itemId,
          date: today,
          previousQty: onHand.toFixed(4),
          newQty: restored.toFixed(4),
          variance: variance.negated().toFixed(4),
          reason: 'reversal' as InventoryAdjustmentReason,
          notes: `Reversal of adjustment ${adj.id}`,
          // Carried onto the reversal too, so it is self-describing rather
          // than only explicable by loading the row it reverses.
          offsetAccountNumber,
          createdBy: userId,
        }),
      );

      await moveRepo.save(
        moveRepo.create({
          companyId,
          itemId: adj.itemId,
          date: today,
          type: 'adjustment',
          quantityChange: variance.negated().toFixed(4),
          balanceAfter: restored.toFixed(4),
          description: `Reversal of adjustment ${adj.id}`,
          sourceType: 'inventory_adjustment_void',
          sourceId: reversal.id,
          createdBy: userId,
        }),
      );

      if (originalValue.greaterThan(0)) {
        const inventoryAcct = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, em);
        const adjustmentAcct = await this.accounts.getOrCreateSystemAccount(
          em,
          companyId,
          offsetAccountNumber,
        );
        const amount = originalValue.toFixed(4);
        // Mirror of postInventoryAdjustmentJe: the original write-down debited
        // the shrinkage account and credited 1200, so the reversal does the
        // opposite — against the SAME account, or value is stranded in both.
        const wasIncrease = variance.greaterThan(0);
        const lines = wasIncrease
          ? [
              { accountId: adjustmentAcct.id, debit: amount, credit: '0' },
              { accountId: inventoryAcct.id, debit: '0', credit: amount },
            ]
          : [
              { accountId: inventoryAcct.id, debit: amount, credit: '0' },
              { accountId: adjustmentAcct.id, debit: '0', credit: amount },
            ];
        const entry = await this.posting.createEntry(em, {
          companyId,
          createdBy: userId,
          date: today,
          memo: `Reverse inventory adjustment ${item.sku}`,
          status: 'posted',
          lines: lines.map((l, i) => ({ ...l, lineOrder: i })),
          sourceType: 'inventory_adjustment_void',
          sourceId: reversal.id,
          reversalOfId: adj.journalEntryId,
        });
        reversal.journalEntryId = entry.id;
        await adjRepo.save(reversal);
      }

      return { item, adjustment: reversal, reversedId: adj.id };
    });
  }

  /**
   * The value the original adjustment actually posted, read back from its own
   * journal entry. Recomputing from today's unit cost would size the reversal
   * wrongly whenever the weighted average has moved since.
   */
  private async originalAdjustmentValue(
    em: import('typeorm').EntityManager,
    adj: InventoryAdjustment,
  ): Promise<Decimal> {
    if (!adj.journalEntryId) return new Decimal(0);
    const rows = await em.query(
      `SELECT COALESCE(SUM(debit), 0) AS total
         FROM journal_entry_lines WHERE entry_id = $1`,
      [adj.journalEntryId],
    );
    return toDecimal(rows[0]?.total);
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
          // A counted quantity is absolute; negative is not a real count (I11).
          assertNonNegativeQuantity(item.name, counted);
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
              offsetAccountNumber: ACCT_INVENTORY_COUNT_VARIANCE,
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
            ACCT_INVENTORY_COUNT_VARIANCE,
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
   * Post the opening balance for stock a company already owned when it started
   * using FinMatrix.
   *
   *   DR Inventory 1200  /  CR Opening Balance Equity 3900
   *
   * This is §3.12 applied to inventory. AccountsService.create already does it
   * for a GL account opened with a balance; stock had no equivalent, so the
   * only ways to get day-one inventory in were a Purchase Order — which
   * invents a vendor and a payable that never existed — or a Stock Adjustment,
   * which credits expense 6400 and so reports the shelf as PROFIT. Opening
   * Balance Equity is the account that exists for this: no supplier, no P&L,
   * and an accountant clears it to owner equity when the migration is done.
   *
   * Public so AgenciesService can post through the same path; its "Opening Qty"
   * field created stock and value with no entry at all.
   */
  async postOpeningStockJe(
    em: import('typeorm').EntityManager,
    companyId: string,
    userId: string,
    item: InventoryItem,
    quantity: Decimal,
    date: string,
  ): Promise<string | null> {
    const value = quantity.times(toDecimal(item.unitCost));
    if (value.lessThanOrEqualTo(0)) return null;

    const inventoryAcct = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, em);
    // 3900 is lazily created — a company that never opened a balance has no row yet.
    const obe = await this.accounts.getOrCreateSystemAccount(
      em,
      companyId,
      ACCT_OPENING_BALANCE_EQUITY,
    );
    const amount = value.toFixed(4);

    const entry = await this.posting.createEntry(em, {
      companyId,
      createdBy: userId,
      date,
      memo: `Opening stock for ${item.sku} ${item.name}`,
      status: 'posted',
      lines: [
        { accountId: inventoryAcct.id, description: 'Opening stock on hand', debit: amount, credit: '0', lineOrder: 0 },
        { accountId: obe.id, description: 'Opening balance equity', debit: '0', credit: amount, lineOrder: 1 },
      ],
      sourceType: 'opening_stock',
      sourceId: item.id,
    });
    return entry.id;
  }

  /**
   * Post the balanced inventory-adjustment journal entry for a quantity
   * variance valued at the item's unit cost. Returns the entry id (or null
   * when the value is zero). Shared by adjust() and physical count.
   *
   * `offsetAccountNumber` is the account 1200 is offset against — chosen from
   * the reason by ADJUSTMENT_REASON_ACCOUNTS, or 5430 for a physical count.
   * It used to be hardcoded to 6400 for every reason.
   *   decrease (variance < 0): DR shrinkage account / CR Inventory 1200
   *   increase (variance > 0): DR Inventory 1200 / CR shrinkage account
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
    offsetAccountNumber: string,
  ): Promise<string | null> {
    const value = variance.abs().times(toDecimal(item.unitCost));
    if (value.lessThanOrEqualTo(0)) return null;
    const inventoryAcct = await this.accounts.getByNumberOrFail(companyId, ACCT_INVENTORY, em);
    // getOrCreate, not getByNumberOrFail: the 54xx accounts are new, and a
    // company whose chart predates them gets the account created on first use
    // — the same way 6400, GRNI and Goods in Transit already reach older
    // tenants. That is why no backfill migration is needed.
    const adjustmentAcct = await this.accounts.getOrCreateSystemAccount(
      em,
      companyId,
      offsetAccountNumber,
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
