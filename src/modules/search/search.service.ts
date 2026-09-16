import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, ObjectLiteral, Repository } from 'typeorm';
import { Customer } from '../customers/entities/customer.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { PurchaseOrder } from '../purchase-orders/entities/purchase-order.entity';
import { SalesOrder } from '../sales-orders/entities/sales-order.entity';
import { Estimate } from '../estimates/entities/estimate.entity';
import { Payment } from '../payments/entities/payment.entity';
import { CreditMemo } from '../credit-memos/entities/credit-memo.entity';
import { VendorCredit } from '../vendor-credits/entities/vendor-credit.entity';
import { JournalEntry } from '../journal-entries/entities/journal-entry.entity';
import { FeatureKey } from '../../common/features/feature-map';
import { companyFeatures } from '../../common/features/company-features.util';
import { MIN_SEARCH_LENGTH } from '../../common/utils/like.util';
import { applyTextSearch } from '../../common/utils/search-query.util';

/**
 * Every document a user can look up by its number.
 *
 * Search used to cover customers, vendors, invoices, bills and inventory only.
 * Numbers run per document type — INV-2026-0027 and PO-2026-0027 are different
 * documents — so searching "0027" found the invoice and never the purchase
 * order, which read as "the same number was given to both". Each type now
 * comes back in its own labelled bucket.
 */
const ALL_ENTITIES = [
  'customers',
  'vendors',
  'invoices',
  'bills',
  'inventory',
  'purchaseOrders',
  'salesOrders',
  'estimates',
  'payments',
  'creditMemos',
  'vendorCredits',
  'journalEntries',
] as const;
type SearchEntity = (typeof ALL_ENTITIES)[number];

/** Buckets that only exist on some tiers. */
const ENTITY_FEATURE: Partial<Record<SearchEntity, FeatureKey>> = {
  inventory: 'inventory',
  purchaseOrders: 'purchaseOrders',
  salesOrders: 'salesOrders',
  estimates: 'estimates',
  creditMemos: 'creditMemos',
  vendorCredits: 'creditMemos',
  journalEntries: 'journalEntries',
};

/** A delivery rider's search stays on what their job needs. */
const DELIVERY_ENTITIES: SearchEntity[] = ['customers', 'vendors', 'invoices', 'bills', 'inventory'];

const PER_BUCKET = 20;

@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(Customer) private readonly customerRepo: Repository<Customer>,
    @InjectRepository(Vendor) private readonly vendorRepo: Repository<Vendor>,
    @InjectRepository(Invoice) private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(InventoryItem) private readonly itemRepo: Repository<InventoryItem>,
    private readonly dataSource: DataSource,
  ) {}

  async search(companyId: string, q: string | undefined, entities?: string, role?: string) {
    const query = (q ?? '').trim();
    const results: Record<string, any[]> = {};

    // A missing `q` used to become the pattern `%undefined%`, and a one-letter
    // one matched most of the ledger. Too short to mean anything: no rows.
    if (query.length < MIN_SEARCH_LENGTH) return { query, results };

    let targetEntities: SearchEntity[] = entities
      ? (entities
          .split(',')
          .map((e) => e.trim())
          .filter((e) => (ALL_ENTITIES as readonly string[]).includes(e)) as SearchEntity[])
      : [...ALL_ENTITIES];
    if (role === 'delivery') {
      targetEntities = targetEntities.filter((e) => DELIVERY_ENTITIES.includes(e));
    }

    // Tier enforcement (feature-map): a company never gets hits from a module
    // its tier does not have, even when the caller asks for them — same lookup
    // as FeatureGuard.
    if (targetEntities.some((e) => ENTITY_FEATURE[e])) {
      const features = await companyFeatures(this.dataSource.manager, companyId);
      targetEntities = targetEntities.filter((e) => {
        const feature = ENTITY_FEATURE[e];
        return !feature || features[feature];
      });
    }

    if (targetEntities.includes('customers')) {
      const qb = this.customerRepo.createQueryBuilder('c').where('c.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['c.name', 'c.company', 'c.email', 'c.phone'] });
      results.customers = await qb.orderBy('c.name', 'ASC').take(PER_BUCKET).getMany();
    }

    if (targetEntities.includes('vendors')) {
      const qb = this.vendorRepo.createQueryBuilder('v').where('v.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['v.companyName', 'v.contactPerson', 'v.email', 'v.phone'] });
      results.vendors = await qb.orderBy('v.companyName', 'ASC').take(PER_BUCKET).getMany();
    }

    if (targetEntities.includes('invoices')) {
      const qb = this.invoiceRepo.createQueryBuilder('i').where('i.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, {
        columns: ['i.invoiceNumber', 'i.notes'],
        customerColumn: 'i.customerId',
      });
      const invoices = await qb
        .orderBy('i.invoiceDate', 'DESC')
        .addOrderBy('i.createdAt', 'DESC')
        .take(PER_BUCKET)
        .getMany();
      // An invoice number alone does not say whose it is; the result row does.
      results.invoices = await this.withCustomerNames(companyId, invoices);
    }

    if (targetEntities.includes('bills')) {
      const qb = this.billRepo.createQueryBuilder('b').where('b.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, {
        columns: ['b.billNumber', 'b.memo'],
        vendorColumn: 'b.vendorId',
      });
      const bills = await qb
        .orderBy('b.billDate', 'DESC')
        .addOrderBy('b.createdAt', 'DESC')
        .take(PER_BUCKET)
        .getMany();
      results.bills = await this.withVendorNames(companyId, bills);
    }

    if (targetEntities.includes('inventory')) {
      const qb = this.itemRepo.createQueryBuilder('i').where('i.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['i.name', 'i.sku'] });
      results.inventory = await qb.orderBy('i.name', 'ASC').take(PER_BUCKET).getMany();
    }

    if (targetEntities.includes('purchaseOrders')) {
      const qb = this.dataSource
        .getRepository(PurchaseOrder)
        .createQueryBuilder('o')
        .where('o.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['o.poNumber', 'o.notes'], vendorColumn: 'o.vendorId' });
      const rows = await qb.orderBy('o.orderDate', 'DESC').addOrderBy('o.createdAt', 'DESC').take(PER_BUCKET).getMany();
      results.purchaseOrders = await this.withVendorNames(companyId, rows);
    }

    if (targetEntities.includes('salesOrders')) {
      const qb = this.dataSource
        .getRepository(SalesOrder)
        .createQueryBuilder('o')
        .where('o.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['o.orderNumber', 'o.notes'], customerColumn: 'o.customerId' });
      const rows = await qb.orderBy('o.orderDate', 'DESC').addOrderBy('o.createdAt', 'DESC').take(PER_BUCKET).getMany();
      results.salesOrders = await this.withCustomerNames(companyId, rows);
    }

    if (targetEntities.includes('estimates')) {
      const qb = this.dataSource
        .getRepository(Estimate)
        .createQueryBuilder('e')
        .where('e.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['e.estimateNumber', 'e.notes'], customerColumn: 'e.customerId' });
      const rows = await qb.orderBy('e.estimateDate', 'DESC').addOrderBy('e.createdAt', 'DESC').take(PER_BUCKET).getMany();
      results.estimates = await this.withCustomerNames(companyId, rows);
    }

    if (targetEntities.includes('payments')) {
      const qb = this.dataSource
        .getRepository(Payment)
        .createQueryBuilder('p')
        .where('p.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, {
        columns: ['p.paymentNumber', 'p.reference', 'p.memo'],
        customerColumn: 'p.customerId',
      });
      const rows = await qb.orderBy('p.paymentDate', 'DESC').addOrderBy('p.createdAt', 'DESC').take(PER_BUCKET).getMany();
      results.payments = await this.withCustomerNames(companyId, rows);
    }

    if (targetEntities.includes('creditMemos')) {
      const qb = this.dataSource
        .getRepository(CreditMemo)
        .createQueryBuilder('m')
        .where('m.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['m.creditMemoNumber', 'm.reason'], customerColumn: 'm.customerId' });
      const rows = await qb.orderBy('m.date', 'DESC').addOrderBy('m.createdAt', 'DESC').take(PER_BUCKET).getMany();
      results.creditMemos = await this.withCustomerNames(companyId, rows);
    }

    if (targetEntities.includes('vendorCredits')) {
      const qb = this.dataSource
        .getRepository(VendorCredit)
        .createQueryBuilder('v')
        .where('v.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['v.vendorCreditNumber', 'v.reason'], vendorColumn: 'v.vendorId' });
      const rows = await qb.orderBy('v.date', 'DESC').addOrderBy('v.createdAt', 'DESC').take(PER_BUCKET).getMany();
      results.vendorCredits = await this.withVendorNames(companyId, rows);
    }

    if (targetEntities.includes('journalEntries')) {
      const qb = this.dataSource
        .getRepository(JournalEntry)
        .createQueryBuilder('j')
        .where('j.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['j.reference', 'j.memo'] });
      results.journalEntries = await qb
        .orderBy('j.date', 'DESC')
        .addOrderBy('j.createdAt', 'DESC')
        .take(PER_BUCKET)
        .getMany();
    }

    return { query, results };
  }

  private async withCustomerNames<T extends ObjectLiteral & { customerId: string }>(companyId: string, rows: T[]) {
    const ids = [...new Set(rows.map((r) => r.customerId).filter(Boolean))];
    if (ids.length === 0) return rows.map((r) => ({ ...r, customerName: '' }));
    const customers = await this.customerRepo.find({ where: { companyId, id: In(ids) }, select: ['id', 'name'] });
    const names = new Map(customers.map((c) => [c.id, c.name]));
    return rows.map((r) => ({ ...r, customerName: names.get(r.customerId) ?? '' }));
  }

  private async withVendorNames<T extends ObjectLiteral & { vendorId: string }>(companyId: string, rows: T[]) {
    const ids = [...new Set(rows.map((r) => r.vendorId).filter(Boolean))];
    if (ids.length === 0) return rows.map((r) => ({ ...r, vendorName: '' }));
    const vendors = await this.vendorRepo.find({ where: { companyId, id: In(ids) }, select: ['id', 'companyName'] });
    const names = new Map(vendors.map((v) => [v.id, v.companyName]));
    return rows.map((r) => ({ ...r, vendorName: names.get(r.vendorId) ?? '' }));
  }
}
