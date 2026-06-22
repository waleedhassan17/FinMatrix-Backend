import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Estimate, DiscountType, EstimateStatus } from './entities/estimate.entity';
import { EstimateLineItem } from './entities/estimate-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import {
  ConvertEstimateDto,
  CreateEstimateDto,
  EstimateLineDto,
  EstimateStatusDto,
  ListEstimatesQueryDto,
  UpdateEstimateDto,
} from './dto/estimate.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { formatEstimateRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { InvoicesService } from '../invoices/invoices.service';
import { SalesOrdersService } from '../sales-orders/sales-orders.service';

interface LineCalc {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  accountId: string | null;
  lineOrder: number;
}

@Injectable()
export class EstimatesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly invoices: InvoicesService,
    private readonly salesOrders: SalesOrdersService,
    @InjectRepository(Estimate) private readonly repo: Repository<Estimate>,
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
  ) {}

  async list(companyId: string, query: ListEstimatesQueryDto, pagination: PaginationParams) {
    const qb = this.repo.createQueryBuilder('e').where('e.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('e.status = :s', { s: query.status });
    if (query.customerId) qb.andWhere('e.customerId = :c', { c: query.customerId });
    if (query.startDate && query.endDate) {
      qb.andWhere('e.estimateDate BETWEEN :s AND :e', { s: query.startDate, e: query.endDate });
    }
    if (query.search) {
      qb.andWhere(new Brackets((w) => {
        w.where('e.estimateNumber ILIKE :s', { s: `%${query.search}%` })
          .orWhere('e.notes ILIKE :s', { s: `%${query.search}%` });
      }));
    }
    qb.orderBy('e.estimateDate', 'DESC').addOrderBy('e.createdAt', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();
    const customerIds = [...new Set(data.map((e) => e.customerId).filter(Boolean))];
    const customers = customerIds.length ? await this.customerRepo.findByIds(customerIds) : [];
    const nameMap = Object.fromEntries(customers.map((c) => [c.id, c.name]));

    const statusCounts = await this.repo.createQueryBuilder('e')
      .select('e.status', 'status').addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(e.total), 0)', 'total')
      .where('e.companyId = :companyId', { companyId }).groupBy('e.status').getRawMany();

    return {
      data: data.map((e) => ({ ...e, customerName: nameMap[e.customerId] ?? '' })),
      summary: Object.fromEntries(statusCounts.map((r) => [r.status, {
        count: parseInt(r.count, 10), total: toDecimal(r.total).toFixed(4),
      }])),
      pagination: {
        page: pagination.page, limit: pagination.limit, total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string): Promise<Estimate> {
    const est = await this.repo.findOne({ where: { id, companyId }, relations: { lines: true } });
    if (!est) throw new NotFoundException({ code: 'ESTIMATE_NOT_FOUND', message: 'Estimate not found' });
    est.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return est;
  }

  async create(companyId: string, userId: string, dto: CreateEstimateDto): Promise<Estimate> {
    return this.dataSource.transaction(async (manager) => {
      const customer = await manager.findOne(Customer, { where: { id: dto.customerId, companyId } });
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });

      const totals = this.computeTotals(dto.lines, dto.discountType, dto.discountValue);
      const year = parseInt(dto.estimateDate.slice(0, 4), 10);
      const seq = await nextYearlySequence(manager, 'estimates', companyId, year, 'estimate_date', 'EST', 'estimate_number');
      const estimateNumber = formatEstimateRef(year, seq);

      const estimate = manager.create(Estimate, {
        companyId,
        customerId: dto.customerId,
        estimateNumber,
        estimateDate: dto.estimateDate,
        expiryDate: dto.expiryDate ?? null,
        subtotal: totals.subtotal,
        discountType: (dto.discountType ?? 'none') as DiscountType,
        discountValue: dto.discountValue ?? '0',
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        status: (dto.status ?? 'draft') as EstimateStatus,
        notes: dto.notes ?? null,
        convertedToType: null,
        convertedToId: null,
        createdBy: userId,
      });
      await manager.save(estimate);

      const lines = totals.lines.map((l) => manager.create(EstimateLineItem, { estimateId: estimate.id, ...l }));
      await manager.save(lines);
      estimate.lines = lines;
      return estimate;
    });
  }

  async update(companyId: string, id: string, dto: UpdateEstimateDto): Promise<Estimate> {
    return this.dataSource.transaction(async (manager) => {
      const estimate = await manager.findOne(Estimate, { where: { id, companyId }, relations: { lines: true } });
      if (!estimate) throw new NotFoundException({ code: 'ESTIMATE_NOT_FOUND', message: 'Estimate not found' });
      if (estimate.status === 'converted') {
        throw new BadRequestException({ code: 'CANNOT_EDIT_CONVERTED', message: 'Converted estimates cannot be edited' });
      }

      if (dto.estimateDate !== undefined) estimate.estimateDate = dto.estimateDate;
      if (dto.expiryDate !== undefined) estimate.expiryDate = dto.expiryDate;
      if (dto.notes !== undefined) estimate.notes = dto.notes;

      if (dto.lines || dto.discountType !== undefined || dto.discountValue !== undefined) {
        const nextLines = dto.lines ?? estimate.lines.map<EstimateLineDto>((l) => ({
          description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
          taxRate: l.taxRate, accountId: l.accountId ?? undefined,
        }));
        const dType = dto.discountType ?? estimate.discountType;
        const dValue = dto.discountValue ?? estimate.discountValue;
        const totals = this.computeTotals(nextLines, dType, dValue);
        estimate.discountType = dType;
        estimate.discountValue = dValue;
        estimate.discountAmount = totals.discountAmount;
        estimate.taxAmount = totals.taxAmount;
        estimate.subtotal = totals.subtotal;
        estimate.total = totals.total;
        if (dto.lines) {
          await manager.delete(EstimateLineItem, { estimateId: estimate.id });
          await manager.save(totals.lines.map((l) => manager.create(EstimateLineItem, { estimateId: estimate.id, ...l })));
        }
      }
      await manager.save(estimate);
      return (await manager.findOne(Estimate, { where: { id, companyId }, relations: { lines: true } }))!;
    });
  }

  async setStatus(companyId: string, id: string, dto: EstimateStatusDto): Promise<Estimate> {
    const estimate = await this.getById(companyId, id);
    if (estimate.status === 'converted') {
      throw new BadRequestException({ code: 'ALREADY_CONVERTED', message: 'Estimate already converted' });
    }
    estimate.status = dto.status;
    await this.repo.save(estimate);
    return estimate;
  }

  async convertToInvoice(companyId: string, userId: string, id: string, dto: ConvertEstimateDto) {
    const estimate = await this.getById(companyId, id);
    this.assertConvertible(estimate);
    const today = new Date().toISOString().slice(0, 10);
    const due = dto.dueDate ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const invoice = await this.invoices.create(companyId, userId, {
      customerId: estimate.customerId,
      invoiceDate: today,
      dueDate: due,
      discountType: estimate.discountType,
      discountValue: estimate.discountValue,
      status: 'sent',
      notes: `Converted from estimate ${estimate.estimateNumber}`,
      lines: estimate.lines.map((l) => ({
        description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        taxRate: l.taxRate, accountId: l.accountId ?? undefined,
      })),
    });
    await this.markConverted(estimate, 'invoice', invoice.id);
    return { estimate: await this.getById(companyId, id), invoice };
  }

  async convertToSalesOrder(companyId: string, userId: string, id: string) {
    const estimate = await this.getById(companyId, id);
    this.assertConvertible(estimate);
    const salesOrder = await this.salesOrders.create(
      companyId,
      userId,
      {
        customerId: estimate.customerId,
        orderDate: new Date().toISOString().slice(0, 10),
        discountType: estimate.discountType,
        discountValue: estimate.discountValue,
        notes: `Converted from estimate ${estimate.estimateNumber}`,
        lines: estimate.lines.map((l) => ({
          description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
          taxRate: l.taxRate, accountId: l.accountId ?? undefined,
        })),
      },
      estimate.id,
    );
    await this.markConverted(estimate, 'sales_order', salesOrder.id);
    return { estimate: await this.getById(companyId, id), salesOrder };
  }

  async delete(companyId: string, id: string) {
    const est = await this.getById(companyId, id);
    if (est.status === 'converted') {
      throw new BadRequestException({ code: 'CANNOT_DELETE_CONVERTED', message: 'Converted estimates cannot be deleted' });
    }
    await this.repo.remove(est);
    return { id, deleted: true };
  }

  // ── helpers ──
  private assertConvertible(estimate: Estimate) {
    if (estimate.status === 'converted') {
      throw new BadRequestException({ code: 'ALREADY_CONVERTED', message: 'Estimate has already been converted' });
    }
    if (estimate.status === 'declined') {
      throw new BadRequestException({ code: 'ESTIMATE_DECLINED', message: 'Declined estimates cannot be converted' });
    }
  }

  private async markConverted(estimate: Estimate, type: 'invoice' | 'sales_order', targetId: string) {
    estimate.status = 'converted';
    estimate.convertedToType = type;
    estimate.convertedToId = targetId;
    await this.repo.save(estimate);
  }

  private computeTotals(
    lines: EstimateLineDto[],
    discountType: 'percent' | 'amount' | 'none' | undefined,
    discountValue: string | undefined,
  ): { subtotal: string; discountAmount: string; taxAmount: string; total: string; lines: LineCalc[] } {
    const calc: LineCalc[] = [];
    let subtotal = new Decimal(0);
    let taxTotal = new Decimal(0);
    lines.forEach((l, i) => {
      const qty = toDecimal(l.quantity);
      const price = toDecimal(l.unitPrice);
      const taxRate = toDecimal(l.taxRate ?? '0');
      const base = qty.times(price);
      const tax = base.times(taxRate).dividedBy(100);
      subtotal = subtotal.plus(base);
      taxTotal = taxTotal.plus(tax);
      calc.push({
        description: l.description, quantity: qty.toFixed(4), unitPrice: price.toFixed(4),
        taxRate: taxRate.toFixed(4), taxAmount: tax.toFixed(4), lineTotal: base.plus(tax).toFixed(4),
        accountId: l.accountId ?? null, lineOrder: i,
      });
    });
    let discountAmount = new Decimal(0);
    if (discountType === 'percent') discountAmount = subtotal.times(toDecimal(discountValue ?? 0)).dividedBy(100);
    else if (discountType === 'amount') discountAmount = toDecimal(discountValue ?? 0);
    if (discountAmount.greaterThan(subtotal)) discountAmount = subtotal;
    const total = subtotal.minus(discountAmount).plus(taxTotal);
    return {
      subtotal: subtotal.toFixed(4), discountAmount: discountAmount.toFixed(4),
      taxAmount: taxTotal.toFixed(4), total: total.toFixed(4), lines: calc,
    };
  }
}
