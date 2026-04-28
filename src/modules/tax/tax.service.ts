import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaxRate } from './entities/tax-rate.entity';
import { TaxPayment } from './entities/tax-payment.entity';
import { CreateTaxRateDto, UpdateTaxRateDto, CreateTaxPaymentDto } from './dto/tax.dto';

@Injectable()
export class TaxService {
  constructor(
    @InjectRepository(TaxRate) private readonly rateRepo: Repository<TaxRate>,
    @InjectRepository(TaxPayment) private readonly paymentRepo: Repository<TaxPayment>,
  ) {}

  async listRates(companyId: string, page: number, limit: number) {
    const qb = this.rateRepo.createQueryBuilder('r').where('r.companyId = :cid', { cid: companyId });
    qb.orderBy('r.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getRate(companyId: string, id: string) {
    const r = await this.rateRepo.findOne({ where: { id, companyId } });
    if (!r) throw new NotFoundException('Tax rate not found');
    return r;
  }

  async createRate(companyId: string, dto: CreateTaxRateDto) {
    if (dto.isDefault) {
      await this.rateRepo.update({ companyId, isDefault: true }, { isDefault: false });
    }
    const rate = this.rateRepo.create({ ...dto, companyId, isActive: true } as any);
    return this.rateRepo.save(rate);
  }

  async updateRate(companyId: string, id: string, dto: UpdateTaxRateDto) {
    const r = await this.getRate(companyId, id);
    if (dto.isDefault && !r.isDefault) {
      await this.rateRepo.update({ companyId, isDefault: true }, { isDefault: false });
    }
    Object.assign(r, dto);
    return this.rateRepo.save(r);
  }

  async deleteRate(companyId: string, id: string) {
    const r = await this.getRate(companyId, id);
    await this.rateRepo.softRemove(r);
    return { id, deleted: true };
  }

  async listPayments(companyId: string, taxRateId: string | undefined, page: number, limit: number) {
    const qb = this.paymentRepo.createQueryBuilder('p').where('p.companyId = :cid', { cid: companyId });
    if (taxRateId) qb.andWhere('p.taxRateId = :tid', { tid: taxRateId });
    qb.orderBy('p.paymentDate', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async createPayment(companyId: string, dto: CreateTaxPaymentDto) {
    const payment = this.paymentRepo.create({ ...dto, companyId } as any);
    return this.paymentRepo.save(payment);
  }

  async getLiability(companyId: string) {
    const qb = this.paymentRepo.createQueryBuilder('p')
      .where('p.companyId = :cid', { cid: companyId })
      .select('SUM(p.amount)', 'paidAmount');
    
    const result = await qb.getRawOne();
    const paidAmount = parseFloat(result.paidAmount || '0');
    
    // In a real scenario, collectedAmount comes from summing tax on invoices.
    // For now, we mock collectedAmount based on paidAmount + random outstanding.
    const collectedAmount = paidAmount + 5000; 
    const liabilityAmount = collectedAmount - paidAmount;

    return {
      collectedAmount,
      paidAmount,
      liabilityAmount
    };
  }
}
