import { MessagingService } from './messaging.service';
import { MessagingSettingsService } from './messaging-settings.service';
import { DEFAULT_EVENT_RULES } from './messaging.constants';
import { loadPlanOverrides } from '../billing/plan-config';

/**
 * enqueue() against an in-memory stand-in for the database: the SQL it sends
 * is matched by shape, and outbound_messages enforces the unique key like
 * Postgres does.
 */
interface World {
  companyType: string;
  settings: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  user: Record<string, unknown> | null;
  usage: number;
  sentBefore: boolean;
  failOn?: RegExp;
}

function makeManager(world: World, inTx = true) {
  const rows = new Map<
    string,
    { id: string; status: string; last_error: string | null; params: string }
  >();
  const log: string[] = [];
  let seq = 0;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    if (world.failOn && world.failOn.test(sql))
      throw new Error('boom 923001234567');
    if (/^\s*(SAVEPOINT|RELEASE|ROLLBACK)/.test(sql)) return [];
    if (/SELECT company_type/.test(sql)) {
      return [
        {
          company_type: world.companyType,
          inventory_enabled: false,
          all_features_unlocked: false,
        },
      ];
    }
    if (/FROM companies c\s+LEFT JOIN company_settings/.test(sql)) {
      return [
        {
          company_name: 'Warehouse Co',
          timezone: 'Asia/Karachi',
          ...(world.settings ?? { company_id: null }),
        },
      ];
    }
    if (/FROM customers WHERE id/.test(sql))
      return world.customer ? [world.customer] : [];
    if (/FROM users u/.test(sql)) return world.user ? [world.user] : [];
    if (/messaging_usage/.test(sql)) return [{ used: world.usage }];
    if (/SELECT 1 FROM outbound_messages/.test(sql))
      return world.sentBefore ? [{ '?column?': 1 }] : [];
    if (/INSERT INTO outbound_messages/.test(sql)) {
      const key = String(params[14]);
      const existing = rows.get(key);
      if (existing) {
        if (/DO UPDATE/.test(sql) && existing.status === 'queued') {
          existing.params = String(params[10]);
          return [existing];
        }
        return [];
      }
      const row = {
        id: `m${++seq}`,
        status: String(params[12]),
        last_error: (params[13] as string) ?? null,
        params: String(params[10]),
      };
      rows.set(key, row);
      return [row];
    }
    if (/WHERE idempotency_key = \$1/.test(sql)) {
      const r = rows.get(String(params[0]));
      return r ? [r] : [];
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  });
  const manager = {
    query,
    queryRunner: inTx ? { isTransactionActive: true } : undefined,
  };
  return { manager: manager as never, rows, log, query };
}

const ENABLED = {
  company_id: 'c1',
  enabled: true,
  event_rules: { ...DEFAULT_EVENT_RULES },
  quiet_hours: { start: '21:00', end: '09:00' },
  reminder_schedule: { beforeDue: [3], afterDue: [0, 7] },
  default_language: 'en',
  monthly_cap: null,
  contacts_opt_in_confirmed_at: null,
};
const CUSTOMER = {
  name: 'Ali Traders',
  contact_person: null,
  whatsapp_e164: '+923124890176',
  whatsapp_opt_out: false,
  whatsapp_opt_in_at: new Date(),
  preferred_language: null,
};

function service() {
  const settings = new MessagingSettingsService(
    {} as never,
    { get: () => undefined } as never,
  );
  return new MessagingService({ manager: null } as never, settings);
}

const input = (over: Record<string, unknown> = {}) =>
  ({
    companyId: 'c1',
    event: 'invoice_issued',
    docType: 'invoice',
    docId: '11111111-1111-4111-8111-111111111111',
    recipient: { type: 'customer', id: 'cust1' },
    params: {
      invoiceNumber: 'INV-1',
      total: 'Rs 10.00',
      dueDate: '1 Dec 2026',
    },
    attachment: { renderer: 'invoice', args: { invoiceId: 'x' } },
    createdBy: 'u1',
    ...over,
  }) as never;

const world = (over: Partial<World> = {}): World => ({
  companyType: 'warehouse',
  settings: ENABLED,
  customer: CUSTOMER,
  user: null,
  usage: 0,
  sentBefore: false,
  ...over,
});

describe('MessagingService.enqueue', () => {
  it('queues one row with the company and recipient merged into the params', async () => {
    const { manager, rows } = makeManager(world());
    const r = await service().enqueue(manager, input());
    expect(r).toMatchObject({
      status: 'queued',
      skipReason: null,
      duplicate: false,
    });
    expect(rows.size).toBe(1);
    const [key] = [...rows.keys()];
    expect(key).toBe(
      'invoice_issued:invoice:11111111-1111-4111-8111-111111111111:1:+923124890176',
    );
    const params = JSON.parse([...rows.values()][0].params);
    expect(params).toMatchObject({
      company: 'Warehouse Co',
      recipientName: 'Ali Traders',
      invoiceNumber: 'INV-1',
    });
  });

  it('is idempotent: the same event, document, version and phone writes nothing new', async () => {
    const { manager, rows } = makeManager(world());
    const s = service();
    const a = await s.enqueue(manager, input());
    const b = await s.enqueue(manager, input());
    expect(rows.size).toBe(1);
    expect(b).toMatchObject({ id: a!.id, duplicate: true });
    await s.enqueue(manager, input({ docVersion: 2 }));
    expect(rows.size).toBe(2);
  });

  it('mergeIntoQueued replaces the queued row instead (settle covering remittance)', async () => {
    const { manager, rows } = makeManager(world());
    const s = service();
    await s.enqueue(manager, input({ params: { invoiceNumber: 'first' } }));
    const r = await s.enqueue(
      manager,
      input({ params: { invoiceNumber: 'covering' }, mergeIntoQueued: true }),
    );
    expect(rows.size).toBe(1);
    expect(r!.duplicate).toBe(false);
    expect(JSON.parse([...rows.values()][0].params).invoiceNumber).toBe(
      'covering',
    );
  });

  it.each([
    ['feature_off', world({ companyType: 'small_business' }), {}],
    [
      'connect_disabled',
      world({ settings: { ...ENABLED, enabled: false } }),
      {},
    ],
    ['connect_disabled', world({ settings: null }), {}],
    [
      'rule_off',
      world({
        settings: {
          ...ENABLED,
          event_rules: { ...DEFAULT_EVENT_RULES, invoice_issued: 'off' },
        },
      }),
      {},
    ],
    [
      'rule_manual',
      world({
        settings: {
          ...ENABLED,
          event_rules: { ...DEFAULT_EVENT_RULES, invoice_issued: 'manual' },
        },
      }),
      {},
    ],
    [
      'no_number',
      world({ customer: { ...CUSTOMER, whatsapp_e164: null } }),
      {},
    ],
    ['no_number', world({ customer: null }), {}],
    [
      'opted_out',
      world({ customer: { ...CUSTOMER, whatsapp_opt_out: true } }),
      {},
    ],
    [
      'no_consent',
      world({ customer: { ...CUSTOMER, whatsapp_opt_in_at: null } }),
      {},
    ],
    [
      'cap_reached',
      world({ settings: { ...ENABLED, monthly_cap: 5 }, usage: 5 }),
      {},
    ],
    // The plan's allowance (FinMatrix pays): 200 a month unless the plan says otherwise.
    ['plan_limit_reached', world({ usage: 200 }), {}],
  ])('writes a skipped row: %s', async (reason, w, over) => {
    const { manager, rows } = makeManager(w);
    const r = await service().enqueue(manager, input(over));
    expect(r).toMatchObject({ status: 'skipped', skipReason: reason });
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].last_error).toBe(reason);
  });

  it('an explicit send goes out under a manual rule, but never under off', async () => {
    const manual = makeManager(
      world({
        settings: {
          ...ENABLED,
          event_rules: { ...DEFAULT_EVENT_RULES, invoice_issued: 'manual' },
        },
      }),
    );
    expect(
      await service().enqueue(manual.manager, input({ explicit: true })),
    ).toMatchObject({ status: 'queued' });
    const off = makeManager(
      world({
        settings: {
          ...ENABLED,
          event_rules: { ...DEFAULT_EVENT_RULES, invoice_issued: 'off' },
        },
      }),
    );
    expect(
      await service().enqueue(off.manager, input({ explicit: true })),
    ).toMatchObject({ skipReason: 'rule_off' });
  });

  it('company-wide consent confirmation covers contacts without their own opt-in', async () => {
    const { manager } = makeManager(
      world({
        settings: { ...ENABLED, contacts_opt_in_confirmed_at: new Date() },
        customer: { ...CUSTOMER, whatsapp_opt_in_at: null },
      }),
    );
    expect(await service().enqueue(manager, input())).toMatchObject({
      status: 'queued',
    });
  });

  it('owner alerts need a phone but no contact consent', async () => {
    const { manager } = makeManager(
      world({ user: { name: 'Owner', phone: '0300-1234567' } }),
    );
    const r = await service().enqueue(
      manager,
      input({
        event: 'approval_pending',
        docType: 'approval_request',
        recipient: { type: 'user', userId: 'u9' },
        attachment: null,
      }),
    );
    expect(r).toMatchObject({ status: 'queued' });
  });

  it('requireSent: no cancellation for a document the customer never received (D3)', async () => {
    const never = makeManager(world({ sentBefore: false }));
    const cancel = input({
      event: 'invoice_cancelled',
      attachment: null,
      requireSent: { docType: 'invoice', docId: 'x' },
    });
    expect(await service().enqueue(never.manager, cancel)).toBeNull();
    expect(never.rows.size).toBe(0);
    const got = makeManager(world({ sentBefore: true }));
    expect(await service().enqueue(got.manager, cancel)).toMatchObject({
      status: 'queued',
    });
  });

  it('never throws: a failing statement is rolled back to the savepoint and null returned', async () => {
    const { manager, query } = makeManager(
      world({ failOn: /INSERT INTO outbound_messages/ }),
    );
    await expect(service().enqueue(manager, input())).resolves.toBeNull();
    const sqls = query.mock.calls.map((c) => String(c[0]).trim());
    expect(sqls[0]).toBe('SAVEPOINT fm_messaging');
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT fm_messaging');
  });

  it('never throws on an unknown event either', async () => {
    const { manager } = makeManager(world());
    await expect(
      service().enqueue(manager, input({ event: 'no_such_event' })),
    ).resolves.toBeNull();
  });

  it('outside a transaction it uses no savepoint', async () => {
    const { manager, query } = makeManager(world(), false);
    await service().enqueue(manager, input());
    expect(query.mock.calls.some((c) => /SAVEPOINT/.test(String(c[0])))).toBe(
      false,
    );
  });
});

describe('MessagingService.cancelQueued', () => {
  it('cancels only queued rows of the documents (and only the given events)', async () => {
    const query = jest.fn(async (sql: string) =>
      /UPDATE outbound_messages/.test(sql)
        ? [[{ id: 'a' }, { id: 'b' }], 2]
        : [],
    );
    const manager = {
      query,
      queryRunner: { isTransactionActive: true },
    } as never;
    const n = await service().cancelQueued(manager, 'c1', 'invoice', ['i1'], {
      events: ['reminder_overdue'],
    });
    expect(n).toBe(2);
    const update = query.mock.calls.find((c) => /UPDATE/.test(String(c[0])))!;
    expect(String(update[0])).toContain("status = 'queued'");
    expect(String(update[0])).toContain('event_type = ANY');
  });

  it('never throws', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (/UPDATE/.test(sql)) throw new Error('db down');
        return [];
      }),
      queryRunner: { isTransactionActive: true },
    } as never;
    await expect(
      service().cancelQueued(manager, 'c1', 'invoice', 'i1'),
    ).resolves.toBe(0);
  });
});

describe('the plan allowance (FinMatrix pays Meta)', () => {
  afterEach(() => loadPlanOverrides([]));

  it('lets messages through below the allowance', async () => {
    const { manager } = makeManager(world({ usage: 199 }));
    const r = await service().enqueue(manager, input());
    expect(r).toMatchObject({ status: 'queued', skipReason: null });
  });

  it("follows the admin's per-plan edit", async () => {
    loadPlanOverrides([['free', { whatsappMonthlyMessages: 3 }]]);
    const { manager } = makeManager(world({ usage: 3 }));
    const r = await service().enqueue(manager, input());
    expect(r).toMatchObject({
      status: 'skipped',
      skipReason: 'plan_limit_reached',
    });
  });

  it("reports the owner's own lower cap first", async () => {
    const { manager } = makeManager(
      world({ settings: { ...ENABLED, monthly_cap: 5 }, usage: 250 }),
    );
    const r = await service().enqueue(manager, input());
    expect(r).toMatchObject({ skipReason: 'cap_reached' });
  });
});
