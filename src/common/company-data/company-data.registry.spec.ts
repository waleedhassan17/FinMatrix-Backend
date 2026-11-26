import { readdirSync, statSync } from 'fs';
import * as path from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { EXPORT_ENTITIES } from '../../modules/data-portability/exporter/export-entities';
import {
  COMPANY_DATA_REGISTRY,
  NON_COMPANY_TABLES,
  registeredTableNames,
} from './company-data.registry';

/**
 * Deleting a company must remove EVERY row it owns. That is only true while
 * every company-scoped table is in the registry, so this fails the moment a
 * new entity with a company_id — or a child of a company-scoped entity — is
 * added without being registered.
 */
function entityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...entityFiles(full));
    else if (name.endsWith('.entity.ts')) out.push(full);
  }
  return out;
}

describe('company data registry', () => {
  const root = path.resolve(__dirname, '../..');
  // Load every entity so the TypeORM decorators register their metadata.
  for (const f of entityFiles(root)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(f);
  }
  const storage = getMetadataArgsStorage();

  /** The table name of an entity class, or undefined for an abstract base. */
  const tableOf = (target: unknown): string | undefined => {
    const t = storage.tables.find((x) => x.target === target);
    return t ? (t.name ?? undefined) : undefined;
  };

  /** Every class in an entity's prototype chain (BaseCompanyEntity, …). */
  const chain = (target: unknown): unknown[] => {
    const out: unknown[] = [];
    let p = target as { prototype?: unknown } | null;
    while (p && p !== Function.prototype) {
      out.push(p);
      p = Object.getPrototypeOf(p);
    }
    return out;
  };

  const entities = storage.tables.filter(
    (t) => typeof t.target === 'function' && t.type === 'regular',
  );

  const hasCompanyId = (target: unknown) =>
    storage.columns.some(
      (c) =>
        chain(target).includes(c.target) &&
        (c.options.name === 'company_id' || c.propertyName === 'companyId'),
    );

  it('loads the entity files', () => {
    expect(entities.length).toBeGreaterThan(60);
  });

  it('registers every entity that carries a company_id', () => {
    const registered = registeredTableNames();
    const missing = entities
      .filter((t) => hasCompanyId(t.target))
      .map((t) => t.name as string)
      .filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });

  it('registers every child of a company-scoped entity', () => {
    const registered = registeredTableNames();
    const companyScoped = new Set(
      entities.filter((t) => hasCompanyId(t.target)).map((t) => t.target),
    );
    const missing: string[] = [];
    for (const rel of storage.relations) {
      if (rel.relationType !== 'many-to-one') continue;
      // Decorators pass the related class lazily, as an arrow function (which,
      // unlike a class, has no prototype).
      const lazy = rel.type as unknown as { prototype?: unknown };
      const type =
        typeof rel.type === 'function' && !lazy.prototype
          ? (rel.type as () => unknown)()
          : rel.type;
      if (!companyScoped.has(type as never)) continue;
      const child = tableOf(rel.target);
      if (child && !registered.has(child)) missing.push(child);
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('registers every table the customer backup exports', () => {
    const registered = registeredTableNames();
    const missing = EXPORT_ENTITIES.map((d) => tableOf(d.entity)).filter(
      (name): name is string => !!name && !registered.has(name),
    );
    expect(missing).toEqual([]);
  });

  it('lists each table once, and never as both company data and not', () => {
    const names = COMPANY_DATA_REGISTRY.map((e) => e.table);
    expect(names.length).toBe(new Set(names).size);
    const both = NON_COMPANY_TABLES.filter((t) => names.includes(t));
    expect(both).toEqual([]);
  });

  it('every child points at a registered company table', () => {
    const companyNames = new Set(
      COMPANY_DATA_REGISTRY.filter((e) => e.scope === 'company').map(
        (e) => e.table,
      ),
    );
    for (const e of COMPANY_DATA_REGISTRY) {
      if (e.scope !== 'child') continue;
      expect(companyNames.has(e.parent)).toBe(true);
      for (const v of e.alsoVia ?? [])
        expect(companyNames.has(v.parent)).toBe(true);
    }
  });
});
