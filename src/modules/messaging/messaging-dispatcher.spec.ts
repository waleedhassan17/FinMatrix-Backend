import {
  ClaimedMessage,
  MessagingDispatcherService,
  PermanentSendError,
  withCompanyName,
} from './messaging-dispatcher.service';
import { ProviderError } from './meta-error-map';

function dispatcher(
  opts: {
    settings?: Record<string, unknown>;
    features?: boolean;
    /** This month's counted sends, for the allowance check. */
    usage?: number;
    /** What the usage upsert returns after this send. */
    countAfter?: number;
  } = {},
) {
  const sql: Array<{ q: string; p: unknown[] }> = [];
  const dataSource = {
    manager: {
      query: jest.fn(async () => [
        {
          company_type:
            opts.features === false ? 'small_business' : 'warehouse',
          inventory_enabled: false,
          all_features_unlocked: false,
        },
      ]),
    },
    query: jest.fn(async (q: string, p: unknown[] = []) => {
      sql.push({ q, p });
      if (/FROM customers WHERE id/.test(q)) {
        return [
          {
            whatsapp_opt_out: false,
            whatsapp_e164: '+923124890176',
            collections_paused: false,
          },
        ];
      }
      if (/FROM invoices/.test(q)) return [{ status: 'sent', balance: '100' }];
      if (/SUM\(count\)/.test(q) && /messaging_usage/.test(q))
        return [{ used: opts.usage ?? 0 }];
      if (
        /INSERT INTO messaging_usage/.test(q) &&
        opts.countAfter !== undefined
      )
        return [{ count: opts.countAfter }];
      return [];
    }),
  };
  const settings = {
    resolve: jest.fn(async () => ({
      enabled: true,
      timezone: 'Asia/Karachi',
      quietHours: { start: '21:00', end: '09:00' },
      monthlyCap: null,
      senderMode: 'shared',
      ...opts.settings,
    })),
    ownAccessToken: () => null,
  };
  const status = {
    clearVerification: jest.fn(),
    notifyFailure: jest.fn(),
    notifyAllowance: jest.fn(),
  };
  const provider = {
    kind: 'fake',
    uploadMedia: jest.fn(async () => 'media-1'),
    sendTemplate: jest.fn(async () => ({ providerMessageId: 'wamid-1' })),
    sendText: jest.fn(async () => ({ providerMessageId: 'wamid-text' })),
  };
  const renderers = {
    get: () => ({
      render: async () => ({
        buffer: Buffer.from('%PDF'),
        filename: 'INV-1.pdf',
      }),
    }),
  };
  const storage = {
    putBuffer: jest.fn(async () => ({ key: 'db:1' })),
    read: jest.fn(),
  };
  const d = new MessagingDispatcherService(
    dataSource as never,
    { get: () => undefined } as never,
    settings as never,
    renderers as never,
    storage as never,
    status as never,
    provider as never,
  );
  return { d, sql, provider, status, storage };
}

const row = (over: Partial<ClaimedMessage> = {}): ClaimedMessage => ({
  id: 'm1',
  companyId: 'c1',
  eventType: 'invoice_issued',
  docType: 'invoice',
  docId: 'i1',
  recipientType: 'customer',
  recipientId: 'cust1',
  toPhone: '+923124890176',
  templateName: 'fm_invoice_issued',
  language: 'en',
  params: {
    company: 'Warehouse Co',
    recipientName: 'Ali',
    invoiceNumber: 'INV-1',
    total: 'Rs 1.00',
    dueDate: 'x',
  },
  attachment: { renderer: 'invoice', args: { invoiceId: 'i1' } },
  mediaStorageKey: null,
  attempts: 0,
  createdBy: 'u1',
  ...over,
});

const DAY = new Date('2026-11-05T09:00:00Z'); // 14:00 PKT
const NIGHT = new Date('2026-11-05T17:30:00Z'); // 22:30 PKT

describe('MessagingDispatcherService', () => {
  it('renders, stores, uploads and sends; marks sent and counts usage', async () => {
    const { d, sql, provider, storage } = dispatcher();
    expect(await d.processOne(row(), DAY)).toBe('sent');
    expect(storage.putBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'outbound-messages' }),
    );
    expect(provider.uploadMedia).toHaveBeenCalled();
    const sent = provider.sendTemplate.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(sent[1]).toMatchObject({
      templateName: 'fm_invoice_issued',
      documentHeader: { mediaId: 'media-1' },
    });
    expect(sql.some((s) => /SET status = 'sent'/.test(s.q))).toBe(true);
    expect(sql.some((s) => /INSERT INTO messaging_usage/.test(s.q))).toBe(true);
  });

  it('quiet hours: re-queues with scheduled_for at 09:00 PKT and sends nothing', async () => {
    const { d, sql, provider } = dispatcher();
    expect(await d.processOne(row(), NIGHT)).toBe('deferred');
    const upd = sql.find((s) => /scheduled_for = \$2/.test(s.q))!;
    expect((upd.p[1] as Date).toISOString()).toBe('2026-11-06T04:00:00.000Z');
    expect(provider.sendTemplate).not.toHaveBeenCalled();
  });

  it('approval alerts ignore quiet hours', async () => {
    const { d, provider } = dispatcher();
    const alert = row({
      eventType: 'approval_pending',
      templateName: 'fm_approval_pending',
      recipientType: 'user',
      attachment: null,
      params: {
        company: 'W',
        requester: 'S',
        summary: 'x',
        approvalPath: 'a1',
      },
    });
    expect(await d.processOne(alert, NIGHT)).toBe('sent');
    const sent = provider.sendTemplate.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(sent[1]).toMatchObject({
      urlButtonParam: 'a1',
      documentHeader: null,
    });
  });

  it('Connect switched off after queueing: skipped, nothing sent', async () => {
    const { d, provider } = dispatcher({ settings: { enabled: false } });
    expect(await d.processOne(row(), DAY)).toBe('skipped:connect_disabled');
    expect(provider.sendTemplate).not.toHaveBeenCalled();
  });

  it('a retryable error re-queues with backoff', async () => {
    const { d, sql, status } = dispatcher();
    expect(
      await d.handleError(
        row({ attempts: 1 }),
        new ProviderError('rate', 130429, 400),
      ),
    ).toBe('retry');
    const upd = sql.find((s) => /next_attempt_at = now\(\)/.test(s.q))!;
    expect(upd.p).toEqual(['m1', 2, expect.any(String), String(4 * 60_000)]);
    expect(status.notifyFailure).not.toHaveBeenCalled();
  });

  it('the sixth retryable failure is final', async () => {
    const { d, status } = dispatcher();
    expect(
      await d.handleError(
        row({ attempts: 5 }),
        new ProviderError('rate', 130429, 400),
      ),
    ).toBe('failed');
    expect(status.notifyFailure).toHaveBeenCalled();
  });

  it('131026 fails at once, clears verification and alerts the sender', async () => {
    const { d, status } = dispatcher();
    expect(
      await d.handleError(
        row(),
        new ProviderError('undeliverable', 131026, 400),
      ),
    ).toBe('failed');
    expect(status.clearVerification).toHaveBeenCalledWith(
      'customers',
      'cust1',
      '+923124890176',
    );
    expect(status.notifyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'u1' }),
      expect.any(String),
    );
  });

  it('a missing PDF renderer is permanent', async () => {
    const { d } = dispatcher();
    expect(
      await d.handleError(row(), new PermanentSendError('No PDF renderer')),
    ).toBe('failed');
  });
});

describe('one FinMatrix number for every company (D34-D36)', () => {
  it('the PDF file name carries the company', async () => {
    const { d, provider } = dispatcher();
    expect(await d.processOne(row(), DAY)).toBe('sent');
    const file = (provider.uploadMedia.mock.calls[0] as unknown[])[1] as {
      filename: string;
    };
    expect(file.filename).toBe('Warehouse Co - INV-1.pdf');
  });

  it('withCompanyName: cleans the name, skips an empty or repeated one', () => {
    expect(withCompanyName('Ali & Sons (Pvt) Ltd.', 'INV-9.pdf')).toBe(
      'Ali Sons Pvt Ltd. - INV-9.pdf',
    );
    expect(withCompanyName('علی ٹریڈرز', 'INV-9.pdf')).toBe('INV-9.pdf');
    expect(withCompanyName('Warehouse Co', 'Warehouse Co - INV-9.pdf')).toBe(
      'Warehouse Co - INV-9.pdf',
    );
  });

  it('an automatic reply goes as plain text, counted as a free service message', async () => {
    const { d, sql, provider } = dispatcher({ settings: { planAllowance: 0 } });
    const out = await d.processOne(
      row({
        eventType: 'auto_reply',
        templateName: '_text',
        params: { company: 'Warehouse Co', text: 'This is FinMatrix…' },
        attachment: null,
      }),
      NIGHT, // replies ignore quiet hours
    );
    expect(out).toBe('sent');
    expect(provider.sendText).toHaveBeenCalledWith(expect.anything(), {
      to: '+923124890176',
      body: 'This is FinMatrix…',
    });
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    const usage = sql.find((s) => /INSERT INTO messaging_usage/.test(s.q));
    expect(usage?.p).toContain('service');
  });

  it('at the plan allowance nothing more goes out this month', async () => {
    const { d, provider } = dispatcher({
      settings: { planAllowance: 2 },
      usage: 2,
    });
    expect(await d.processOne(row(), DAY)).toBe('skipped:plan_limit_reached');
    expect(provider.sendTemplate).not.toHaveBeenCalled();
  });

  it('tells the owners once at 80% and once at 100%', async () => {
    const at80 = dispatcher({
      settings: { planAllowance: 10 },
      usage: 7,
      countAfter: 8,
    });
    await at80.d.processOne(row(), DAY);
    expect(at80.status.notifyAllowance).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ used: 8, limit: 10, full: false }),
    );
    const between = dispatcher({
      settings: { planAllowance: 10 },
      usage: 8,
      countAfter: 9,
    });
    await between.d.processOne(row(), DAY);
    expect(between.status.notifyAllowance).not.toHaveBeenCalled();
    const full = dispatcher({
      settings: { planAllowance: 10 },
      usage: 9,
      countAfter: 10,
    });
    await full.d.processOne(row(), DAY);
    expect(full.status.notifyAllowance).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ used: 10, limit: 10, full: true }),
    );
  });
});
