import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Invoice, DiscountType } from './entities/invoice.entity';
import { InvoiceLineItem } from './entities/invoice-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import {
  CreateInvoiceDto,
  InvoiceLineDto,
  ListInvoicesQueryDto,
  UpdateInvoiceDto,
  VoidInvoiceDto,
} from './dto/invoice.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import {
  addMoney,
  isPositive,
  subtractMoney,
  toDecimal,
  toMoneyString,
} from '../../common/utils/money.util';
import { formatInvoiceRef } from '../../common/utils/reference-generator.util';
import { nextYearlySequence } from '../../common/utils/sequence.util';
import { PostingService } from '../journal-entries/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import {
  ACCT_AR,
  ACCT_SALES_REVENUE,
  ACCT_TAX_PAYABLE,
} from '../accounts/accounts.constants';
import { InvoiceStatus } from '../../types';

interface LineCalc {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  baseAmount: string;
  accountId: string | null;
  lineOrder: number;
}

interface InvoiceTotals {
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  lines: LineCalc[];
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    private readonly accounts: AccountsService,
    @InjectRepository(Invoice)
    private readonly repo: Repository<Invoice>,
    @InjectRepository(InvoiceLineItem)
    private readonly lineRepo: Repository<InvoiceLineItem>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
  ) {}

  // ------- Query -------

  async list(
    companyId: string,
    query: ListInvoicesQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('i')
      .where('i.companyId = :companyId', { companyId });
    if (query.status) qb.andWhere('i.status = :s', { s: query.status });
    if (query.customerId) qb.andWhere('i.customerId = :c', { c: query.customerId });
    if (query.startDate && query.endDate) {
      qb.andWhere('i.invoiceDate BETWEEN :s AND :e', {
        s: query.startDate,
        e: query.endDate,
      });
    }
    if (query.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('i.invoiceNumber ILIKE :s', { s: `%${query.search}%` }).orWhere(
            'i.notes ILIKE :s',
            { s: `%${query.search}%` },
          );
        }),
      );
    }
    qb.orderBy('i.invoiceDate', 'DESC').addOrderBy('i.createdAt', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();

    const statusCounts = await this.repo
      .createQueryBuilder('i')
      .select('i.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(i.total), 0)', 'total')
      .where('i.companyId = :companyId', { companyId })
      .groupBy('i.status')
      .getRawMany<{ status: string; count: string; total: string }>();

    return {
      data,
      summary: Object.fromEntries(
        statusCounts.map((r) => [
          r.status,
          { count: parseInt(r.count, 10), total: toDecimal(r.total).toFixed(4) },
        ]),
      ),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string): Promise<Invoice> {
    const inv = await this.repo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!inv) {
      throw new NotFoundException({
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }
    inv.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return inv;
  }

  async outstandingForCustomer(
    companyId: string,
    customerId: string,
  ): Promise<Invoice[]> {
    return this.repo
      .createQueryBuilder('i')
      .where('i.companyId = :companyId', { companyId })
      .andWhere('i.customerId = :c', { c: customerId })
      .andWhere('i.balance > 0')
      .andWhere("i.status NOT IN ('draft', 'void')")
      .orderBy('i.dueDate', 'ASC')
      .getMany();
  }

  // ------- Create / update -------

  async create(
    companyId: string,
    userId: string,
    dto: CreateInvoiceDto,
  ): Promise<Invoice> {
    return this.dataSource.transaction(async (manager) => {
      const customer = await manager.findOne(Customer, {
        where: { id: dto.customerId, companyId },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'CUSTOMER_NOT_FOUND',
          message: 'Customer not found',
        });
      }

      const totals = this.computeTotals(dto.lines, dto.discountType, dto.discountValue);

      const year = parseInt(dto.invoiceDate.slice(0, 4), 10);
      const seq = await nextYearlySequence(
        manager,
        'invoices',
        companyId,
        year,
        'invoice_date',
        'INV',
        'invoice_number',
      );
      const invoiceNumber = formatInvoiceRef(year, seq);

      const status: InvoiceStatus = dto.status ?? 'draft';

      const invoice = manager.create(Invoice, {
        companyId,
        customerId: dto.customerId,
        invoiceNumber,
        invoiceDate: dto.invoiceDate,
        dueDate: dto.dueDate,
        subtotal: totals.subtotal,
        discountType: (dto.discountType ?? 'none') as DiscountType,
        discountValue: dto.discountValue ?? '0',
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        amountPaid: '0',
        balance: totals.total,
        status,
        paymentTerms: dto.paymentTerms ?? customer.paymentTerms,
        notes: dto.notes ?? null,
        journalEntryId: null,
        createdBy: userId,
      });
      await manager.save(invoice);

      const lines = totals.lines.map((l) =>
        manager.create(InvoiceLineItem, {
          invoiceId: invoice.id,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          taxAmount: l.taxAmount,
          lineTotal: l.lineTotal,
          accountId: l.accountId,
          lineOrder: l.lineOrder,
        }),
      );
      await manager.save(lines);
      invoice.lines = lines;

      if (status !== 'draft') {
        await this.createJournalEntryForInvoice(manager, invoice, userId);
        await this.incrementCustomerBalance(manager, customer, invoice.total);
      }

      return invoice;
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateInvoiceDto,
  ): Promise<Invoice> {
    return this.dataSource.transaction(async (manager) => {
      const invoice = await manager.findOne(Invoice, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!invoice) {
        throw new NotFoundException({
          code: 'INVOICE_NOT_FOUND',
          message: 'Invoice not found',
        });
      }
      if (invoice.status !== 'draft') {
        throw new BadRequestException({
          code: 'CANNOT_EDIT_POSTED',
          message: 'Only draft invoices can be edited',
        });
      }

      if (dto.invoiceDate !== undefined) invoice.invoiceDate = dto.invoiceDate;
      if (dto.dueDate !== undefined) invoice.dueDate = dto.dueDate;
      if (dto.notes !== undefined) invoice.notes = dto.notes;

      if (dto.lines || dto.discountType !== undefined || dto.discountValue !== undefined) {
        const nextLines = dto.lines ?? invoice.lines.map<InvoiceLineDto>((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          accountId: l.accountId ?? undefined,
        }));
        const dType = dto.discountType ?? invoice.discountType;
        const dValue = dto.discountValue ?? invoice.discountValue;
        const totals = this.computeTotals(nextLines, dType, dValue);
        invoice.discountType = dType;
        invoice.discountValue = dValue;
        invoice.discountAmount = totals.discountAmount;
        invoice.taxAmount = totals.taxAmount;
        invoice.subtotal = totals.subtotal;
        invoice.total = totals.total;
        invoice.balance = totals.total;

        if (dto.lines) {
          await manager.delete(InvoiceLineItem, { invoiceId: invoice.id });
          const newLines = totals.lines.map((l) =>
            manager.create(InvoiceLineItem, {
              invoiceId: invoice.id,
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              taxRate: l.taxRate,
              taxAmount: l.taxAmount,
              lineTotal: l.lineTotal,
              accountId: l.accountId,
              lineOrder: l.lineOrder,
            }),
          );
          await manager.save(newLines);
        }
      }

      await manager.save(invoice);
      const refreshed = await manager.findOne(Invoice, {
        where: { id, companyId },
        relations: { lines: true },
      });
      return refreshed!;
    });
  }

  async send(companyId: string, id: string, userId: string): Promise<Invoice> {
    return this.dataSource.transaction(async (manager) => {
      const invoice = await manager.findOne(Invoice, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!invoice) {
        throw new NotFoundException({
          code: 'INVOICE_NOT_FOUND',
          message: 'Invoice not found',
        });
      }
      if (invoice.status === 'void') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Voided invoices cannot be sent',
        });
      }

      if (!invoice.journalEntryId) {
        await this.createJournalEntryForInvoice(manager, invoice, userId);
        const customer = await manager.findOneBy(Customer, {
          id: invoice.customerId,
          companyId,
        });
        if (customer) {
          await this.incrementCustomerBalance(manager, customer, invoice.total);
        }
      }

      if (invoice.status === 'draft') invoice.status = 'sent';
      await manager.save(invoice);
      return invoice;
    });
  }

  async void(
    companyId: string,
    id: string,
    userId: string,
    dto: VoidInvoiceDto,
  ): Promise<Invoice> {
    return this.dataSource.transaction(async (manager) => {
      const invoice = await manager.findOne(Invoice, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!invoice) {
        throw new NotFoundException({
          code: 'INVOICE_NOT_FOUND',
          message: 'Invoice not found',
        });
      }
      if (isPositive(invoice.amountPaid)) {
        throw new BadRequestException({
          code: 'INVOICE_ALREADY_PAID',
          message: 'Cannot void an invoice that already has payments',
        });
      }

      if (invoice.journalEntryId) {
        // Create reversing entry
        const ar = await this.accounts.getByNumberOrFail(companyId, ACCT_AR, manager);
        const rev = await this.accounts.getByNumberOrFail(
          companyId,
          ACCT_SALES_REVENUE,
          manager,
        );
        const tax = await this.accounts.getByNumberOrFail(
          companyId,
          ACCT_TAX_PAYABLE,
          manager,
        );
        const lines = [
          { accountId: ar.id, debit: '0', credit: invoice.total },
          {
            accountId: rev.id,
            debit: toDecimal(invoice.subtotal)
              .minus(toDecimal(invoice.discountAmount))
              .toFixed(4),
            credit: '0',
          },
          { accountId: tax.id, debit: invoice.taxAmount, credit: '0' },
        ];
        await this.posting.createEntry(manager, {
          companyId,
          createdBy: userId,
          date: new Date().toISOString().slice(0, 10),
          memo: `Void invoice ${invoice.invoiceNumber}: ${dto.reason}`,
          status: 'posted',
          lines: lines.map((l, i) => ({ ...l, lineOrder: i })),
          reversalOfId: invoice.journalEntryId,
        });

        const customer = await manager.findOneBy(Customer, {
          id: invoice.customerId,
          companyId,
        });
        if (customer) {
          await this.incrementCustomerBalance(
            manager,
            customer,
            toDecimal(invoice.total).negated().toFixed(4),
          );
        }
      }

      invoice.status = 'void';
      invoice.notes = invoice.notes
        ? `${invoice.notes}\n[VOID] ${dto.reason}`
        : `[VOID] ${dto.reason}`;
      await manager.save(invoice);
      return invoice;
    });
  }

  // ------- Payment hook (called by payments module) -------

  async applyPayment(
    manager: EntityManager,
    companyId: string,
    invoiceId: string,
    amount: string,
  ): Promise<Invoice> {
    const invoice = await manager.findOne(Invoice, {
      where: { id: invoiceId, companyId },
    });
    if (!invoice) {
      throw new NotFoundException({
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }
    if (invoice.status === 'void' || invoice.status === 'draft') {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `Cannot apply payment to ${invoice.status} invoice`,
      });
    }
    const amt = toDecimal(amount);
    if (amt.greaterThan(toDecimal(invoice.balance))) {
      throw new BadRequestException({
        code: 'PAYMENT_EXCEEDS_BALANCE',
        message: `Payment amount (${amt.toFixed(4)}) exceeds invoice balance (${invoice.balance})`,
      });
    }
    invoice.amountPaid = addMoney(invoice.amountPaid, amt).toFixed(4);
    invoice.balance = subtractMoney(invoice.total, invoice.amountPaid).toFixed(4);

    const today = new Date().toISOString().slice(0, 10);
    if (toDecimal(invoice.amountPaid).greaterThanOrEqualTo(toDecimal(invoice.total))) {
      invoice.status = 'paid';
    } else if (invoice.dueDate < today) {
      invoice.status = 'overdue';
    } else {
      invoice.status = 'partial';
    }
    await manager.save(invoice);
    return invoice;
  }

  // ------- Helpers -------

  private computeTotals(
    lines: InvoiceLineDto[],
    discountType: 'percent' | 'amount' | 'none' | undefined,
    discountValue: string | undefined,
  ): InvoiceTotals {
    const calc: LineCalc[] = [];
    let subtotal = new Decimal(0);
    let taxTotal = new Decimal(0);

    lines.forEach((l, i) => {
      const qty = toDecimal(l.quantity);
      const price = toDecimal(l.unitPrice);
      const taxRate = toDecimal(l.taxRate ?? '0');
      const base = qty.times(price);
      const tax = base.times(taxRate).dividedBy(100);
      const lineTotal = base.plus(tax);
      subtotal = subtotal.plus(base);
      taxTotal = taxTotal.plus(tax);
      calc.push({
        description: l.description,
        quantity: qty.toFixed(4),
        unitPrice: price.toFixed(4),
        taxRate: taxRate.toFixed(4),
        taxAmount: tax.toFixed(4),
        lineTotal: lineTotal.toFixed(4),
        baseAmount: base.toFixed(4),
        accountId: l.accountId ?? null,
        lineOrder: i,
      });
    });

    let discountAmount = new Decimal(0);
    if (discountType === 'percent') {
      discountAmount = subtotal.times(toDecimal(discountValue ?? 0)).dividedBy(100);
    } else if (discountType === 'amount') {
      discountAmount = toDecimal(discountValue ?? 0);
    }
    if (discountAmount.greaterThan(subtotal)) discountAmount = subtotal;

    const total = subtotal.minus(discountAmount).plus(taxTotal);
    return {
      subtotal: subtotal.toFixed(4),
      discountAmount: discountAmount.toFixed(4),
      taxAmount: taxTotal.toFixed(4),
      total: total.toFixed(4),
      lines: calc,
    };
  }

  private async createJournalEntryForInvoice(
    manager: EntityManager,
    invoice: Invoice,
    userId: string,
  ): Promise<void> {
    const ar = await this.accounts.getByNumberOrFail(invoice.companyId, ACCT_AR, manager);
    const revenue = await this.accounts.getByNumberOrFail(
      invoice.companyId,
      ACCT_SALES_REVENUE,
      manager,
    );
    const tax = await this.accounts.getByNumberOrFail(
      invoice.companyId,
      ACCT_TAX_PAYABLE,
      manager,
    );
    const revenueNet = toDecimal(invoice.subtotal).minus(toDecimal(invoice.discountAmount));

    const lines = [
      {
        accountId: ar.id,
        description: `Invoice ${invoice.invoiceNumber}`,
        debit: invoice.total,
        credit: '0',
        lineOrder: 0,
      },
      {
        accountId: revenue.id,
        description: 'Sales revenue',
        debit: '0',
        credit: revenueNet.toFixed(4),
        lineOrder: 1,
      },
    ];
    if (toDecimal(invoice.taxAmount).greaterThan(0)) {
      lines.push({
        accountId: tax.id,
        description: 'Sales tax',
        debit: '0',
        credit: invoice.taxAmount,
        lineOrder: 2,
      });
    }

    const entry = await this.posting.createEntry(manager, {
      companyId: invoice.companyId,
      createdBy: userId,
      date: invoice.invoiceDate,
      memo: `Invoice ${invoice.invoiceNumber}`,
      status: 'posted',
      lines,
      sourceType: 'invoice',
      sourceId: invoice.id,
    });
    invoice.journalEntryId = entry.id;
    await manager.save(invoice);
  }

  private async incrementCustomerBalance(
    manager: EntityManager,
    customer: Customer,
    delta: string,
  ): Promise<void> {
    customer.balance = addMoney(customer.balance, delta).toFixed(4);
    await manager.save(customer);
  }
}
