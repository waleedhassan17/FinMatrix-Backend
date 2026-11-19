import type Anthropic from '@anthropic-ai/sdk';
import { TARGET_SHEETS } from '../targets';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolResultBlockParam =
  Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
export type AiCreateParams =
  Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The one call the assistant makes; a test passes a fake. */
export interface MigrationAiClient {
  create(params: AiCreateParams): Promise<BetaMessage>;
}

/** A source sheet as the assistant may see it — never more than this. */
export interface SheetView {
  name: string;
  headers: string[];
  /** Up to MAX_SAMPLE_ROWS data rows, as text, in header order. */
  sampleRows: string[][];
  rowCount: number;
  /** Per header: share of non-empty cells that look like numbers / dates. */
  stats: Array<{
    header: string;
    filled: number;
    numericShare: number;
    dateShare: number;
  }>;
  currentTarget: string | null;
  currentConfidence: number;
}

export interface UncertainItems {
  sheets: Array<{ sheet: string; current: string | null; confidence: number }>;
  columns: Array<{
    sheet: string;
    header: string;
    current: string | null;
    confidence: number;
  }>;
  accounts: Array<{ number: string; name: string | null }>;
}

export interface ChartAccount {
  number: string;
  name: string;
  type: string;
}

export interface AiSheetProposal {
  sheet: string;
  target: string | null;
  confidence: number;
  reason: string;
}
export interface AiColumnProposal {
  sheet: string;
  header: string;
  field: string | null;
  confidence: number;
  reason: string;
}
export interface AiAccountProposal {
  source: string;
  target: string;
  confidence: number;
  reason: string;
}
export interface AiQuestion {
  question: string;
  sheet: string | null;
  options: string[];
}

export interface SessionResult {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  sheets: AiSheetProposal[];
  columns: AiColumnProposal[];
  accounts: AiAccountProposal[];
  questions: AiQuestion[];
  rejected: Array<{ kind: string; item: unknown; why: string }>;
}

export const MAX_SAMPLE_ROWS = 20;

const SYSTEM_PROMPT = `You help a business owner move their accounting books into FinMatrix. You map the columns and sheets of their exported spreadsheets onto FinMatrix's import format, and their source chart of accounts onto FinMatrix's.

You only propose MAPPINGS: which sheet a source sheet is, which field a source column holds, and which FinMatrix account a source account corresponds to. You never produce, correct, compute or infer an amount, a quantity or a date - those are always read from the files by FinMatrix itself. If a column's meaning is unclear, give it a low confidence or ask the owner with ask_user; do not guess with high confidence.

Confidence is your probability that the mapping is right: 0.95 or more only when the header, sheet name and sample values all agree. Anything below 0.9 is shown to the owner for confirmation. Give a one-line reason for every proposal.

Start with get_target_schema. Use inspect_sheet for each sheet you need to understand, and list_chart_of_accounts before proposing account mappings. Finish by calling propose_mapping once with everything you can propose, then stop.`;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const AI_TOOLS: BetaTool[] = [
  {
    name: 'inspect_sheet',
    description: `Return one uploaded sheet: its name, headers, at most ${MAX_SAMPLE_ROWS} sample rows and per-column statistics. Never the whole file.`,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        sheet: {
          type: 'string',
          description: 'Exact sheet name as listed in the task.',
        },
      },
      required: ['sheet'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_target_schema',
    description:
      'Return the FinMatrix import format: the target sheets and their fields, with descriptions.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'list_chart_of_accounts',
    description:
      "Return the company's FinMatrix chart of accounts (number, name, type).",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_mapping',
    description:
      'Record your proposals. sheets: source sheet -> target sheet key (or null to skip it). columns: source header -> target field key (or null to leave it out). accounts: source account number -> FinMatrix account number, or "NEW:<type>" to create it (type one of asset, liability, equity, revenue, expense). Each with confidence 0-1 and a one-line reason. Mappings only: no amounts, quantities or dates.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string' },
              target: nullableString,
              confidence: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['sheet', 'target', 'confidence', 'reason'],
            additionalProperties: false,
          },
        },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string' },
              header: { type: 'string' },
              field: nullableString,
              confidence: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['sheet', 'header', 'field', 'confidence', 'reason'],
            additionalProperties: false,
          },
        },
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              target: { type: 'string' },
              confidence: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['source', 'target', 'confidence', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['sheets', 'columns', 'accounts'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the owner a clarifying question you cannot answer from the files. It is shown to them as an open question on the migration.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        sheet: nullableString,
        options: { type: 'array', items: { type: 'string' } },
      },
      required: ['question', 'sheet', 'options'],
      additionalProperties: false,
    },
  },
];

const clamp01 = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
};
const short = (v: unknown, n = 240) => String(v ?? '').slice(0, n);
const NEW_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

/**
 * One bounded conversation with the model about one batch's uncertain
 * mappings. Pure apart from the client: it holds the sheets in memory,
 * answers the read tools from them, and VALIDATES every proposal against the
 * target schema and chart before returning it. Anything that is not a
 * mapping — an amount, a date, an unknown field — is dropped, never stored.
 */
export class AiMappingSession {
  constructor(
    private readonly client: MigrationAiClient,
    private readonly opts: {
      model: string;
      maxCalls: number;
      serverFallback: boolean;
      sheets: SheetView[];
      chart: ChartAccount[];
      uncertain: UncertainItems;
    },
  ) {}

  async run(): Promise<SessionResult> {
    const result: SessionResult = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      stopReason: null,
      sheets: [],
      columns: [],
      accounts: [],
      questions: [],
      rejected: [],
    };
    if (this.opts.maxCalls <= 0) return result;
    const messages: BetaMessageParam[] = [
      { role: 'user', content: this.taskText() },
    ];

    while (result.calls < this.opts.maxCalls) {
      const params: AiCreateParams = {
        model: this.opts.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: AI_TOOLS,
        messages,
        ...(this.opts.serverFallback
          ? {
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default' as const,
            }
          : {}),
      };
      const response = await this.client.create(params);
      result.calls += 1;
      result.inputTokens += response.usage?.input_tokens ?? 0;
      result.outputTokens += response.usage?.output_tokens ?? 0;
      result.stopReason = response.stop_reason;

      // A refusal or a cut-off answer ends the session; whatever was proposed so far stands.
      if (
        response.stop_reason === 'refusal' ||
        response.stop_reason === 'max_tokens'
      )
        break;
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason === 'pause_turn') continue;
      const uses = response.content.filter(
        (b): b is BetaToolUseBlock => b.type === 'tool_use',
      );
      if (uses.length === 0) break;
      const results: BetaToolResultBlockParam[] = uses.map((u) =>
        this.execute(u, result),
      );
      messages.push({ role: 'user', content: results });
      // propose_mapping is the last step the task asks for.
      if (uses.some((u) => u.name === 'propose_mapping')) {
        if (result.calls >= this.opts.maxCalls) break;
      }
    }
    return result;
  }

  private taskText(): string {
    const u = this.opts.uncertain;
    const lines = [
      `Sheets uploaded: ${this.opts.sheets.map((s) => `"${s.name}" (${s.rowCount} rows; currently ${s.currentTarget ?? 'not recognised'} at ${s.currentConfidence})`).join('; ')}.`,
    ];
    if (u.sheets.length)
      lines.push(
        `Sheets whose type is uncertain: ${u.sheets.map((s) => `"${s.sheet}" (best guess ${s.current ?? 'none'} at ${s.confidence})`).join('; ')}.`,
      );
    if (u.columns.length)
      lines.push(
        `Columns not mapped or uncertain: ${u.columns.map((c) => `"${c.sheet}" → "${c.header}" (best guess ${c.current ?? 'none'} at ${c.confidence})`).join('; ')}.`,
      );
    if (u.accounts.length)
      lines.push(
        `Source accounts with no FinMatrix account: ${u.accounts.map((a) => `${a.number}${a.name ? ` "${a.name}"` : ''}`).join('; ')}.`,
      );
    lines.push(
      'Propose mappings for these items only. Leave everything else as it is.',
    );
    return lines.join('\n');
  }

  private execute(
    use: BetaToolUseBlock,
    result: SessionResult,
  ): BetaToolResultBlockParam {
    const input = (use.input ?? {}) as Record<string, unknown>;
    const ok = (content: unknown): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: use.id,
      content: JSON.stringify(content),
    });
    const err = (message: string): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: use.id,
      content: message,
      is_error: true,
    });
    switch (use.name) {
      case 'inspect_sheet': {
        const sheet = this.opts.sheets.find((s) => s.name === input.sheet);
        if (!sheet)
          return err(
            `No sheet named "${String(input.sheet)}". Sheets: ${this.opts.sheets.map((s) => s.name).join(', ')}`,
          );
        return ok({
          name: sheet.name,
          headers: sheet.headers,
          sampleRows: sheet.sampleRows.slice(0, MAX_SAMPLE_ROWS),
          rowCount: sheet.rowCount,
          stats: sheet.stats,
        });
      }
      case 'get_target_schema':
        return ok(
          TARGET_SHEETS.map((t) => ({
            key: t.key,
            name: t.name,
            purpose: t.purpose,
            fields: t.fields.map((f) => ({
              key: f.key,
              header: f.header,
              required: !!f.required,
              kind: f.kind,
              description: f.description,
              ...(f.enumValues ? { values: f.enumValues } : {}),
            })),
          })),
        );
      case 'list_chart_of_accounts':
        return ok(this.opts.chart);
      case 'propose_mapping':
        return ok(this.accept(input, result));
      case 'ask_user': {
        const question = short(input.question, 500).trim();
        if (!question) return err('The question is empty.');
        result.questions.push({
          question,
          sheet: typeof input.sheet === 'string' ? input.sheet : null,
          options: Array.isArray(input.options)
            ? input.options.slice(0, 6).map((o) => short(o, 120))
            : [],
        });
        return ok({ recorded: true });
      }
      default:
        return err(`Unknown tool ${use.name}.`);
    }
  }

  /** Keep only well-formed mappings onto real targets; report the rest back to the model. */
  private accept(input: Record<string, unknown>, result: SessionResult) {
    const sheetNames = new Set(this.opts.sheets.map((s) => s.name));
    const targetKeys = new Set(TARGET_SHEETS.map((t) => t.key as string));
    const chartNumbers = new Set(this.opts.chart.map((a) => a.number));
    let accepted = 0;
    const reject = (kind: string, item: unknown, why: string) =>
      result.rejected.push({ kind, item, why });

    for (const raw of Array.isArray(input.sheets) ? input.sheets : []) {
      const it = raw as Record<string, unknown>;
      const target = it.target === null ? null : String(it.target ?? '');
      if (!sheetNames.has(String(it.sheet))) {
        reject('sheet', it, 'unknown sheet');
        continue;
      }
      if (target !== null && !targetKeys.has(target)) {
        reject('sheet', it, 'unknown target sheet');
        continue;
      }
      result.sheets.push({
        sheet: String(it.sheet),
        target,
        confidence: clamp01(it.confidence),
        reason: short(it.reason),
      });
      accepted += 1;
    }
    for (const raw of Array.isArray(input.columns) ? input.columns : []) {
      const it = raw as Record<string, unknown>;
      const sheet = this.opts.sheets.find((s) => s.name === it.sheet);
      if (!sheet) {
        reject('column', it, 'unknown sheet');
        continue;
      }
      if (!sheet.headers.includes(String(it.header))) {
        reject('column', it, 'no such header on that sheet');
        continue;
      }
      const field = it.field === null ? null : String(it.field ?? '');
      const proposedTarget =
        result.sheets.find((p) => p.sheet === sheet.name)?.target ??
        sheet.currentTarget;
      const targetSheet = TARGET_SHEETS.find((t) => t.key === proposedTarget);
      if (
        field !== null &&
        (!targetSheet || !targetSheet.fields.some((f) => f.key === field))
      ) {
        reject('column', it, 'not a field of the sheet it is on');
        continue;
      }
      result.columns.push({
        sheet: sheet.name,
        header: String(it.header),
        field,
        confidence: clamp01(it.confidence),
        reason: short(it.reason),
      });
      accepted += 1;
    }
    const wanted = new Set(this.opts.uncertain.accounts.map((a) => a.number));
    for (const raw of Array.isArray(input.accounts) ? input.accounts : []) {
      const it = raw as Record<string, unknown>;
      const source = String(it.source ?? '');
      const target = String(it.target ?? '');
      if (!wanted.has(source)) {
        reject('account', it, 'not one of the accounts asked about');
        continue;
      }
      const valid = target.startsWith('NEW:')
        ? NEW_TYPES.includes(target.slice(4))
        : chartNumbers.has(target);
      if (!valid) {
        reject('account', it, 'not an account in the chart, nor NEW:<type>');
        continue;
      }
      result.accounts.push({
        source,
        target,
        confidence: clamp01(it.confidence),
        reason: short(it.reason),
      });
      accepted += 1;
    }
    return {
      accepted,
      rejected: result.rejected.map((r) => ({ kind: r.kind, why: r.why })),
    };
  }
}
