import { SearchService } from './search.service';

/**
 * A delivery rider's search.
 *
 * Riders may not read the customer or vendor lists, and search is a way to
 * read them a name at a time — directly, or through invoice and bill hits,
 * which name the customer or vendor. So a rider's search reaches stock only,
 * whatever it asks for.
 */
const chain = () => {
  const qb: Record<string, jest.Mock> = {};
  const self = new Proxy(qb, {
    get: (target, prop: string) => {
      if (prop === 'getMany') return jest.fn().mockResolvedValue([]);
      if (prop === 'then') return undefined;
      target[prop] ??= jest.fn(() => self);
      return target[prop];
    },
  });
  return self;
};

const repo = () => ({ createQueryBuilder: jest.fn(() => chain()) });

const setup = () => {
  const customers = repo();
  const vendors = repo();
  const invoices = repo();
  const bills = repo();
  const items = repo();
  const other = repo();
  const dataSource = {
    manager: {
      query: jest.fn().mockResolvedValue([
        { company_type: 'warehouse', inventory_enabled: true, all_features_unlocked: true },
      ]),
    },
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn(() => other),
  };
  const svc = new SearchService(
    customers as never,
    vendors as never,
    invoices as never,
    bills as never,
    items as never,
    dataSource as never,
  );
  return { svc, customers, vendors, invoices, bills, items, other };
};

describe('SearchService — a delivery rider', () => {
  it('searches stock and nothing that names a customer or vendor', async () => {
    const { svc, customers, vendors, invoices, bills, items, other } = setup();
    const { results } = await svc.search('c1', 'ali', undefined, 'delivery');

    expect(Object.keys(results)).toEqual(['inventory']);
    expect(items.createQueryBuilder).toHaveBeenCalled();
    for (const r of [customers, vendors, invoices, bills, other]) {
      expect(r.createQueryBuilder).not.toHaveBeenCalled();
    }
  });

  it('gets nothing by asking for customers and vendors by name', async () => {
    const { svc, customers, vendors } = setup();
    const { results } = await svc.search('c1', 'ali', 'customers,vendors,invoices,bills', 'delivery');

    expect(results).toEqual({});
    expect(customers.createQueryBuilder).not.toHaveBeenCalled();
    expect(vendors.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('still searches customers and vendors for staff', async () => {
    const { svc, customers, vendors } = setup();
    const { results } = await svc.search('c1', 'ali', 'customers,vendors', 'staff');

    expect(Object.keys(results).sort()).toEqual(['customers', 'vendors']);
    expect(customers.createQueryBuilder).toHaveBeenCalled();
    expect(vendors.createQueryBuilder).toHaveBeenCalled();
  });
});
