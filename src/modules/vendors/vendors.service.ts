import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toDecimal } from '../../common/utils/money.util';
import { inPeriod, statementBalances } from '../../common/utils/statement.util';
import { Vendor } from './entities/vendor.entity';
import { Bill } from '../bills/entities/bill.entity';
import { BillPayment } from '../bills/entities/bill-payment.entity';
import {
  CreateVendorDto,
  ListVendorsQueryDto,
  UpdateVendorDto,
} from './dto/vendor.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { applyTextSearch } from '../../common/utils/search-query.util';

@Injectable()
export class VendorsService {
  constructor(
    @InjectRepository(Vendor) private readonly repo: Repository<Vendor>,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(BillPayment)
    private readonly paymentRepo: Repository<BillPayment>,
  ) {}

  async list(
    companyId: string,
    query: ListVendorsQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('v')
      .where('v.companyId = :companyId', { companyId });
    if (query.isActive !== undefined)
      qb.andWhere('v.isActive = :a', { a: query.isActive });
    applyTextSearch(qb, query.search, companyId, {
      columns: ['v.companyName', 'v.email', 'v.contactPerson', 'v.phone'],
    });
    qb.orderBy('v.createdAt', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);
    const [data, total] = await qb.getManyAndCount();
    return {
      data: {
        data,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
        },
      },
    };
  }

  async getById(companyId: string, id: string): Promise<Vendor> {
    const v = await this.repo.findOne({ where: { id, companyId } });
    if (!v) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
    return v;
  }

  create(companyId: string, dto: CreateVendorDto): Promise<Vendor> {
    return this.repo.save(
      this.repo.create({
        companyId,
        companyName: dto.companyName,
        contactPerson: dto.contactPerson ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
        paymentTerms: dto.paymentTerms ?? 'net30',
        taxId: dto.taxId ?? null,
        defaultExpenseAccountId: dto.defaultExpenseAccountId ?? null,
        balance: '0',
        isActive: true,
        notes: dto.notes ?? null,
      }),
    );
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateVendorDto,
  ): Promise<Vendor> {
    const v = await this.getById(companyId, id);
    if (dto.companyName !== undefined) v.companyName = dto.companyName;
    if (dto.contactPerson !== undefined) v.contactPerson = dto.contactPerson;
    if (dto.email !== undefined) v.email = dto.email;
    if (dto.phone !== undefined) v.phone = dto.phone;
    if (dto.address !== undefined) v.address = dto.address;
    if (dto.paymentTerms !== undefined) v.paymentTerms = dto.paymentTerms;
    if (dto.taxId !== undefined) v.taxId = dto.taxId;
    if (dto.defaultExpenseAccountId !== undefined)
      v.defaultExpenseAccountId = dto.defaultExpenseAccountId;
    if (dto.notes !== undefined) v.notes = dto.notes;
    if (dto.isActive !== undefined) v.isActive = dto.isActive;
    return this.repo.save(v);
  }

  async delete(companyId: string, id: string) {
    const v = await this.getById(companyId, id);
    // softRemove was a silent no-op (no @DeleteDateColumn on the entity).
    // Deleting a vendor with financial history would orphan bills and break
    // AP — block it and point the admin at deactivation instead.
    const [billCount, paymentCount] = await Promise.all([
      this.billRepo.count({ where: { companyId, vendorId: id } }),
      this.paymentRepo.count({ where: { companyId, vendorId: id } }),
    ]);
    if (billCount > 0 || paymentCount > 0 || !toDecimal(v.balance).isZero()) {
      throw new BadRequestException({
        code: 'VENDOR_HAS_ACTIVITY',
        message:
          'This vendor has bills, payments, or an outstanding balance and cannot be deleted. Deactivate the vendor instead.',
      });
    }
    await this.repo.remove(v);
    return { id, deleted: true };
  }

  async toggleActive(companyId: string, id: string) {
    const v = await this.getById(companyId, id);
    v.isActive = !v.isActive;
    return this.repo.save(v);
  }

  async bills(companyId: string, id: string, pagination: PaginationParams) {
    await this.getById(companyId, id);
    const [data, total] = await this.billRepo.findAndCount({
      where: { companyId, vendorId: id },
      order: { billDate: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
    return {
      data: {
        data,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
        },
      },
    };
  }

  async payments(companyId: string, id: string, pagination: PaginationParams) {
    await this.getById(companyId, id);
    const [data, total] = await this.paymentRepo.findAndCount({
      where: { companyId, vendorId: id },
      order: { paymentDate: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
    return {
      data: {
        data,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
        },
      },
    };
  }

  /** Period statement: opening + activity + closing (mirrors customers). */
  /**
   * The vendor's account over a period, as the customer statement reads it:
   * bills up — not drafts and not voided ones, which never became owed —
   * payments and vendor credits down. Vendor credits used to be left out and
   * drafts and voids counted, so the balance read higher than the books.
   */
  async statement(
    companyId: string,
    id: string,
    query: { startDate: string; endDate: string },
  ) {
    const vendor = await this.getById(companyId, id);
    const { startDate, endDate } = query;

    const bills = await this.billRepo
      .createQueryBuilder('b')
      .where('b.companyId = :companyId AND b.vendorId = :id', { companyId, id })
      .andWhere("b.status NOT IN ('draft', 'void')")
      .orderBy('b.billDate', 'ASC')
      .addOrderBy('b.billNumber', 'ASC')
      .getMany();
    const payments = await this.paymentRepo
      .createQueryBuilder('p')
      .where('p.companyId = :companyId AND p.vendorId = :id', { companyId, id })
      .orderBy('p.paymentDate', 'ASC')
      .getMany();
    const vendorCredits: Array<{ id: string; vendorCreditNumber: string | null; date: string; total: string; status: string }> =
      await this.billRepo.manager.query(
        `SELECT vc.id, vc.vendor_credit_number AS "vendorCreditNumber", vc.date::text AS date,
                vc.total::numeric AS total, vc.status
           FROM vendor_credits vc
          WHERE vc.company_id = $1 AND vc.vendor_id = $2 AND vc.status <> 'void'
          ORDER BY vc.date ASC, vc.vendor_credit_number ASC`,
        [companyId, id],
      );

    const { opening, closing } = statementBalances(
      [
        ...bills.map((b) => ({ date: b.billDate, amount: toDecimal(b.total) })),
        ...payments.map((p) => ({ date: p.paymentDate, amount: toDecimal(p.totalAmount).negated() })),
        ...vendorCredits.map((c) => ({ date: c.date, amount: toDecimal(c.total).negated() })),
      ],
      startDate,
      endDate,
    );

    const inRangeBills = bills.filter((b) => inPeriod(b.billDate, startDate, endDate));
    const inRangePayments = payments.filter((p) => inPeriod(p.paymentDate, startDate, endDate));
    const inRangeCredits = vendorCredits.filter((c) => inPeriod(c.date, startDate, endDate));
    const sum = (values: Array<string | number>) =>
      values.reduce((acc: ReturnType<typeof toDecimal>, v) => acc.plus(toDecimal(v)), toDecimal(0));

    return {
      vendor: { id: vendor.id, name: vendor.companyName, email: vendor.email },
      period: { startDate, endDate },
      openingBalance: opening.toFixed(4),
      bills: inRangeBills,
      payments: inRangePayments,
      vendorCredits: inRangeCredits.map((c) => ({ ...c, total: toDecimal(c.total).toFixed(4) })),
      totals: {
        billed: sum(inRangeBills.map((b) => b.total)).toFixed(4),
        paid: sum(inRangePayments.map((p) => p.totalAmount)).toFixed(4),
        credited: sum(inRangeCredits.map((c) => c.total)).toFixed(4),
      },
      closingBalance: closing.toFixed(4),
    };
  }
}
