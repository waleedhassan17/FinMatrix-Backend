import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { VendorCredit } from './entities/vendor-credit.entity';
import { VendorCreditLine } from './entities/vendor-credit-line.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import {
  ApplyVendorCreditDto,
  CreateVendorCreditDto,
} from './dto/vendor-credit.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import {
  addMoney,
  isPositive,
  subtractMoney,
  toDecimal,
} from '../../common/utils/money.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { BillsService } from '../bills/bills.service';
import { ACCT_AP } from '../accounts/accounts.constants';

@Injectable()
export class VendorCreditsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    private readonly bills: BillsService,
    @InjectRepository(VendorCredit)
    private readonly repo: Repository<VendorCredit>,
    @InjectRepository(Vendor) private readonly vendorRepo: Repository<Vendor>,
  ) {}

  async list(companyId: string, pagination: PaginationParams) {
    const [data, total] = await this.repo.findAndCount({
      where: { companyId },
      relations: { lines: true },
      order: { date: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
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

  async create(
    companyId: string,
    userId: string,
    dto: CreateVendorCreditDto,
  ): Promise<VendorCredit> {
    return this.dataSource.transaction(async (manager) => {
      const vendor = await manager.findOne(Vendor, {
        where: { id: dto.vendorId, companyId },
      });
      if (!vendor) {
        throw new NotFoundException({
          code: 'VENDOR_NOT_FOUND',
          message: 'Vendor not found',
        });
      }

      let total = new Decimal(0);
      const calc = dto.lines.map((l, i) => {
        const amt = toDecimal(l.amount);
        total = total.plus(amt);
        return {
          accountId: l.accountId,
          description: l.description,
          amount: amt.toFixed(4),
          lineOrder: i,
        };
      });

      const credit = manager.create(VendorCredit, {
        companyId,
        vendorId: vendor.id,
        date: dto.date,
        originalBillId: dto.originalBillId ?? null,
        reason: dto.reason ?? null,
        total: total.toFixed(4),
        amountApplied: '0',
        balance: total.toFixed(4),
        journalEntryId: null,
      });
      await manager.save(credit);
      const lines = calc.map((l) =>
        manager.create(VendorCreditLine, { vendorCreditId: credit.id, ...l }),
      );
      await manager.save(lines);
      credit.lines = lines;

      // Journal: DR AP (total), CR each expense account (amount)
      const ap = await this.accounts.getByNumberOrFail(companyId, ACCT_AP, manager);
      const jLines: Array<{
        accountId: string;
        debit: string;
        credit: string;
        lineOrder: number;
      }> = [
        { accountId: ap.id, debit: total.toFixed(4), credit: '0', lineOrder: 0 },
      ];
      calc.forEach((l, i) =>
        jLines.push({
          accountId: l.accountId,
          debit: '0',
          credit: l.amount,
          lineOrder: i + 1,
        }),
      );

      const entry = await this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: dto.date,
        memo: `Vendor credit for ${vendor.companyName}`,
        status: 'posted',
        sourceType: 'vendor_credit',
        sourceId: credit.id,
        lines: jLines,
      });
      credit.journalEntryId = entry.id;
      await manager.save(credit);

      vendor.balance = subtractMoney(vendor.balance, total).toFixed(4);
      await manager.save(vendor);

      return credit;
    });
  }

  async apply(
    companyId: string,
    creditId: string,
    dto: ApplyVendorCreditDto,
  ): Promise<VendorCredit> {
    return this.dataSource.transaction(async (manager) => {
      const credit = await manager.findOne(VendorCredit, {
        where: { id: creditId, companyId },
      });
      if (!credit) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Vendor credit not found',
        });
      }
      const amt = toDecimal(dto.amount);
      if (!isPositive(amt)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Amount must be positive',
        });
      }
      if (amt.greaterThan(toDecimal(credit.balance))) {
        throw new BadRequestException({
          code: 'PAYMENT_EXCEEDS_BALANCE',
          message: `Amount (${amt.toFixed(4)}) exceeds credit balance (${credit.balance})`,
        });
      }
      await this.bills.applyCredit(manager, companyId, dto.billId, amt.toFixed(4));
      credit.amountApplied = addMoney(credit.amountApplied, amt).toFixed(4);
      credit.balance = subtractMoney(credit.total, credit.amountApplied).toFixed(4);
      await manager.save(credit);
      return credit;
    });
  }
}
