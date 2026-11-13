import { ConfigService } from '@nestjs/config';
import { MigrationAiService, uncertainItems } from './migration-ai.service';

const config = (vars: Record<string, unknown>) =>
  ({
    get: (k: string, d?: unknown) => (k in vars ? vars[k] : d),
  }) as unknown as ConfigService;
const client = { create: jest.fn() };

describe('MigrationAiService', () => {
  it('is off unless enabled, keyed (client present) and given a model', () => {
    const make = (vars: Record<string, unknown>, c: unknown = client) =>
      new MigrationAiService(
        config(vars),
        {} as never,
        {} as never,
        c as never,
      );
    expect(make({}).enabled()).toBe(false);
    expect(make({ MIGRATION_AI_ENABLED: 'true' }).enabled()).toBe(false);
    expect(
      make(
        { MIGRATION_AI_ENABLED: 'true', MIGRATION_AI_MODEL: 'm' },
        null,
      ).enabled(),
    ).toBe(false);
    expect(
      make({
        MIGRATION_AI_ENABLED: 'false',
        MIGRATION_AI_MODEL: 'm',
      }).enabled(),
    ).toBe(false);
    expect(
      make({ MIGRATION_AI_ENABLED: 'true', MIGRATION_AI_MODEL: 'm' }).enabled(),
    ).toBe(true);
  });

  it('does nothing at all when disabled — no database, no API call', async () => {
    const svc = new MigrationAiService(
      config({}),
      {} as never,
      {} as never,
      client as never,
    );
    await expect(svc.assist('b', 'c')).resolves.toEqual({
      ran: false,
      reason: 'disabled',
    });
    expect(client.create).not.toHaveBeenCalled();
  });

  it('asks only about what the rules and the owner left uncertain', () => {
    const m = (
      kind: string,
      sheet: string,
      source: string,
      target: string | null,
      confidence: number,
      origin = 'rule',
    ) =>
      ({
        kind,
        sheet,
        source,
        target,
        confidence: String(confidence),
        origin,
      }) as never;
    const items = uncertainItems(
      [
        m('column', 'S', 'Mobile', 'phone', 0.85),
        m('column', 'S', 'Name', 'name', 1),
        m('column', 'S', 'Colour', null, 0),
        m('column', 'S', 'Udhaar', null, 0, 'user'),
        m('account', '', '2100', '2000', 0.85),
        m('sheet', '', 'S', 'customers', 0.6, 'user'),
      ],
      [
        {
          code: 'UNKNOWN_ACCOUNT',
          field: 'account::1500',
          message:
            'Account 1500 (Furniture & Fixtures) is in the trial balance…',
        } as never,
      ],
      [
        {
          name: 'S',
          headers: ['Name'],
          sampleRows: [],
          rowCount: 1,
          stats: [],
          currentTarget: 'customers',
          currentConfidence: 0.6,
        },
        {
          name: 'T',
          headers: ['A'],
          sampleRows: [],
          rowCount: 1,
          stats: [],
          currentTarget: 'stock',
          currentConfidence: 1,
        },
      ],
    );
    expect(items.sheets).toEqual([]); // the owner already decided sheet S
    expect(items.columns.map((c) => c.header)).toEqual(['Mobile', 'Colour']);
    expect(items.accounts).toEqual([
      { number: '1500', name: 'Furniture & Fixtures' },
      { number: '2100', name: null },
    ]);
  });
});
