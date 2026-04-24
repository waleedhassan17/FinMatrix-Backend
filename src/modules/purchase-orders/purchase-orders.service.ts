import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { PurchaseOrder } from './entities/purchase-order.entity';
import { PurchaseOrderLine } from './entities/purchase-order-line.entity';
import {
  CreateBillFromPoDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  ReceivePurchaseOrderDto,
} from './dto/purchase-order.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { formatPurchaseOrderRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { BillsService } from '../bills/bills.service';
import { PurchaseOrderStatus } from '../../types';

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly bills: BillsService,
    @InjectRepository(PurchaseOrder)
    private readonly repo: Repository<PurchaseOrder>,
  ) {}

  async list(
    companyId: string,
    query: ListPurchaseOrdersQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('o')
      .where('o.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('o.status = :s', { s: query.status });
    if (query.vendorId) qb.andWhere('o.vendorId = :v', { v: query.vendorId });
    qb.orderBy('o.orderDate', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);
    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string): Promise<PurchaseOrder> {
    const po = await this.repo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!po) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found' });
    }
    po.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return po;
  }

  async create(
    companyId: string,
    dto: CreatePurchaseOrderDto,
  ): Promise<PurchaseOrder> {
    return this.dataSource.transaction(async (manager) => {
      let subtotal = new Decimal(0);
      let tax = new Decimal(0);
      const calc = dto.lines.map((l, i) => {
        const qty = toDecimal(l.orderedQty);
        const cost = toDecimal(l.unitCost);
        const rate = toDecimal(l.taxRate ?? '0');
        const base = qty.times(cost);
        const t = base.times(rate).dividedBy(100);
        subtotal = subtotal.plus(base);
        tax = tax.plus(t);
        return {
          description: l.description,
          orderedQty: qty.toFixed(4),
          receivedQty: '0',
          unitCost: cost.toFixed(4),
          taxRate: rate.toFixed(4),
          lineTotal: base.plus(t).toFixed(4),
          itemId: l.itemId ?? null,
          accountId: l.accountId ?? null,
          lineOrder: i,
        };
      });
      const total = subtotal.plus(tax);

      const year = parseInt(dto.orderDate.slice(0, 4), 10);
      const seq = await nextYearlySequence(
        manager,
        'purchase_orders',
        companyId,
        year,
        'order_date',
        'PO',
        'po_number',
      );
      const po = manager.create(PurchaseOrder, {
        companyId,
        vendorId: dto.vendorId,
        poNumber: formatPurchaseOrderRef(year, seq),
        orderDate: dto.orderDate,
        expectedDate: dto.expectedDate ?? null,
        subtotal: subtotal.toFixed(4),
        taxAmount: tax.toFixed(4),
        total: total.toFixed(4),
        status: 'draft',
        notes: dto.notes ?? null,
      });
      await manager.save(po);
      const lines = calc.map((l) =>
        manager.create(PurchaseOrderLine, { orderId: po.id, ...l }),
      );
      await manager.save(lines);
      po.lines = lines;
      return po;
    });
  }

  async receive(
    companyId: string,
    id: string,
    dto: ReceivePurchaseOrderDto,
  ): Promise<PurchaseOrder> {
    return this.dataSource.transaction(async (manager) => {
      const po = await manager.findOne(PurchaseOrder, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!po) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found' });
      }
      const lineMap = new Map(po.lines.map((l) => [l.id, l]));
      for (const rl of dto.lines) {
        const line = lineMap.get(rl.lineId);
        if (!line) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Line ${rl.lineId} not on this PO`,
          });
        }
        const q = toDecimal(rl.receivedQty);
        if (q.greaterThan(toDecimal(line.orderedQty))) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: `Cannot receive more than ordered (${line.orderedQty})`,
          });
        }
        line.receivedQty = q.toFixed(4);
        await manager.save(line);
      }
      po.status = this.deriveStatus(po.lines);
      await manager.save(po);
      return po;
    });
  }

  async createBill(
    companyId: string,
    userId: string,
    id: string,
    dto: CreateBillFromPoDto,
  ): Promise<{ po: PurchaseOrder; billId: string }> {
    return this.dataSource.transaction(async (manager) => {
      const po = await manager.findOne(PurchaseOrder, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!po) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found' });
      }
      const received = po.lines.filter((l) => toDecimal(l.receivedQty).greaterThan(0));
      if (received.length === 0) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Nothing received on this PO',
        });
      }

      const bill = await this.bills.create(companyId, userId, {
        vendorId: po.vendorId,
        billNumber: dto.billNumber,
        billDate: dto.billDate,
        dueDate: dto.dueDate,
        memo: `Created from PO ${po.poNumber}`,
        status: 'open',
        lines: received.map((l) => ({
          accountId: l.accountId ?? dto.defaultAccountId,
          description: l.description,
          amount: toDecimal(l.receivedQty).times(toDecimal(l.unitCost)).toFixed(4),
          taxRate: l.taxRate,
        })),
      });

      po.status = this.deriveStatus(po.lines);
      await manager.save(po);
      return { po, billId: bill.id };
    });
  }

  private deriveStatus(lines: PurchaseOrderLine[]): PurchaseOrderStatus {
    let allReceived = true;
    let anyReceived = false;
    for (const l of lines) {
      const o = toDecimal(l.orderedQty);
      const r = toDecimal(l.receivedQty);
      if (r.greaterThan(0)) anyReceived = true;
      if (r.lessThan(o)) allReceived = false;
    }
    if (allReceived) return 'received';
    if (anyReceived) return 'partial';
    return 'sent';
  }
}
