import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { toDecimal } from '../../common/utils/money.util';
import { Vendor } from './entities/vendor.entity';
import { Bill } from '../bills/entities/bill.entity';
import { BillPayment } from '../bills/entities/bill-payment.entity';
import {
  CreateVendorDto,
  ListVendorsQueryDto,
  UpdateVendorDto,
} from './dto/vendor.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';

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
    if (query.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('v.companyName ILIKE :s', { s: `%${query.search}%` })
            .orWhere('v.email ILIKE :s', { s: `%${query.search}%` })
            .orWhere('v.contactPerson ILIKE :s', { s: `%${query.search}%` });
        }),
      );
    }
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
  async statement(
    companyId: string,
    id: string,
    query: { startDate: string; endDate: string },
  ) {
    const vendor = await this.getById(companyId, id);

    const openingBills = await this.billRepo
      .createQueryBuilder('b')
      .select('COALESCE(SUM(b.total), 0)', 'total')
      .where('b.companyId = :companyId AND b.vendorId = :id', { companyId, id })
      .andWhere('b.billDate < :start', { start: query.startDate })
      .getRawOne<{ total: string }>();
    const openingPayments = await this.paymentRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.totalAmount), 0)', 'total')
      .where('p.companyId = :companyId AND p.vendorId = :id', { companyId, id })
      .andWhere('p.paymentDate < :start', { start: query.startDate })
      .getRawOne<{ total: string }>();

    const openingBalance = toDecimal(openingBills?.total ?? 0)
      .minus(toDecimal(openingPayments?.total ?? 0))
      .toFixed(4);

    const bills = await this.billRepo
      .createQueryBuilder('b')
      .where('b.companyId = :companyId AND b.vendorId = :id', { companyId, id })
      .andWhere('b.billDate BETWEEN :start AND :end', { start: query.startDate, end: query.endDate })
      .orderBy('b.billDate', 'ASC')
      .getMany();
    const payments = await this.paymentRepo
      .createQueryBuilder('p')
      .where('p.companyId = :companyId AND p.vendorId = :id', { companyId, id })
      .andWhere('p.paymentDate BETWEEN :start AND :end', { start: query.startDate, end: query.endDate })
      .orderBy('p.paymentDate', 'ASC')
      .getMany();

    const billTotal = bills.reduce((acc, b) => acc.plus(toDecimal(b.total)), toDecimal(0));
    const payTotal = payments.reduce((acc, p) => acc.plus(toDecimal(p.totalAmount)), toDecimal(0));
    const closingBalance = toDecimal(openingBalance).plus(billTotal).minus(payTotal).toFixed(4);

    return {
      vendor: { id: vendor.id, name: vendor.companyName, email: vendor.email },
      period: { startDate: query.startDate, endDate: query.endDate },
      openingBalance,
      bills,
      payments,
      totals: {
        billed: billTotal.toFixed(4),
        paid: payTotal.toFixed(4),
      },
      closingBalance,
    };
  }
}
