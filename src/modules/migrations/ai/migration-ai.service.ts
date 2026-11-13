import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { StorageService } from '../../../common/storage/storage.service';
import { envFlag, envString } from '../../../common/utils/env.util';
import { Account } from '../../accounts/entities/account.entity';
import {
  AI_QUESTION_CODE,
  stableIssueId,
} from '../analysis/migration-analysis.service';
import { MigrationBatch } from '../entities/migration-batch.entity';
import { MigrationFile } from '../entities/migration-file.entity';
import { MigrationIssue } from '../entities/migration-issue.entity';
import {
  MAPPING_CONFIDENT,
  MigrationMapping,
} from '../entities/migration-mapping.entity';
import { headerLabel } from '../mapping/sheet-detector';
import { rawCell } from '../mapping/normalize-rows';
import { parseAmount } from '../parsers/amount.parser';
import { parseDate } from '../parsers/date.parser';
import { readUpload } from '../readers/read-upload';
import {
  AiMappingSession,
  MAX_SAMPLE_ROWS,
  MigrationAiClient,
  SessionResult,
  SheetView,
  UncertainItems,
} from './ai-mapping-session';

export const MIGRATION_AI_CLIENT = Symbol('MIGRATION_AI_CLIENT');

export interface AssistOutcome {
  ran: boolean;
  reason?: string;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  proposals?: number;
  questions?: number;
  belowConfidence?: number;
}

/**
 * The optional AI mapping assistant (§B3).
 *
 * Off unless MIGRATION_AI_ENABLED=true AND an API key AND MIGRATION_AI_MODEL
 * are configured; without them the Migration Center runs on its deterministic
 * rules alone, unchanged. It is consulted only for what the rules and the
 * company's saved profile left uncertain, sees at most 20 sample rows of a
 * sheet, and returns mappings only. Its proposals are stored with origin
 * `ai` and their confidence; below 0.9 the owner is asked. Every amount and
 * date still comes from the files through the deterministic parsers, and the
 * ten checks still decide whether anything can be imported.
 *
 * Calls are capped per batch (MIGRATION_AI_MAX_CALLS, default 10) and the
 * token usage of each call is added to the batch and logged.
 */
@Injectable()
export class MigrationAiService {
  private readonly logger = new Logger(MigrationAiService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    @Optional()
    @Inject(MIGRATION_AI_CLIENT)
    private readonly client: MigrationAiClient | null,
  ) {}

  enabled(): boolean {
    return (
      envFlag(this.config, 'MIGRATION_AI_ENABLED', false) &&
      !!this.client &&
      !!envString(this.config, 'MIGRATION_AI_MODEL')
    );
  }

  async assist(batchId: string, companyId: string): Promise<AssistOutcome> {
    if (!this.enabled()) return { ran: false, reason: 'disabled' };
    const em = this.dataSource.manager;
    const batch = await em.findOneOrFail(MigrationBatch, {
      where: { id: batchId, companyId },
    });
    const maxCalls = Math.max(
      0,
      Number(this.config.get('MIGRATION_AI_MAX_CALLS') ?? 10),
    );
    const remaining = maxCalls - batch.aiCalls;
    if (remaining <= 0)
      return { ran: false, reason: 'call limit reached for this migration' };

    const mappings = await em.find(MigrationMapping, {
      where: { batchId, companyId },
    });
    const issues = await em.find(MigrationIssue, {
      where: { batchId, companyId },
    });
    const sheets = await this.sheetViews(batchId, companyId, mappings);
    const uncertain = uncertainItems(mappings, issues, sheets);
    if (
      !uncertain.sheets.length &&
      !uncertain.columns.length &&
      !uncertain.accounts.length
    ) {
      return { ran: false, reason: 'nothing uncertain' };
    }
    const chart = (
      await em.find(Account, {
        where: { companyId, isActive: true },
        order: { accountNumber: 'ASC' },
      })
    ).map((a) => ({ number: a.accountNumber, name: a.name, type: a.type }));

    let result: SessionResult;
    try {
      result = await new AiMappingSession(this.client!, {
        model: envString(this.config, 'MIGRATION_AI_MODEL'),
        maxCalls: remaining,
        serverFallback: envFlag(
          this.config,
          'MIGRATION_AI_SERVER_FALLBACK',
          true,
        ),
        sheets,
        chart,
        uncertain,
      }).run();
    } catch (err) {
      // The assistant is a convenience: if the API fails, the deterministic mapping stands.
      this.logger.warn(
        `AI mapping assistant failed for batch ${batchId}: ${(err as Error).message}`,
      );
      return { ran: false, reason: 'the assistant could not be reached' };
    }

    await this.store(batchId, companyId, result, mappings);
    await em.query(
      `UPDATE migration_batches SET ai_calls = ai_calls + $2, ai_input_tokens = ai_input_tokens + $3, ai_output_tokens = ai_output_tokens + $4 WHERE id = $1`,
      [batchId, result.calls, result.inputTokens, result.outputTokens],
    );
    const proposals =
      result.sheets.length + result.columns.length + result.accounts.length;
    const belowConfidence = [
      ...result.sheets,
      ...result.columns,
      ...result.accounts,
    ].filter((p) => p.confidence < MAPPING_CONFIDENT).length;
    this.logger.log(
      `AI mapping assistant, batch ${batchId}: ${result.calls} call(s), ${result.inputTokens} input / ${result.outputTokens} output tokens, ${proposals} proposal(s) (${belowConfidence} below ${MAPPING_CONFIDENT}), ${result.questions.length} question(s), ${result.rejected.length} rejected, stop ${result.stopReason}`,
    );
    return {
      ran: true,
      calls: result.calls,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      proposals,
      questions: result.questions.length,
      belowConfidence,
    };
  }

  /** Proposals replace earlier AI proposals on the same key; owner decisions are never touched. */
  private async store(
    batchId: string,
    companyId: string,
    r: SessionResult,
    existing: MigrationMapping[],
  ) {
    await this.dataSource.transaction(async (em) => {
      const userKeys = new Set(
        existing
          .filter((m) => m.origin === 'user')
          .map((m) => `${m.kind}|${m.sheet}|${m.source}`),
      );
      const rows: Array<{
        kind: 'sheet' | 'column' | 'account';
        sheet: string;
        source: string;
        target: string | null;
        confidence: number;
        reason: string;
      }> = [
        ...r.sheets.map((p) => ({
          kind: 'sheet' as const,
          sheet: '',
          source: p.sheet,
          target: p.target,
          confidence: p.confidence,
          reason: p.reason,
        })),
        ...r.columns.map((p) => ({
          kind: 'column' as const,
          sheet: p.sheet,
          source: p.header,
          target: p.field,
          confidence: p.confidence,
          reason: p.reason,
        })),
        ...r.accounts.map((p) => ({
          kind: 'account' as const,
          sheet: '',
          source: p.source,
          target: p.target,
          confidence: p.confidence,
          reason: p.reason,
        })),
      ];
      for (const row of rows) {
        if (userKeys.has(`${row.kind}|${row.sheet}|${row.source}`)) continue;
        await em.delete(MigrationMapping, {
          batchId,
          companyId,
          kind: row.kind,
          sheet: row.sheet,
          source: row.source,
        });
        await em.save(
          em.create(MigrationMapping, {
            companyId,
            batchId,
            kind: row.kind,
            sheet: row.sheet,
            source: row.source.slice(0, 255),
            target: row.target?.slice(0, 128) ?? null,
            confidence: row.confidence.toFixed(3),
            origin: 'ai',
            reason: row.reason,
            confirmed: false,
          }),
        );
      }
      for (const q of r.questions) {
        const id = stableIssueId(batchId, `${AI_QUESTION_CODE}|${q.question}`);
        await em.delete(MigrationIssue, { id });
        await em.save(
          em.create(MigrationIssue, {
            id,
            companyId,
            batchId,
            code: AI_QUESTION_CODE,
            severity: 'warning',
            sheet: q.sheet,
            rowNumber: null,
            field: null,
            message: q.question,
            options: q.options.map((o) => ({ value: o, label: o })),
            resolution: null,
            resolvedAt: null,
          }),
        );
      }
    });
  }

  /** What the assistant may see of each sheet: headers, ≤20 rows as text, simple stats. */
  private async sheetViews(
    batchId: string,
    companyId: string,
    mappings: MigrationMapping[],
  ): Promise<SheetView[]> {
    const files = await this.dataSource.manager.find(MigrationFile, {
      where: { batchId, companyId },
    });
    const out: SheetView[] = [];
    for (const f of files) {
      const stored = await this.storage.read(f.storageKey);
      if (!stored) continue;
      const chunks: Buffer[] = [];
      for await (const c of stored.stream)
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      let contents;
      try {
        contents = await readUpload(Buffer.concat(chunks), f.originalName);
      } catch {
        continue;
      }
      for (const grid of contents.sheets) {
        const detected = (f.detected ?? []).find((d) => d.sheet === grid.name);
        const headerIndex = Math.max(
          0,
          grid.rows.findIndex(
            (r) =>
              r.cells.map(headerLabel).join('|') ===
              (detected?.headers ?? []).join('|'),
          ),
        );
        const headers = (
          detected?.headers?.length
            ? detected.headers
            : (grid.rows[0]?.cells.map(headerLabel) ?? [])
        ).map((h) => h ?? '');
        const data = grid.rows.slice(headerIndex + 1);
        const sample = data
          .slice(0, MAX_SAMPLE_ROWS)
          .map((r) => headers.map((_, i) => String(rawCell(r.cells[i]) ?? '')));
        const stats = headers.map((h, i) => {
          const vals = data
            .map((r) => rawCell(r.cells[i]))
            .filter((v) => v !== null && v !== '');
          const numeric = vals.filter((v) => {
            const p = parseAmount(v);
            return p.ok && !!p.amount;
          }).length;
          const dates = vals.filter((v) => {
            const p = parseDate(v, 'dmy');
            return p.ok && !!p.iso;
          }).length;
          return {
            header: h,
            filled: vals.length,
            numericShare: vals.length ? round2(numeric / vals.length) : 0,
            dateShare: vals.length ? round2(dates / vals.length) : 0,
          };
        });
        const sheetMap = mappings.find(
          (m) => m.kind === 'sheet' && m.source === grid.name,
        );
        out.push({
          name: grid.name,
          headers,
          sampleRows: sample,
          rowCount: data.length,
          stats,
          currentTarget: detected?.target ?? sheetMap?.target ?? null,
          currentConfidence:
            detected?.confidence ?? Number(sheetMap?.confidence ?? 0),
        });
      }
    }
    return out;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What the rules (and profile) left uncertain — the only things the assistant is asked about. */
export function uncertainItems(
  mappings: MigrationMapping[],
  issues: MigrationIssue[],
  sheets: SheetView[],
): UncertainItems {
  const decided = new Set(
    mappings
      .filter((m) => m.origin === 'user')
      .map((m) => `${m.kind}|${m.sheet}|${m.source}`),
  );
  const sheetItems = sheets
    .filter(
      (s) =>
        !decided.has(`sheet||${s.name}`) &&
        s.currentConfidence < MAPPING_CONFIDENT &&
        s.headers.some((h) => h.trim()),
    )
    .map((s) => ({
      sheet: s.name,
      current: s.currentTarget,
      confidence: s.currentConfidence,
    }));
  const columnItems = mappings
    .filter(
      (m) =>
        m.kind === 'column' &&
        m.origin === 'rule' &&
        (m.target === null || Number(m.confidence) < MAPPING_CONFIDENT) &&
        m.source.trim(),
    )
    .map((m) => ({
      sheet: m.sheet,
      header: m.source,
      current: m.target,
      confidence: Number(m.confidence),
    }));
  const accounts = issues
    .filter(
      (i) => i.code === 'UNKNOWN_ACCOUNT' && i.field?.startsWith('account::'),
    )
    .map((i) => {
      const number = i.field!.slice('account::'.length);
      const name = /\(([^)]+)\)/.exec(i.message)?.[1] ?? null;
      return { number, name };
    });
  const lowAccounts = mappings
    .filter(
      (m) =>
        m.kind === 'account' &&
        m.origin === 'rule' &&
        Number(m.confidence) < MAPPING_CONFIDENT,
    )
    .map((m) => ({ number: m.source, name: null }));
  return {
    sheets: sheetItems,
    columns: columnItems,
    accounts: [...accounts, ...lowAccounts],
  };
}
