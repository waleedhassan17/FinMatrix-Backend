import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Customer } from '../customers/entities/customer.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { computeFeatures } from '../../common/features/feature-map';
import { MIN_SEARCH_LENGTH } from '../../common/utils/like.util';
import { applyTextSearch } from '../../common/utils/search-query.util';

const ALL_ENTITIES = ['customers', 'vendors', 'invoices', 'bills', 'inventory'];
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

  async search(companyId: string, q: string | undefined, entities?: string) {
    const query = (q ?? '').trim();
    const results: Record<string, any[]> = {};

    // A missing `q` used to become the pattern `%undefined%`, and a one-letter
    // one matched most of the ledger. Too short to mean anything: no rows.
    if (query.length < MIN_SEARCH_LENGTH) return { query, results };

    let targetEntities = entities
      ? entities.split(',').map((e) => e.trim()).filter((e) => ALL_ENTITIES.includes(e))
      : ALL_ENTITIES;

    // Tier enforcement (feature-map): companies without the inventory feature
    // (small business / large org) never get inventory hits back, even when
    // the caller asks for them — same lookup as FeatureGuard.
    if (targetEntities.includes('inventory')) {
      const rows: Array<{
        company_type: string | null;
        inventory_enabled: boolean | null;
        all_features_unlocked: boolean | null;
      }> = await this.dataSource.query(
        `SELECT company_type, inventory_enabled, all_features_unlocked FROM companies WHERE id = $1 LIMIT 1`,
        [companyId],
      );
      const row = rows[0];
      const features = computeFeatures({
        companyType: row?.company_type ?? null,
        inventoryEnabled: row?.inventory_enabled ?? false,
        allFeaturesUnlocked: row?.all_features_unlocked ?? false,
      });
      if (!features.inventory) {
        targetEntities = targetEntities.filter((e) => e !== 'inventory');
      }
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
      const names = await this.nameMap(this.customerRepo, invoices.map((i) => i.customerId), (c) => c.name);
      results.invoices = invoices.map((i) => ({ ...i, customerName: names[i.customerId] ?? '' }));
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
      const names = await this.nameMap(this.vendorRepo, bills.map((b) => b.vendorId), (v) => v.companyName);
      results.bills = bills.map((b) => ({ ...b, vendorName: names[b.vendorId] ?? '' }));
    }

    if (targetEntities.includes('inventory')) {
      const qb = this.itemRepo.createQueryBuilder('i').where('i.companyId = :cid', { cid: companyId });
      applyTextSearch(qb, query, companyId, { columns: ['i.name', 'i.sku'] });
      results.inventory = await qb.orderBy('i.name', 'ASC').take(PER_BUCKET).getMany();
    }

    return { query, results };
  }

  private async nameMap<T extends { id: string }>(
    repo: Repository<T>,
    ids: string[],
    name: (row: T) => string,
  ): Promise<Record<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return {};
    const rows = await repo.findByIds(unique);
    return Object.fromEntries(rows.map((row) => [row.id, name(row)]));
  }
}
