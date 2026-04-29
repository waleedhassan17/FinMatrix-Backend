import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
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
      data,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
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
    await this.repo.softRemove(v);
    return { id, deleted: true };
  }

  async toggleActive(companyId: string, id: string) {
    const v = await this.getById(companyId, id);
    v.isActive = !v.isActive;
    return this.repo.save(v);
  }

  async bills(companyId: string, id: string) {
    await this.getById(companyId, id);
    return this.billRepo.find({
      where: { companyId, vendorId: id },
      order: { billDate: 'DESC' },
    });
  }

  async payments(companyId: string, id: string) {
    await this.getById(companyId, id);
    return this.paymentRepo.find({
      where: { companyId, vendorId: id },
      order: { paymentDate: 'DESC' },
    });
  }
}
