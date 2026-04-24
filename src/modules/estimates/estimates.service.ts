import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Estimate } from './entities/estimate.entity';
import { EstimateLineItem } from './entities/estimate-line-item.entity';
import {
  CreateEstimateDto,
  EstimateLineDto,
  ListEstimatesQueryDto,
  UpdateEstimateDto,
} from './dto/estimate.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { formatEstimateRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { InvoicesService } from '../invoices/invoices.service';

@Injectable()
export class EstimatesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly invoices: InvoicesService,
    @InjectRepository(Estimate)
    private readonly repo: Repository<Estimate>,
  ) {}

  async list(
    companyId: string,
    query: ListEstimatesQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('e.status = :s', { s: query.status });
    if (query.customerId) qb.andWhere('e.customerId = :c', { c: query.customerId });
    qb.orderBy('e.estimateDate', 'DESC');
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

  async getById(companyId: string, id: string): Promise<Estimate> {
    const e = await this.repo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!e) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Estimate not found',
      });
    }
    e.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return e;
  }

  async create(companyId: string, dto: CreateEstimateDto): Promise<Estimate> {
    return this.dataSource.transaction(async (manager) => {
      const totals = this.computeTotals(dto.lines, dto.discountAmount ?? '0');
      const year = parseInt(dto.estimateDate.slice(0, 4), 10);
      const seq = await nextYearlySequence(
        manager,
        'estimates',
        companyId,
        year,
        'estimate_date',
        'EST',
        'estimate_number',
      );
      const estimate = manager.create(Estimate, {
        companyId,
        customerId: dto.customerId,
        estimateNumber: formatEstimateRef(year, seq),
        estimateDate: dto.estimateDate,
        expirationDate: dto.expirationDate ?? null,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        status: 'draft',
        convertedToInvoiceId: null,
        notes: dto.notes ?? null,
      });
      await manager.save(estimate);
      const lines = totals.lines.map((l) =>
        manager.create(EstimateLineItem, {
          estimateId: estimate.id,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          lineTotal: l.lineTotal,
          lineOrder: l.lineOrder,
        }),
      );
      await manager.save(lines);
      estimate.lines = lines;
      return estimate;
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateEstimateDto,
  ): Promise<Estimate> {
    return this.dataSource.transaction(async (manager) => {
      const estimate = await manager.findOne(Estimate, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!estimate) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Estimate not found',
        });
      }
      if (estimate.status === 'accepted') {
        throw new BadRequestException({
          code: 'CANNOT_EDIT_POSTED',
          message: 'Cannot edit an accepted estimate',
        });
      }
      if (dto.estimateDate !== undefined) estimate.estimateDate = dto.estimateDate;
      if (dto.expirationDate !== undefined) estimate.expirationDate = dto.expirationDate;
      if (dto.notes !== undefined) estimate.notes = dto.notes;

      if (dto.lines || dto.discountAmount !== undefined) {
        const lines = dto.lines ?? estimate.lines.map<EstimateLineDto>((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
        }));
        const totals = this.computeTotals(
          lines,
          dto.discountAmount ?? estimate.discountAmount,
        );
        estimate.subtotal = totals.subtotal;
        estimate.discountAmount = totals.discountAmount;
        estimate.taxAmount = totals.taxAmount;
        estimate.total = totals.total;
        if (dto.lines) {
          await manager.delete(EstimateLineItem, { estimateId: estimate.id });
          await manager.save(
            totals.lines.map((l) =>
              manager.create(EstimateLineItem, {
                estimateId: estimate.id,
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                taxRate: l.taxRate,
                lineTotal: l.lineTotal,
                lineOrder: l.lineOrder,
              }),
            ),
          );
        }
      }
      await manager.save(estimate);
      return this.getById(companyId, id);
    });
  }

  async convertToInvoice(
    companyId: string,
    userId: string,
    id: string,
  ): Promise<{ estimate: Estimate; invoiceId: string }> {
    return this.dataSource.transaction(async (manager) => {
      const estimate = await manager.findOne(Estimate, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!estimate) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Estimate not found',
        });
      }
      if (estimate.convertedToInvoiceId) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Estimate already converted to an invoice',
        });
      }

      const today = new Date().toISOString().slice(0, 10);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);

      const invoice = await this.invoices.create(companyId, userId, {
        customerId: estimate.customerId,
        invoiceDate: today,
        dueDate: dueDate.toISOString().slice(0, 10),
        status: 'sent',
        notes: `Converted from estimate ${estimate.estimateNumber}`,
        lines: estimate.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
        })),
      });

      estimate.status = 'accepted';
      estimate.convertedToInvoiceId = invoice.id;
      await manager.save(estimate);
      return { estimate, invoiceId: invoice.id };
    });
  }

  private computeTotals(
    lines: EstimateLineDto[],
    discountAmountStr: string,
  ): {
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    total: string;
    lines: {
      description: string;
      quantity: string;
      unitPrice: string;
      taxRate: string;
      lineTotal: string;
      lineOrder: number;
    }[];
  } {
    let subtotal = new Decimal(0);
    let tax = new Decimal(0);
    const calc = lines.map((l, i) => {
      const qty = toDecimal(l.quantity);
      const price = toDecimal(l.unitPrice);
      const taxRate = toDecimal(l.taxRate ?? '0');
      const base = qty.times(price);
      const t = base.times(taxRate).dividedBy(100);
      subtotal = subtotal.plus(base);
      tax = tax.plus(t);
      return {
        description: l.description,
        quantity: qty.toFixed(4),
        unitPrice: price.toFixed(4),
        taxRate: taxRate.toFixed(4),
        lineTotal: base.plus(t).toFixed(4),
        lineOrder: i,
      };
    });
    let discount = toDecimal(discountAmountStr);
    if (discount.greaterThan(subtotal)) discount = subtotal;
    const total = subtotal.minus(discount).plus(tax);
    return {
      subtotal: subtotal.toFixed(4),
      discountAmount: discount.toFixed(4),
      taxAmount: tax.toFixed(4),
      total: total.toFixed(4),
      lines: calc,
    };
  }
}
