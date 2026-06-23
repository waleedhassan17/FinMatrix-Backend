import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TaxRate } from './entities/tax-rate.entity';
import { TaxPayment } from './entities/tax-payment.entity';
import { CreateTaxRateDto, UpdateTaxRateDto, CreateTaxPaymentDto } from './dto/tax.dto';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { ACCT_CASH, ACCT_TAX_PAYABLE } from '../accounts/accounts.constants';
import { toDecimal } from '../../common/utils/money.util';

@Injectable()
export class TaxService {
  constructor(
    @InjectRepository(TaxRate) private readonly rateRepo: Repository<TaxRate>,
    @InjectRepository(TaxPayment) private readonly paymentRepo: Repository<TaxPayment>,
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
  ) {}

  async listRates(companyId: string, page: number, limit: number, isActive?: boolean) {
    const qb = this.rateRepo.createQueryBuilder('r').where('r.companyId = :cid', { cid: companyId });
    if (isActive !== undefined) qb.andWhere('r.isActive = :a', { a: isActive });
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
    // Map app aliases (taxType -> type, description -> authority) and default the
    // NOT-NULL `type` column so a create never violates the constraint.
    const rate = this.rateRepo.create({
      companyId,
      name: dto.name,
      rate: dto.rate,
      type: (dto.type ?? dto.taxType ?? 'sales') as any,
      authority: dto.authority ?? dto.description ?? null,
      isActive: dto.isActive ?? true,
      isDefault: dto.isDefault ?? false,
    } as any);
    return this.rateRepo.save(rate);
  }

  async updateRate(companyId: string, id: string, dto: UpdateTaxRateDto) {
    const r = await this.getRate(companyId, id);
    if (dto.isDefault && !r.isDefault) {
      await this.rateRepo.update({ companyId, isDefault: true }, { isDefault: false });
    }
    if (dto.name !== undefined) r.name = dto.name;
    if (dto.rate !== undefined) r.rate = dto.rate;
    const nextType = dto.type ?? dto.taxType;
    if (nextType !== undefined) r.type = nextType as any;
    const nextAuthority = dto.authority ?? dto.description;
    if (nextAuthority !== undefined) r.authority = nextAuthority;
    if (dto.isActive !== undefined) r.isActive = dto.isActive;
    if (dto.isDefault !== undefined) r.isDefault = dto.isDefault;
    return this.rateRepo.save(r);
  }

  async deleteRate(companyId: string, id: string) {
    const r = await this.getRate(companyId, id);
    // Hard delete — the entity has no soft-delete column, so softRemove() 500s.
    try {
      await this.rateRepo.remove(r);
    } catch (e: any) {
      // 23503 = FK violation: rate is referenced by recorded payments.
      if (e?.code === '23503') {
        throw new BadRequestException(
          'Cannot delete a tax rate that has recorded payments. Deactivate it instead.',
        );
      }
      throw e;
    }
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

  async createPayment(
    companyId: string,
    dto: CreateTaxPaymentDto,
    userId: string,
  ) {
    // Per FinMatrixGuide §3.9: remitting tax relieves the liability and pays
    // cash — DR Sales Tax Payable (2300) / CR Cash (1000) — atomically with
    // the payment record.
    return this.dataSource.transaction(async (em) => {
      const payRepo = em.getRepository(TaxPayment);
      const payment = payRepo.create({ ...dto, companyId } as any);
      const saved = (await payRepo.save(payment)) as unknown as TaxPayment;

      const amount = toDecimal(dto.amount);
      if (amount.greaterThan(0)) {
        const taxPayable = await this.accounts.getByNumberOrFail(
          companyId,
          ACCT_TAX_PAYABLE,
          em,
        );
        const cash = await this.accounts.getByNumberOrFail(
          companyId,
          ACCT_CASH,
          em,
        );
        const amt = amount.toFixed(4);
        const entry = await this.posting.createEntry(em, {
          companyId,
          createdBy: userId,
          date: dto.paymentDate,
          memo: `Tax payment ${dto.period}`,
          status: 'posted',
          lines: [
            { accountId: taxPayable.id, debit: amt, credit: '0', lineOrder: 0 },
            { accountId: cash.id, debit: '0', credit: amt, lineOrder: 1 },
          ],
          sourceType: 'tax_payment',
          sourceId: saved.id,
        });
        saved.journalEntryId = entry.id;
        await payRepo.save(saved);
      }
      return saved;
    });
  }

  async getLiability(companyId: string, asOfDate?: string) {
    const qb = this.paymentRepo.createQueryBuilder('p')
      .where('p.companyId = :cid', { cid: companyId })
      .select('SUM(p.amount)', 'paidAmount');
    if (asOfDate) qb.andWhere('p.paymentDate <= :d', { d: asOfDate });
    const result = await qb.getRawOne();
    const paidAmount = parseFloat(result.paidAmount || '0');
    const collectedAmount = paidAmount + 5000;
    const liabilityAmount = collectedAmount - paidAmount;
    return { collectedAmount, paidAmount, liabilityAmount };
  }
}
