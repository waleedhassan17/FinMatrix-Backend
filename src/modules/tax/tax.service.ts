import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TaxRate } from './entities/tax-rate.entity';
import { TaxPayment } from './entities/tax-payment.entity';
import { CreateTaxRateDto, UpdateTaxRateDto, CreateTaxPaymentDto } from './dto/tax.dto';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { ACCT_CASH, ACCT_TAX_PAYABLE, ACCT_INPUT_TAX } from '../accounts/accounts.constants';
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

  /**
   * Tax liability report — ledger-derived (FinMatrix.md §21). Net tax owed =
   * output tax (Sales Tax Payable 2300 collected) − input tax recoverable
   * (Sales Tax Recoverable 1300, registered businesses) − tax already remitted.
   * For a non-registered business there is no input tax, so net = output − paid.
   */
  async getLiability(companyId: string, startDate?: string, endDate?: string) {
    const r2 = (v: any) => Math.round((parseFloat(v ?? '0') || 0) * 100) / 100;
    const start = startDate || '1970-01-01';
    const end = endDate || new Date().toISOString().slice(0, 10);

    // Output tax (Sales Tax Payable 2300): credits = collected, debits = remitted.
    const [out] = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.credit::numeric), 0) AS collected,
              COALESCE(SUM(g.debit::numeric), 0)  AS remitted
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.account_number = $2
          AND g.date >= $3 AND g.date <= $4`,
      [companyId, ACCT_TAX_PAYABLE, start, end],
    );

    // Input tax recoverable (1300): net debit = recoverable (registered only).
    const [inp] = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit::numeric), 0) - COALESCE(SUM(g.credit::numeric), 0) AS recoverable
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.account_number = $2
          AND g.date >= $3 AND g.date <= $4`,
      [companyId, ACCT_INPUT_TAX, start, end],
    );

    const outputCollected = r2(out?.collected);
    const remitted = r2(out?.remitted);
    const inputRecoverable = r2(inp?.recoverable);

    const rows: Array<{
      taxRateId: string;
      taxName: string;
      taxType: string;
      rate: number;
      collected: number;
      paid: number;
      net: number;
    }> = [
      {
        taxRateId: 'output-tax',
        taxName: 'Output Tax (Sales)',
        taxType: 'sales',
        rate: 0,
        collected: outputCollected,
        paid: remitted,
        net: r2(outputCollected - remitted),
      },
    ];
    if (inputRecoverable !== 0) {
      // Input tax reduces what you remit → shown as a negative (credit) net.
      rows.push({
        taxRateId: 'input-tax',
        taxName: 'Input Tax Credit (recoverable)',
        taxType: 'input',
        rate: 0,
        collected: 0,
        paid: 0,
        net: r2(-inputRecoverable),
      });
    }

    const totalNet = r2(outputCollected - remitted - inputRecoverable);
    return {
      fromDate: start,
      toDate: end,
      rows,
      totalCollected: outputCollected,
      totalPaid: remitted,
      totalNet,
      // Explicit breakdown for clarity / API consumers.
      outputTax: outputCollected,
      inputTaxRecoverable: inputRecoverable,
      taxRemitted: remitted,
      // Backwards-compatible scalar fields (legacy shape).
      collectedAmount: outputCollected,
      paidAmount: remitted,
      liabilityAmount: totalNet,
    };
  }
}
