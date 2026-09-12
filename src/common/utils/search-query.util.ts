import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Customer } from '../../modules/customers/entities/customer.entity';
import { Vendor } from '../../modules/vendors/entities/vendor.entity';
import { likeContains } from './like.util';

export interface TextSearchOptions {
  /** Property paths matched with ILIKE, e.g. `['i.invoiceNumber', 'i.notes']`. */
  columns: string[];
  /** Also match documents whose customer's name or company contains the term. */
  customerColumn?: string;
  /** Also match documents whose vendor's company or contact name contains the term. */
  vendorColumn?: string;
}

/**
 * One "contains" search across a list query's text columns and, optionally,
 * the name of the customer or vendor the document belongs to.
 *
 * People search a bill list by who they owe, not by BILL-2026-0041; matching
 * only the number made those searches look broken.
 *
 * The parameters are named `search` and `searchCompanyId` on purpose. The
 * lists this is applied to already bind `:s`, `:c` and `:e` for status and
 * dates, and TypeORM keeps one value per name for the whole query — reusing
 * `:s` for the term replaced the status or start date with `%term%`.
 */
export function applyTextSearch<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  search: string | undefined,
  companyId: string,
  options: TextSearchOptions,
): void {
  const term = search?.trim();
  if (!term) return;

  const clauses = options.columns.map((column) => `${column} ILIKE :search`);

  if (options.customerColumn) {
    const customers = qb
      .subQuery()
      .select('search_customer.id')
      .from(Customer, 'search_customer')
      .where('search_customer.companyId = :searchCompanyId')
      .andWhere(
        '(search_customer.name ILIKE :search OR search_customer.company ILIKE :search)',
      )
      .getQuery();
    clauses.push(`${options.customerColumn} IN ${customers}`);
  }

  if (options.vendorColumn) {
    const vendors = qb
      .subQuery()
      .select('search_vendor.id')
      .from(Vendor, 'search_vendor')
      .where('search_vendor.companyId = :searchCompanyId')
      .andWhere(
        '(search_vendor.companyName ILIKE :search OR search_vendor.contactPerson ILIKE :search)',
      )
      .getQuery();
    clauses.push(`${options.vendorColumn} IN ${vendors}`);
  }

  qb.andWhere(`(${clauses.join(' OR ')})`, {
    search: likeContains(term),
    searchCompanyId: companyId,
  });
}
