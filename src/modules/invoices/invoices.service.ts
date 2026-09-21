import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Invoice, DiscountType } from './entities/invoice.entity';
import { InvoiceLineItem } from './entities/invoice-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
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
import { assertSufficientStock } from '../../common/utils/stock.util';
import { recordInventoryMovement } from '../../common/utils/inventory-movement.util';
import { nextDocumentNumber, yearOf } from '../../common/utils/sequence.util';
import { applyTextSearch } from '../../common/utils/search-query.util';
import { PostingService } from '../journal-entries/posting.service';
import { JournalEntryLine } from '../journal-entries/entities/journal-entry-line.entity';
import { AccountsService } from '../accounts/accounts.service';
import {
  ACCT_AR,
  ACCT_COGS,
  ACCT_INVENTORY,
  ACCT_SALES_REVENUE,
  ACCT_TAX_PAYABLE,
} from '../accounts/accounts.constants';
import { InvoiceStatus } from '../../types';
import { businessToday } from '../../common/utils/business-date.util';
import { assertSalesLinesClassified } from '../../common/utils/sales-lines.util';
import { CreditOverride, enforceCreditLimit } from '../../common/utils/credit-control.util';

interface LineCalc {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  baseAmount: string;
  accountId: string | null;
  itemId: string | null;
  lineOrder: number;
}

/** Options for invoices raised by the system rather than typed by a user. */
export interface CreateInvoiceOptions {
  /** Approving a request filed before lines had to be classified. */
  treatFreeTextAsService?: boolean;
  credit?: {
    /** A delivery's invoice: its credit was checked when it was dispatched. */
    skip?: boolean;
    /** Converting a sales order: its shipped value is already in exposure. */
    excludeSalesOrderId?: string | null;
    override?: CreditOverride | null;
  };
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
      // Named apart from the status's `:s`: one name holds one value per query.
      qb.andWhere('i.invoiceDate BETWEEN :startDate AND :endDate', {
        startDate: query.startDate,
        endDate: query.endDate,
      });
    }
    applyTextSearch(qb, query.search, companyId, {
      columns: ['i.invoiceNumber', 'i.notes'],
      customerColumn: 'i.customerId',
    });
    qb.orderBy('i.invoiceDate', 'DESC').addOrderBy('i.createdAt', 'DESC');
    qb.take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();

    // Batch-load customer names
    const customerIds = [...new Set(data.map((i) => i.customerId).filter(Boolean))];
    const customers = customerIds.length
      ? await this.customerRepo.findByIds(customerIds)
      : [];
    const customerNameMap = Object.fromEntries(customers.map((c) => [c.id, c.name]));

    const statusCounts = await this.repo
      .createQueryBuilder('i')
      .select('i.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(i.total), 0)', 'total')
      .where('i.companyId = :companyId', { companyId })
      .groupBy('i.status')
      .getRawMany<{ status: string; count: string; total: string }>();

    return {
      data: data.map((i) => ({ ...i, customerName: customerNameMap[i.customerId] ?? '' })),
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

    // The list endpoint above decorates every row with customerName from its
    // customerNameMap; this one never did, so the two disagreed about the shape
    // of an invoice and the app's Bill To read blank on every single one. One
    // row rather than a batch, but the contract has to match.
    const customer = inv.customerId
      ? await this.customerRepo.findOne({
          where: { id: inv.customerId, companyId },
        })
      : null;
    return { ...inv, customerName: customer?.name ?? '' } as Invoice;
  }

  /** Check an invoice's lines without creating anything (a staff request is filed only if they pass). */
  async assertLinesValid(companyId: string, lines: InvoiceLineDto[]): Promise<void> {
    await assertSalesLinesClassified(this.dataSource.manager, companyId, lines);
  }

  async outstandingForCustomer(
    companyId: string,
    customerId: string,
    manager?: EntityManager,
  ): Promise<Invoice[]> {
    // Read through the caller's transaction when there is one, so an invoice
    // created earlier in the same transaction is visible to the sweep.
    const repo = manager ? manager.getRepository(Invoice) : this.repo;
    return repo
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
    opts: CreateInvoiceOptions = {},
  ): Promise<Invoice> {
    return this.dataSource.transaction(async (manager) =>
      this.createInTransaction(manager, companyId, userId, dto, opts),
    );
  }

  /**
   * Transaction-aware variant of create(): lets a caller that already holds a
   * transaction (delivery Stage-1 prepaid / Stage-3 approval) create + post the
   * invoice atomically with its stock movement. Same logic, same postings.
   */
  async createInTransaction(
    manager: EntityManager,
    companyId: string,
    userId: string,
    dto: CreateInvoiceDto,
    opts: CreateInvoiceOptions = {},
  ): Promise<Invoice> {
    {
      const customer = await manager.findOne(Customer, {
        where: { id: dto.customerId, companyId },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'CUSTOMER_NOT_FOUND',
          message: 'Customer not found',
        });
      }
      await assertSalesLinesClassified(manager, companyId, dto.lines, {
        treatFreeTextAsService: opts.treatFreeTextAsService,
      });

      const totals = this.computeTotals(dto.lines, dto.discountType, dto.discountValue);

      const invoiceNumber = await nextDocumentNumber(
        manager,
        companyId,
        'INV',
        yearOf(dto.invoiceDate),
      );

      const status: InvoiceStatus = dto.status ?? 'draft';
      // An invoice that posts is where the customer's debt becomes real.
      if (status !== 'draft' && !opts.credit?.skip) {
        await enforceCreditLimit(manager, companyId, dto.customerId, totals.total, {
          action: 'invoice',
          targetType: 'customer',
          targetId: dto.customerId,
          excludeSalesOrderId: opts.credit?.excludeSalesOrderId,
          override: opts.credit?.override,
        });
      }

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
          itemId: l.itemId,
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
    }
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

      if (dto.lines) await assertSalesLinesClassified(manager, companyId, dto.lines);

      if (dto.lines || dto.discountType !== undefined || dto.discountValue !== undefined) {
        const nextLines = dto.lines ?? invoice.lines.map<InvoiceLineDto>((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          accountId: l.accountId ?? undefined,
          itemId: l.itemId ?? undefined,
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
              itemId: l.itemId,
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

  async send(
    companyId: string,
    id: string,
    userId: string,
    opts: { creditOverride?: CreditOverride | null } = {},
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
      if (invoice.status === 'void') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Voided invoices cannot be sent',
        });
      }

      if (!invoice.journalEntryId) {
        await enforceCreditLimit(manager, companyId, invoice.customerId, invoice.total, {
          action: 'invoice_send',
          targetType: 'invoice',
          targetId: invoice.id,
          override: opts.creditOverride,
        });
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
        const lines: {
          accountId: string;
          debit: string;
          credit: string;
        }[] = [
          { accountId: ar.id, debit: '0', credit: invoice.total },
          {
            accountId: rev.id,
            debit: toDecimal(invoice.subtotal)
              .minus(toDecimal(invoice.discountAmount))
              .toFixed(4),
            credit: '0',
          },
        ];
        // Only include the tax line when there is tax — a zero/zero line is
        // rejected by the posting engine (was a latent bug for tax-free invoices).
        if (toDecimal(invoice.taxAmount).greaterThan(0)) {
          lines.push({ accountId: tax.id, debit: invoice.taxAmount, credit: '0' });
        }

        // Reverse the cost side and restock (FinMatrixGuide §3.13): COGS↓,
        // Inventory↑, quantity on hand restored.
        const cogsTotal = await this.postInvoiceCogs(manager, invoice, userId, true);
        if (cogsTotal.greaterThan(0)) {
          const cogs = await this.accounts.getByNumberOrFail(companyId, ACCT_COGS, manager);
          const inventory = await this.accounts.getByNumberOrFail(
            companyId,
            ACCT_INVENTORY,
            manager,
          );
          lines.push({ accountId: cogs.id, debit: '0', credit: cogsTotal.toFixed(4) });
          lines.push({ accountId: inventory.id, debit: cogsTotal.toFixed(4), credit: '0' });
        }

        await this.posting.createEntry(manager, {
          companyId,
          createdBy: userId,
          date: businessToday(),
          memo: `Void invoice ${invoice.invoiceNumber}: ${dto.reason}`,
          status: 'posted',
          lines: lines.map((l, i) => ({ ...l, lineOrder: i })),
          sourceType: 'invoice_void',
          sourceId: invoice.id,
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

  /**
   * Delete an invoice. Reverses its ledger impact with a mirror journal entry
   * (swap Dr/Cr of the original — covers AR/Revenue/Tax and COGS/Inventory),
   * restocks item-linked lines, restores the customer balance, then hard-
   * removes the record. (The entity has no @DeleteDateColumn, so softRemove was
   * a no-op that 500'd.) Already-void invoices were reversed at void time, so
   * they are just removed. Invoices with payments must be handled first.
   */
  async delete(companyId: string, id: string, userId: string) {
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
          code: 'INVOICE_HAS_PAYMENTS',
          message: 'Cannot delete an invoice that has payments. Remove the payments first.',
        });
      }

      // A voided invoice was already reversed (GL, inventory, customer balance)
      // — don't reverse it again; just drop the record.
      if (invoice.status !== 'void' && invoice.journalEntryId) {
        const origLines = await manager.find(JournalEntryLine, {
          where: { entryId: invoice.journalEntryId },
          order: { lineOrder: 'ASC' },
        });
        if (origLines.length > 0) {
          await this.posting.createEntry(manager, {
            companyId,
            createdBy: userId,
            date: businessToday(),
            memo: `Delete invoice ${invoice.invoiceNumber}`,
            status: 'posted',
            sourceType: 'invoice_void',
            sourceId: invoice.id,
            reversalOfId: invoice.journalEntryId,
            lines: origLines.map((l, i) => ({
              accountId: l.accountId,
              description: l.description ?? undefined,
              debit: l.credit,
              credit: l.debit,
              lineOrder: i,
            })),
          });
        }

        // Restock inventory physically (the GL cost side is already reversed by
        // the mirror entry above, so we ignore the returned cost total).
        await this.postInvoiceCogs(manager, invoice, userId, true);

        // Invoice creation increased the customer balance by its total; undo it.
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

      await manager.remove(invoice); // hard remove (cascades lines)
      return { id, deleted: true };
    });
  }

  // ------- Payment hook (called by payments module) -------

  async applyPayment(
    manager: EntityManager,
    companyId: string,
    invoiceId: string,
    amount: string,
  ): Promise<Invoice> {
    // Lock the invoice row (SELECT ... FOR UPDATE) so concurrent payment
    // applications cannot both read the same balance and over-apply (M1).
    const invoice = await manager.findOne(Invoice, {
      where: { id: invoiceId, companyId },
      lock: { mode: 'pessimistic_write' },
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

    const today = businessToday();
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
        itemId: l.itemId ?? null,
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
    // A zero-total invoice cannot be posted: its A/R line would carry neither a
    // debit nor a credit, which the posting engine rejects — as does the
    // chk_line_shape constraint underneath it. Both report the broken LINE,
    // leaving the caller to work backwards to the empty invoice that caused it.
    // Say so here instead, while we still know what the real problem is.
    if (toDecimal(invoice.total).lte(0)) {
      throw new BadRequestException({
        code: 'INVOICE_ZERO_TOTAL',
        message:
          'Invoice total is zero — add a line with a price before posting it to the books.',
      });
    }

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

    // Cost entry (FinMatrixGuide §3.1): for each line linked to an inventory
    // item, recognise COGS at the item's unit cost, relieve Inventory, reduce
    // quantity on hand and record an inventory movement — all in this same
    // transaction. Lines with no itemId (free-text/service lines) post no cost.
    const cogsTotal = await this.postInvoiceCogs(manager, invoice, userId, false);
    if (cogsTotal.greaterThan(0)) {
      const cogs = await this.accounts.getByNumberOrFail(
        invoice.companyId,
        ACCT_COGS,
        manager,
      );
      const inventory = await this.accounts.getByNumberOrFail(
        invoice.companyId,
        ACCT_INVENTORY,
        manager,
      );
      lines.push({
        accountId: cogs.id,
        description: 'Cost of goods sold',
        debit: cogsTotal.toFixed(4),
        credit: '0',
        lineOrder: lines.length,
      });
      lines.push({
        accountId: inventory.id,
        description: 'Inventory relieved',
        debit: '0',
        credit: cogsTotal.toFixed(4),
        lineOrder: lines.length,
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

  /**
   * Apply (or reverse) the inventory side of an invoice: relieve/restore stock
   * for each item-linked line and record movements. Returns the total cost
   * value moved, used to build the COGS/Inventory journal lines.
   *
   * @param reverse false on issue (qty↓, COGS recognised); true on void
   *                (qty↑, COGS reversed).
   */
  private async postInvoiceCogs(
    manager: EntityManager,
    invoice: Invoice,
    userId: string,
    reverse: boolean,
  ): Promise<Decimal> {
    const itemRepo = manager.getRepository(InventoryItem);
    let total = new Decimal(0);

    // The cost columns are `select: false` — they must not ride along on the
    // six read paths that hand invoice lines to the client — so a relation
    // load leaves them undefined. Fetched explicitly here, which is the one
    // place that needs them, and only on a void: a fresh posting is computing
    // the cost, not reading it back.
    const frozenCosts = new Map<string, Decimal>();
    if (reverse && invoice.lines?.length) {
      const rows = await manager
        .getRepository(InvoiceLineItem)
        .createQueryBuilder('l')
        .select('l.id', 'id')
        .addSelect('l.cost_amount', 'costAmount')
        .where('l.invoice_id = :invoiceId', { invoiceId: invoice.id })
        .getRawMany<{ id: string; costAmount: string | null }>();
      for (const r of rows) {
        if (r.costAmount !== null && r.costAmount !== undefined) {
          frozenCosts.set(r.id, toDecimal(r.costAmount));
        }
      }
    }

    for (const line of invoice.lines ?? []) {
      if (!line.itemId) continue;
      const item = await itemRepo.findOne({
        where: { id: line.itemId, companyId: invoice.companyId },
      });
      if (!item) continue;
      const qty = toDecimal(line.quantity);
      // On a VOID, unwind what this line actually cost when it was sold, not
      // what the item costs today. A purchase between the sale and the void
      // re-averages the item, and a reversal a different size from the original
      // leaves residue in 5000/1200 forever. `cost_amount` is frozen on the
      // line at posting precisely so this can be exact — the same reason
      // delivery_items.unit_cost and credit_memo_lines.restock_unit_cost exist.
      //
      // The fallback is for lines posted before that column existed. It is
      // nearly dead code: the `moved === 0` guard below skips a line that never
      // moved stock, which is the same condition as having no cost recorded.
      const frozen = frozenCosts.get(line.id) ?? null;
      const cost = reverse && frozen !== null ? frozen : qty.times(toDecimal(item.unitCost));
      if (reverse) {
        // Only put back what this invoice actually took off the shelf. Items
        // with no cost used to be skipped entirely when sold (see below), so an
        // older invoice may have moved nothing to reverse.
        const moved = await manager.getRepository(InventoryMovement).count({
          where: { companyId: invoice.companyId, itemId: item.id, sourceType: 'invoice', sourceId: invoice.id },
        });
        if (moved === 0) continue;
      }
      // A zero-cost item still leaves the shelf. It used to `continue` here,
      // which skipped the stock check and the stock movement as well as the
      // (zero) COGS — so an item with no recorded cost could be sold without
      // any stock at all.
      total = total.plus(Decimal.max(cost, 0));

      const onHand = toDecimal(item.quantityOnHand);
      // Selling more than is on the shelf would drive stock negative and trip
      // chk_no_negative_stock as a raw 500 — refuse it cleanly first (I11).
      if (!reverse) assertSufficientStock(item.name, onHand, qty);
      const newQty = reverse ? onHand.plus(qty) : onHand.minus(qty);
      item.quantityOnHand = newQty.toFixed(4);
      await itemRepo.save(item);

      // Freeze what this line cost, on the way out.
      //
      // The figure was always computed here and then thrown away — only the
      // per-invoice sum survived, as one aggregate COGS line. Keeping it per
      // line is what makes gross margin per item answerable at all, and it is
      // what lets a void reverse exactly (see `frozen` above).
      if (!reverse) {
        line.unitCost = toDecimal(item.unitCost).toFixed(4);
        line.costAmount = cost.toFixed(4);
        line.costBasis = 'posted';
        await manager.getRepository(InvoiceLineItem).save(line);
      }

      await recordInventoryMovement(manager, {
        companyId: invoice.companyId,
        itemId: item.id,
        date: invoice.invoiceDate,
        type: reverse ? 'return' : 'sale',
        quantityChange: reverse ? qty : qty.negated(),
        balanceAfter: newQty,
        // 1200 is credited by `cost` on a sale and debited by it on a void,
        // which is the pair of lines the caller pushes from `cogsTotal`.
        valueChange: reverse ? cost : cost.negated(),
        reference: invoice.invoiceNumber,
        sourceType: reverse ? 'invoice_void' : 'invoice',
        sourceId: invoice.id,
        createdBy: userId,
      });
    }
    return total;
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
