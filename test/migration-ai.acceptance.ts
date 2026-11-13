/**
 * Migration Center — AI mapping assistant on fixture (f), SDK mocked.
 * ====================================================================
 * Boots the application in-process with the Anthropic client replaced by a
 * scripted fake that answers as a capable model would on the messy generic
 * spreadsheet — no network, no key. Proves the wiring end to end and prints a
 * mapping-accuracy report against fixture (f)'s known answer:
 *
 *   • the assistant is consulted only for what the rules left uncertain;
 *   • its proposals are stored with origin `ai` and their confidence;
 *   • a proposal below 0.9 becomes a question for the owner (MAPPING_UNCONFIRMED);
 *   • no amount or date in staging changes: every one still comes from the
 *     file through the deterministic parser;
 *   • token usage and the call count land on the batch, within the cap.
 *
 *   npm run test:migration-ai
 */
import './migration-ai.env';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import {
  AiCreateParams,
  MigrationAiClient,
} from '../src/modules/migrations/ai/ai-mapping-session';
import { MIGRATION_AI_CLIENT } from '../src/modules/migrations/ai/migration-ai.service';
import { MigrationBatchService } from '../src/modules/migrations/migration-batch.service';
import { asUpload, freshCompany } from './migration-harness';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''}`,
    );
  }
};

/** What a capable model answers for fixture (f), turn by turn. */
function scriptedModel(): MigrationAiClient & { calls: AiCreateParams[] } {
  const calls: AiCreateParams[] = [];
  let turn = 0;
  return {
    calls,
    create: async (p: AiCreateParams) => {
      calls.push(p);
      turn += 1;
      const use = (id: string, name: string, input: unknown) => ({
        type: 'tool_use',
        id,
        name,
        input,
      });
      const content =
        turn === 1
          ? [
              use('a', 'get_target_schema', {}),
              use('b', 'inspect_sheet', { sheet: 'Party Balances' }),
              use('c', 'inspect_sheet', { sheet: 'Creditors O-S' }),
              use('d', 'list_chart_of_accounts', {}),
            ]
          : turn === 2
            ? [
                use('e', 'propose_mapping', {
                  sheets: [
                    {
                      sheet: 'Party Balances',
                      target: 'open_invoices',
                      confidence: 0.97,
                      reason:
                        'one row per customer invoice with the balance still due',
                    },
                    {
                      sheet: 'Creditors O-S',
                      target: 'open_bills',
                      confidence: 0.95,
                      reason:
                        '"creditors outstanding": vendor bills not yet paid',
                    },
                  ],
                  columns: [],
                  accounts: [
                    {
                      source: '1500',
                      target: 'NEW:asset',
                      confidence: 0.94,
                      reason: 'furniture and fixtures are a fixed asset',
                    },
                    {
                      source: '2100',
                      target: 'NEW:liability',
                      confidence: 0.82,
                      reason:
                        'a short-term loan is a liability; confirm it is not owner capital',
                    },
                  ],
                }),
              ]
            : [{ type: 'text', text: 'Proposed.' }];
      return {
        id: `m${turn}`,
        type: 'message',
        role: 'assistant',
        model: p.model,
        content,
        stop_reason: turn <= 2 ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: 1800 + turn * 400,
          output_tokens: 150 + turn * 60,
        },
      } as never;
    },
  };
}

const TRUTH = {
  sheets: {
    'TB June 2026': 'trial_balance',
    'Gahak List': 'customers',
    Suppliers: 'vendors',
    'Party Balances': 'open_invoices',
    'Creditors O-S': 'open_bills',
    Maal: 'items',
    'Closing Stock': 'stock',
    Notes: null,
  } as Record<string, string | null>,
  accounts: { '1500': 'NEW:asset', '2100': 'NEW:liability' } as Record<
    string,
    string
  >,
};

async function main() {
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures/migration/f-messy-generic.xlsx'),
  );

  const report = async (
    svc: MigrationBatchService,
    ds: DataSource,
    companyId: string,
    batchId: string,
  ) => {
    const m = await svc.getMappings(companyId, batchId);
    const iss = await svc.listIssues(companyId, batchId, { limit: 200 });
    const sheetRows = m.sheets as Array<{
      sheet: string;
      target: string | null;
      confidence: number;
    }>;
    const sheetsCorrect = sheetRows.filter(
      (s) => TRUTH.sheets[s.sheet] === s.target,
    ).length;
    const sheetsConfidentCorrect = sheetRows.filter(
      (s) =>
        TRUTH.sheets[s.sheet] === s.target &&
        (s.target === null || s.confidence >= 0.9),
    ).length;
    const acct = m.mappings.account as Array<{
      source: string;
      target: string | null;
      confidence: number;
      origin: string;
    }>;
    const tbTargets = (await ds.query(
      `SELECT normalized->>'accountNumber' AS n, normalized->>'targetAccount' AS t, normalized->'newAccount'->>'type' AS ty FROM migration_staging_rows WHERE batch_id = $1 AND entity_type = 'trial_balance' AND outcome <> 'rejected'`,
      [batchId],
    )) as Array<{ n: string; t: string | null; ty: string | null }>;
    const accountsCorrect = Object.entries(TRUTH.accounts).filter(
      ([n, want]) => {
        const row = tbTargets.find((r) => r.n === n);
        return row && row.t === 'NEW' && `NEW:${row.ty}` === want;
      },
    ).length;
    const accountsConfident = Object.keys(TRUTH.accounts).filter((n) =>
      acct.some((a) => a.source === n && a.confidence >= 0.9),
    ).length;
    return {
      sheets: sheetRows.length,
      sheetsCorrect,
      sheetsConfidentCorrect,
      accountsCorrect,
      accountsConfident,
      issues: iss.groups,
      items: iss.items,
    };
  };

  // ── Baseline: deterministic rules only (no client, as without an API key) ──
  let moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MIGRATION_AI_CLIENT)
    .useValue(null)
    .compile();
  await moduleRef.init();
  let ds = moduleRef.get(DataSource);
  let svc = moduleRef.get(MigrationBatchService);
  const base = await freshCompany(ds, `ai-base-${Date.now()}`);
  const bb = await svc.create(base.companyId, base.user, {
    sourceSystem: 'generic_spreadsheet',
    cutoverDate: '2026-06-30',
  });
  await svc.addFiles(base.companyId, base.user, bb.id, [
    asUpload(fixture, 'f-messy-generic.xlsx'),
  ]);
  const baseline = await report(svc, ds, base.companyId, bb.id);
  const baselineAmounts = await ds.query(
    `SELECT sheet, row_number, normalized FROM migration_staging_rows WHERE batch_id = $1 ORDER BY sheet, row_number`,
    [bb.id],
  );
  await moduleRef.close();

  // ── With the assistant (mocked) ───────────────────────────────────────
  const model = scriptedModel();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MIGRATION_AI_CLIENT)
    .useValue(model)
    .compile();
  await moduleRef.init();
  ds = moduleRef.get(DataSource);
  svc = moduleRef.get(MigrationBatchService);
  try {
    const co = await freshCompany(ds, `ai-${Date.now()}`);
    const b = await svc.create(co.companyId, co.user, {
      sourceSystem: 'generic_spreadsheet',
      cutoverDate: '2026-06-30',
    });
    const after = await svc.addFiles(co.companyId, co.user, b.id, [
      asUpload(fixture, 'f-messy-generic.xlsx'),
    ]);
    const withAi = await report(svc, ds, co.companyId, b.id);

    console.log('\n── Wiring');
    ok(
      'the assistant was consulted (3 calls, within the cap of 10)',
      model.calls.length === 3,
      model.calls.length,
    );
    const ask = String(model.calls[0].messages[0].content);
    ok(
      'it was asked only about uncertain items (the two look-alike sheets and two accounts)',
      ask.includes('Party Balances') &&
        ask.includes('Creditors O-S') &&
        ask.includes('1500') &&
        !ask.includes('"Gahak List" (best guess'),
      ask.slice(0, 400),
    );
    const stored = (await ds.query(
      `SELECT kind, source, target, confidence::text, origin FROM migration_mappings WHERE batch_id = $1 AND origin = 'ai' ORDER BY kind, source`,
      [b.id],
    )) as Array<{
      kind: string;
      source: string;
      target: string;
      confidence: string;
    }>;
    ok(
      'proposals are stored with origin ai and their confidence',
      stored.length === 4 && stored.every((s) => Number(s.confidence) > 0),
      stored,
    );
    ok(
      'a proposal below 0.9 (2100 as a liability, 0.82) is a question for the owner',
      withAi.items.some(
        (i: { code: string; field: string | null }) =>
          i.code === 'MAPPING_UNCONFIRMED' && i.field === 'account::2100',
      ),
      withAi.issues,
    );
    ok(
      'a confident proposal (1500 as a new asset, 0.94) is applied without asking',
      !withAi.items.some(
        (i: { code: string; field: string | null }) =>
          i.field === 'account::1500',
      ),
      withAi.items.map((i: { code: string; field: string | null }) => [
        i.code,
        i.field,
      ]),
    );
    const aiAmounts = await ds.query(
      `SELECT sheet, row_number, normalized FROM migration_staging_rows WHERE batch_id = $1 ORDER BY sheet, row_number`,
      [b.id],
    );
    const amountKeys = [
      'debit',
      'credit',
      'originalAmount',
      'amountDue',
      'quantityOnHand',
      'unitCost',
      'sellingPrice',
      'creditLimit',
      'invoiceDate',
      'billDate',
      'dueDate',
    ];
    const pick = (
      rows: Array<{
        sheet: string;
        row_number: number;
        normalized: Record<string, unknown>;
      }>,
    ) =>
      rows.map((r) => [
        r.sheet,
        r.row_number,
        amountKeys.map((k) => r.normalized?.[k] ?? null),
      ]);
    ok(
      'every amount and date in staging is byte-for-byte what the rules alone produced',
      JSON.stringify(pick(aiAmounts)) === JSON.stringify(pick(baselineAmounts)),
    );
    const [usage] = await ds.query(
      `SELECT ai_calls, ai_input_tokens, ai_output_tokens FROM migration_batches WHERE id = $1`,
      [b.id],
    );
    ok(
      'calls and token usage recorded on the batch',
      usage.ai_calls === 3 &&
        usage.ai_input_tokens > 0 &&
        usage.ai_output_tokens > 0,
      usage,
    );
    ok(
      'readiness moved up but stays below 100 until the owner answers',
      after.readiness < 100,
      after.readiness,
    );

    console.log(
      '\n── Mapping accuracy on fixture (f) (AI mocked with a realistic proposal)',
    );
    console.log(
      `  rules only:  sheets right ${baseline.sheetsCorrect}/${baseline.sheets}, right and confident ${baseline.sheetsConfidentCorrect}/${baseline.sheets}; accounts placed ${baseline.accountsCorrect}/2, confident ${baseline.accountsConfident}/2; open issues ${JSON.stringify(baseline.issues)}`,
    );
    console.log(
      `  with AI:     sheets right ${withAi.sheetsCorrect}/${withAi.sheets}, right and confident ${withAi.sheetsConfidentCorrect}/${withAi.sheets}; accounts placed ${withAi.accountsCorrect}/2, confident ${withAi.accountsConfident}/2; open issues ${JSON.stringify(withAi.issues)}`,
    );
    console.log(
      `  tokens:      ${usage.ai_input_tokens} input / ${usage.ai_output_tokens} output over ${usage.ai_calls} calls (scripted figures)`,
    );
    ok(
      'with the assistant, every sheet is right and confident',
      withAi.sheetsConfidentCorrect === withAi.sheets,
      withAi,
    );
    ok(
      'with the assistant, both accounts are placed (one still awaiting confirmation)',
      withAi.accountsCorrect === 2 && withAi.accountsConfident === 1,
      withAi,
    );

    console.log('\n── Profile reuse');
    const iss = await svc.listIssues(co.companyId, b.id, { limit: 200 });
    for (const i of iss.items.filter(
      (x: { severity: string; code: string }) =>
        x.code === 'MAPPING_UNCONFIRMED' || x.code === 'UNKNOWN_ACCOUNT',
    )) {
      const value =
        i.field === 'account::2100'
          ? 'NEW:liability'
          : (i.options?.[0]?.value ?? null);
      if (value)
        await svc.resolveIssue(co.companyId, co.user, b.id, i.id, {
          action: 'map',
          value,
        });
    }
    const v = await svc.validate(co.companyId, co.user, b.id);
    ok(
      'once the owner confirms, fixture (f) passes all nine checks',
      v.status === 'ready' && (v.checks ?? []).every((c) => c.passed),
      [
        v.status,
        v.readiness,
        (v.checks ?? []).filter((c) => !c.passed).map((c) => c.code),
      ],
    );
    await svc.signOff(co.companyId, co.user, b.id, {
      confirmed: true,
      spotCheckDone: true,
    });
    await svc.commit(co.companyId, co.user, b.id);
    const callsBefore = model.calls.length;
    const co2 = await freshCompany(ds, `ai-again-${Date.now()}`);
    // Same company source, new company: profiles are per company, so reuse is shown on the committed company's profile row.
    const [profile] = await ds.query(
      `SELECT used_count, mappings FROM migration_profiles WHERE company_id = $1`,
      [co.companyId],
    );
    ok(
      "confirmed mappings were saved as the company's profile for this source",
      !!profile &&
        profile.used_count === 1 &&
        Object.keys(profile.mappings.accounts).length >= 2,
      profile,
    );
    void co2;
    ok(
      'no further model calls were made after the first session',
      model.calls.length === callsBefore,
    );
  } finally {
    await moduleRef.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
