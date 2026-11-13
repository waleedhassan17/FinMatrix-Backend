import {
  AiCreateParams,
  AiMappingSession,
  MigrationAiClient,
  SheetView,
} from './ai-mapping-session';

const sheet = (
  name: string,
  headers: string[],
  target: string | null,
  confidence: number,
): SheetView => ({
  name,
  headers,
  sampleRows: Array.from({ length: 30 }, (_, i) =>
    headers.map((h) => `${h}-${i}`),
  ),
  rowCount: 30,
  stats: headers.map((h) => ({
    header: h,
    filled: 30,
    numericShare: 0,
    dateShare: 0,
  })),
  currentTarget: target,
  currentConfidence: confidence,
});

const SHEETS = [
  sheet(
    'Party Balances',
    ['Party Name', 'Inv No', 'Inv Date', 'Balance Due'],
    'open_invoices',
    0.6,
  ),
  sheet('Mystery', ['Colour', 'Qty'], null, 0.2),
];
const CHART = [{ number: '1000', name: 'Cash', type: 'asset' }];

type Reply = {
  content: unknown[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
};
const scripted = (replies: Reply[]) => {
  const calls: AiCreateParams[] = [];
  const client: MigrationAiClient = {
    create: jest.fn(async (p: AiCreateParams) => {
      calls.push(JSON.parse(JSON.stringify(p)));
      const r = replies.shift();
      if (!r) throw new Error('no more scripted replies');
      return {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: p.model,
        content: r.content,
        stop_reason: r.stop_reason,
        usage: r.usage ?? { input_tokens: 100, output_tokens: 20 },
      } as never;
    }),
  };
  return { client, calls };
};
const use = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

const session = (
  client: MigrationAiClient,
  maxCalls = 10,
  serverFallback = false,
) =>
  new AiMappingSession(client, {
    model: 'model-from-env',
    maxCalls,
    serverFallback,
    sheets: SHEETS,
    chart: CHART,
    uncertain: {
      sheets: [
        { sheet: 'Party Balances', current: 'open_invoices', confidence: 0.6 },
      ],
      columns: [
        {
          sheet: 'Party Balances',
          header: 'Balance Due',
          current: null,
          confidence: 0,
        },
      ],
      accounts: [
        { number: '1500', name: 'Furniture' },
        { number: '2100', name: 'Loan' },
      ],
    },
  });

describe('AiMappingSession', () => {
  it('runs the tool loop, answers read tools from the staged sheets, and validates proposals', async () => {
    const { client, calls } = scripted([
      {
        stop_reason: 'tool_use',
        content: [
          use('t1', 'get_target_schema', {}),
          use('t2', 'inspect_sheet', { sheet: 'Party Balances' }),
          use('t3', 'list_chart_of_accounts', {}),
        ],
      },
      {
        stop_reason: 'tool_use',
        content: [
          use('t4', 'propose_mapping', {
            sheets: [
              {
                sheet: 'Party Balances',
                target: 'open_invoices',
                confidence: 0.97,
                reason: 'invoice numbers and balances per party',
              },
              {
                sheet: 'Nope',
                target: 'customers',
                confidence: 0.9,
                reason: 'x',
              },
              {
                sheet: 'Mystery',
                target: 'not_a_sheet',
                confidence: 0.9,
                reason: 'x',
              },
            ],
            columns: [
              {
                sheet: 'Party Balances',
                header: 'Balance Due',
                field: 'amountDue',
                confidence: 0.95,
                reason: 'balance still owed',
                amount: '45000',
              },
              {
                sheet: 'Party Balances',
                header: 'Missing',
                field: 'amountDue',
                confidence: 0.9,
                reason: 'x',
              },
              {
                sheet: 'Party Balances',
                header: 'Inv No',
                field: 'notAField',
                confidence: 0.9,
                reason: 'x',
              },
            ],
            accounts: [
              {
                source: '1500',
                target: 'NEW:asset',
                confidence: 0.93,
                reason: 'furniture is a fixed asset',
              },
              {
                source: '2100',
                target: 'NEW:liability',
                confidence: 0.85,
                reason: 'a loan; short- or long-term unclear',
              },
              {
                source: '9999',
                target: '1000',
                confidence: 0.99,
                reason: 'not asked about',
              },
              {
                source: '1500',
                target: '7777',
                confidence: 0.99,
                reason: 'not in the chart',
              },
            ],
          }),
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
    ]);
    const r = await session(client).run();

    expect(r.calls).toBe(3);
    expect(r.inputTokens).toBe(300);
    expect(r.outputTokens).toBe(60);
    expect(r.sheets).toEqual([
      {
        sheet: 'Party Balances',
        target: 'open_invoices',
        confidence: 0.97,
        reason: 'invoice numbers and balances per party',
      },
    ]);
    // Only the mapping survives: the stray "amount" the model attached is never read.
    expect(r.columns).toEqual([
      {
        sheet: 'Party Balances',
        header: 'Balance Due',
        field: 'amountDue',
        confidence: 0.95,
        reason: 'balance still owed',
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('45000');
    expect(r.accounts.map((a) => [a.source, a.target, a.confidence])).toEqual([
      ['1500', 'NEW:asset', 0.93],
      ['2100', 'NEW:liability', 0.85],
    ]);
    expect(r.rejected.map((x) => x.why)).toEqual(
      expect.arrayContaining([
        'unknown sheet',
        'unknown target sheet',
        'no such header on that sheet',
        'not a field of the sheet it is on',
        'not one of the accounts asked about',
        'not an account in the chart, nor NEW:<type>',
      ]),
    );

    // The model sees at most 20 sample rows, never the whole sheet.
    const toolResults = calls[1].messages.at(-1)!.content as Array<{
      tool_use_id: string;
      content: string;
    }>;
    const inspected = JSON.parse(
      toolResults.find((t) => t.tool_use_id === 't2')!.content,
    );
    expect(inspected.sampleRows).toHaveLength(20);
    // The model id comes from configuration; tools are strict; no forced tool choice.
    expect(calls[0].model).toBe('model-from-env');
    expect(
      calls[0].tools!.every((t) => (t as { strict?: boolean }).strict === true),
    ).toBe(true);
    expect(calls[0].tool_choice).toBeUndefined();
    expect((calls[0] as { betas?: unknown }).betas).toBeUndefined();
  });

  it('stops at the call cap and on a refusal, keeping what was proposed', async () => {
    const capped = scripted([
      {
        stop_reason: 'tool_use',
        content: [use('t1', 'get_target_schema', {})],
      },
    ]);
    const r1 = await session(capped.client, 1).run();
    expect(r1.calls).toBe(1);
    expect(capped.client.create).toHaveBeenCalledTimes(1);

    const refused = scripted([{ stop_reason: 'refusal', content: [] }]);
    const r2 = await session(refused.client).run();
    expect(r2.calls).toBe(1);
    expect(r2.stopReason).toBe('refusal');
    expect(r2.sheets).toEqual([]);

    const none = scripted([]);
    expect((await session(none.client, 0).run()).calls).toBe(0);
    expect(none.client.create).not.toHaveBeenCalled();
  });

  it('records questions for the owner and opts into the server-side fallback when configured', async () => {
    const { client, calls } = scripted([
      {
        stop_reason: 'tool_use',
        content: [
          use('t1', 'ask_user', {
            question: 'Is "Mystery" a stock count or a price list?',
            sheet: 'Mystery',
            options: ['Stock count', 'Price list'],
          }),
        ],
      },
      { stop_reason: 'end_turn', content: [] },
    ]);
    const r = await session(client, 10, true).run();
    expect(r.questions).toEqual([
      {
        question: 'Is "Mystery" a stock count or a price list?',
        sheet: 'Mystery',
        options: ['Stock count', 'Price list'],
      },
    ]);
    expect(
      (calls[0] as { betas?: string[]; fallbacks?: string }).betas,
    ).toEqual(['server-side-fallback-2026-07-01']);
    expect((calls[0] as { fallbacks?: string }).fallbacks).toBe('default');
  });
});
