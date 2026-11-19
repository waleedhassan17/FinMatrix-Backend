import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { StorageService } from '../../../common/storage/storage.service';
import { companyFeatures } from '../../../common/features/company-features.util';
import { Account } from '../../accounts/entities/account.entity';
import { healLegacyCharts } from '../../accounts/legacy-roles.util';
import {
  SYS,
  SYSTEM_ACCOUNT_DEFS,
  type SystemRole,
} from '../../accounts/accounts.constants';

import { Customer } from '../../customers/entities/customer.entity';
import { InventoryItem } from '../../inventory/entities/inventory-item.entity';
import { Vendor } from '../../vendors/entities/vendor.entity';
import {
  MigrationBatch,
  MigrationCounts,
} from '../entities/migration-batch.entity';
import { MigrationFile } from '../entities/migration-file.entity';
import { MigrationIssue } from '../entities/migration-issue.entity';
import {
  MAPPING_CONFIDENT,
  MigrationMapping,
} from '../entities/migration-mapping.entity';
import { MigrationProfile } from '../entities/migration-profile.entity';
import {
  MigrationEntityType,
  MigrationStagingRow,
  StagingOutcome,
} from '../entities/migration-staging-row.entity';
import { IssueDraft, issueKey, MIGRATION_CODES } from '../issues';
import { mapColumns, missingFields } from '../mapping/column-mapper';
import { normalizeRows, NormalizedRow } from '../mapping/normalize-rows';
import { detectSheet } from '../mapping/sheet-detector';
import { planChart, roleLabel } from '../mapping/chart-plan';
import { enumOptions, mapEnumValue } from '../mapping/value-mapper';
import { matchMasters, nearestMasters } from '../matching/master-matcher';
import { parseAmount, parseQuantity } from '../parsers/amount.parser';
import { parseDate } from '../parsers/date.parser';
import { readbackAgrees, ReadbackOrder } from '../parsers/readback';
import { lockEditable } from '../state-machine';
import { CHECK_CODES } from '../validation/migration-checks.service';
import { normalizeKey } from '../parsers/text-normalize';
import { readUpload, SourceGrid } from '../readers/read-upload';
import { parseTallyDocuments } from '../sources/tally/tally-xml.parser';
import { PeachtreeExtract } from '../sources/peachtree/peachtree-books';
import {
  detectPeachtreeReport,
  ParsedReport,
  parsePeachtreeReport,
  REPORT_TITLES,
} from '../sources/peachtree/peachtree-reports';
import { buildPeachtreeSheets } from '../sources/peachtree/peachtree-sheets';
import { buildCanonical } from '../sources/reports/canonical';
import { REPORT_PROFILES } from '../sources/reports/profiles';
import {
  isStarterSheet,
  ParsedSourceReport,
  parseSourceReport,
  recogniseReport,
} from '../sources/reports/report-engine';
import { clampMonth } from '../../reports/fiscal-year';
import { Company } from '../../companies/entities/company.entity';
import { ConfigService } from '@nestjs/config';
import { TARGET_SHEETS, targetSheet, TargetSheet } from '../targets';
import { MappingContext } from './mapping-context';
import type { SourceExtract } from '../uploads/export-reader';
import { openingDateOf } from '../opening-date';

interface ExistingMasters {
  invoiceNumbers: Set<string>;
  customers: Array<{ id: string; code: string | null; name: string }>;
  vendors: Array<{ id: string; code: string | null; name: string }>;
  items: Array<{
    id: string;
    code: string | null;
    name: string;
    sku: string;
    hasStock: boolean;
  }>;
  accounts: Array<{
    id: string;
    accountNumber: string;
    name: string;
    type: string;
    subType: string | null;
    systemRole: string | null;
    isActive: boolean;
  }>;
}

interface SheetWork {
  grid: SourceGrid;
  fileId: string;
  target: TargetSheet;
  rows: NormalizedRow[];
}

/**
 * From uploaded files to staging rows, mappings and issues — recomputed in
 * full every time something changes, so there is one answer for a batch and
 * it is always the current one.
 *
 * The owner's decisions (origin user) and the company's saved profile are
 * read first and never overwritten; everything else — detections, rule and
 * AI proposals, issues — is deleted and rebuilt. A fix therefore never has
 * to "undo" a proposal; it simply outranks it on the next pass.
 */
@Injectable()
export class MigrationAnalysisService {
  private readonly logger = new Logger(MigrationAnalysisService.name);

  /** The file limit the upload enforced; every later read applies the same one. */
  private readonly maxBytes: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.maxBytes = Number(
      config.get('MIGRATION_MAX_FILE_BYTES') ?? 26_214_400,
    );
  }

  async analyse(batchId: string, companyId: string): Promise<MigrationBatch> {
    // The chart plan matches the owner's accounts to FinMatrix's by role, so a
    // chart an older release wrote without roles takes them first (see
    // legacy-roles.util.ts). Outside the transaction below, which can run for
    // a while and must not hold this company's accounts locked meanwhile.
    await healLegacyCharts(this.dataSource.manager, [companyId]);
    return this.dataSource.transaction(async (em) => {
      // Locked and re-checked here, not trusted from the caller's earlier
      // read: an analysis must never rebuild the staging rows of, or reset
      // the status of, a batch a concurrent request has committed.
      const batch = await lockEditable(em, companyId, batchId);
      const files = await em.find(MigrationFile, {
        where: { batchId, companyId },
        order: { createdAt: 'ASC' },
      });
      const userMappings = await em.find(MigrationMapping, {
        where: { batchId, companyId, origin: 'user' },
      });
      const profile = await em.findOne(MigrationProfile, {
        where: { companyId, sourceSystem: batch.sourceSystem },
        order: { lastUsedAt: 'DESC' },
      });
      const ctx = MappingContext.from(userMappings, profile?.mappings ?? null);

      // Start clean: rule proposals and issues are derived and rebuilt. The
      // owner's decisions and the AI assistant's proposals (and questions)
      // are inputs, so they are kept.
      const aiMappings = await em.find(MigrationMapping, {
        where: { batchId, companyId, origin: 'ai' },
      });
      const ai = AiProposals.from(aiMappings);
      await em.delete(MigrationStagingRow, { batchId, companyId });
      await em.delete(MigrationIssue, {
        batchId,
        companyId,
        code: Not(AI_QUESTION_CODE),
      });
      await em.delete(MigrationMapping, {
        batchId,
        companyId,
        origin: Not(In(['user', 'ai'])),
      });

      const issues = new Map<string, IssueDraft>();
      const addIssue = (i: IssueDraft) => {
        const k = issueKey(i);
        if (!issues.has(k)) issues.set(k, i);
      };
      const proposals: Array<Partial<MigrationMapping>> = [];
      const addProposal = (p: Partial<MigrationMapping>) => proposals.push(p);

      // ── 1. Read every file and decide what each sheet is ──────────────
      // Tally exports are read together first: the masters give the trial
      // balance, the bills and the stock summary their meaning.
      // Where this company keeps its system accounts now: a source without
      // account numbers lands on them.
      const roleNumbers = await this.roleNumbers(em, companyId);
      const tally = await this.tallyGrids(files, roleNumbers);
      for (const w of tally.warnings) {
        addIssue({
          code: MIGRATION_CODES.MIGRATION_UNKNOWN_SHEET,
          severity: 'warning',
          sheet: null,
          message: w,
        });
      }
      const works: SheetWork[] = [];
      const detectedByFile = new Map<string, MigrationFile['detected']>();
      // A Peachtree backup is read last: Peachtree's own reports, in the other
      // files, are its proof and give its stock values, so they must be read
      // first. They are recognised only when a backup is present — without
      // one, Peachtree reports are ordinary spreadsheets, read as before.
      const hasBackup = files.some((f) => f.kind === 'ptb');
      const peachtreeReports: ParsedReport[] = [];
      const proofStaging: Array<Partial<MigrationStagingRow>> = [];
      // Report exports from any system (trial balance, aged detail,
      // valuation, lists) are recognised before the generic detector and
      // turned into the starter sheets. Beside a Peachtree backup its reports
      // are the backup's proof instead (below).
      const reportPass = hasBackup
        ? null
        : await this.sourceReportGrids(
            em,
            batch,
            files,
            ctx,
            addIssue,
            proofStaging,
            roleNumbers,
          );
      const ordered = [
        ...files.filter((f) => f.kind !== 'ptb'),
        ...files.filter((f) => f.kind === 'ptb'),
      ];
      for (const file of ordered) {
        const stored = await this.storage.read(file.storageKey);
        if (!stored) {
          addIssue({
            code: MIGRATION_CODES.MIGRATION_FILE_UNREADABLE,
            severity: 'blocking',
            sheet: file.originalName,
            message: `${file.originalName} is no longer in storage. Remove it and upload it again.`,
          });
          continue;
        }
        const buffer = await streamToBuffer(stored.stream);
        let contents;
        try {
          contents =
            file.kind === 'ptb'
              ? await this.peachtreeContents(em, batch, file, buffer, {
                  reports: peachtreeReports,
                  ctx,
                  addIssue,
                  proof: proofStaging,
                })
              : (reportPass?.contents.get(file.id) ??
                (await this.readContents(file, buffer)));
        } catch (err) {
          const body = (
            err as { response?: { code?: string; message?: string } }
          ).response;
          addIssue({
            code:
              (body?.code as IssueDraft['code']) ??
              MIGRATION_CODES.MIGRATION_FILE_UNREADABLE,
            severity: 'blocking',
            sheet: file.originalName,
            message: body?.message ?? `${file.originalName} could not be read.`,
          });
          continue;
        }
        const detected: NonNullable<MigrationFile['detected']> = [];
        const asReport = reportPass?.recognised.get(file.id);
        contents.sheets.push(...(tally.byFile.get(file.id) ?? []));
        contents.sheets.push(...(reportPass?.byFile.get(file.id) ?? []));
        for (const grid of contents.sheets) {
          const reportTarget = asReport?.get(grid.name);
          if (reportTarget) {
            detected.push({
              sheet: grid.name,
              target: reportTarget,
              confidence: 1,
              rows: grid.rows.length,
              headers: [],
            });
            continue;
          }
          if (hasBackup && file.kind !== 'ptb') {
            const layout = detectPeachtreeReport(grid);
            if (layout) {
              peachtreeReports.push(parsePeachtreeReport(grid, layout));
              detected.push({
                sheet: grid.name,
                target: `peachtree:${layout.kind}`,
                confidence: 1,
                rows: grid.rows.length,
                headers:
                  grid.rows[layout.headerIndex]?.cells.map((c) =>
                    String(c ?? ''),
                  ) ?? [],
              });
              continue;
            }
          }
          const sheetKey = normalizeKey(grid.name);
          const userTarget = ctx.sheet.get(sheetKey);
          const detection = detectSheet(grid.name, grid.rows);
          const headers = detection.headers;
          if (userTarget === 'skip') {
            detected.push({
              sheet: grid.name,
              target: null,
              confidence: 1,
              rows: grid.rows.length,
              headers,
            });
            continue;
          }
          let targetKey =
            (userTarget as MigrationEntityType | undefined) ?? detection.target;
          let confidence = userTarget ? 1 : detection.confidence;
          let sheetOrigin: 'rule' | 'ai' = 'rule';
          const aiSheet = ai.sheet.get(sheetKey);
          if (
            !userTarget &&
            aiSheet &&
            aiSheet.confidence > confidence &&
            (aiSheet.target === null ||
              TARGET_SHEETS.some((t) => t.key === aiSheet.target))
          ) {
            targetKey = aiSheet.target as MigrationEntityType | null;
            confidence = aiSheet.confidence;
            sheetOrigin = 'ai';
            detection.reason = `AI: ${aiSheet.reason}`;
          }
          if (!userTarget && detection.reason === 'noise') {
            detected.push({
              sheet: grid.name,
              target: null,
              confidence: 0,
              rows: grid.rows.length,
              headers,
            });
            continue;
          }
          if (!targetKey) {
            addIssue({
              code: MIGRATION_CODES.MIGRATION_UNKNOWN_SHEET,
              severity: 'warning',
              sheet: grid.name,
              message: `We could not tell what "${grid.name}" holds (${detection.reason}). Choose a sheet type, or skip it.`,
              options: [
                ...TARGET_SHEETS.map((t) => ({ value: t.key, label: t.name })),
                { value: 'skip', label: 'Skip this sheet' },
              ],
            });
            addProposal({
              kind: 'sheet',
              sheet: '',
              source: grid.name,
              target: null,
              confidence: String(confidence),
              origin: 'rule',
              reason: detection.reason,
            });
            detected.push({
              sheet: grid.name,
              target: null,
              confidence,
              rows: grid.rows.length,
              headers,
            });
            continue;
          }
          if (!userTarget) {
            if (sheetOrigin === 'rule')
              addProposal({
                kind: 'sheet',
                sheet: '',
                source: grid.name,
                target: targetKey,
                confidence: String(confidence),
                origin: 'rule',
                reason: detection.reason,
              });
            if (confidence < MAPPING_CONFIDENT) {
              addIssue({
                code: MIGRATION_CODES.MAPPING_UNCONFIRMED,
                severity: 'warning',
                sheet: grid.name,
                message: `"${grid.name}" looks like ${targetSheet(targetKey).name} (${detection.reason}). Confirm, or choose another type.`,
                options: [
                  ...[
                    targetKey,
                    ...detection.alternatives.map((a) => a.target),
                  ].map((k) => ({ value: k, label: targetSheet(k).name })),
                  { value: 'skip', label: 'Skip this sheet' },
                ],
              });
            }
          }
          const target = targetSheet(targetKey);
          detected.push({
            sheet: grid.name,
            target: targetKey,
            confidence,
            rows: grid.rows.length,
            headers,
          });

          // ── 2. Columns ──────────────────────────────────────────────
          const profileCols: Record<string, string> = {};
          for (const [k, v] of ctx.column) {
            const [scope, header] = k.split('::');
            if (scope === target.key || scope === sheetKey)
              profileCols[header] = v;
          }
          const columns = mapColumns(headers, target, profileCols);
          // A header the owner cleared stays unmapped.
          for (const c of columns) {
            const decided = ctx.column.get(
              `${sheetKey}::${normalizeKey(c.header)}`,
            );
            if (decided === '') {
              c.field = null;
              c.confidence = 0;
              c.reason = 'left out by the owner';
            }
            if (decided && decided !== '') {
              c.field = decided;
              c.confidence = 1;
              c.origin = 'profile';
              c.reason = 'chosen by the owner';
            }
          }
          // The AI assistant's column proposals outrank weaker rule matches.
          const aiOrigin = new Set<number>();
          for (const c of columns) {
            if (ctx.column.has(`${sheetKey}::${normalizeKey(c.header)}`))
              continue;
            const aiCol = ai.column.get(
              `${sheetKey}::${normalizeKey(c.header)}`,
            );
            if (
              !aiCol ||
              aiCol.confidence <= c.confidence ||
              (aiCol.target !== null &&
                !target.fields.some((f) => f.key === aiCol.target))
            )
              continue;
            // One field per column: a stronger rule match keeps its field.
            if (
              aiCol.target &&
              columns.some(
                (o) =>
                  o !== c &&
                  o.field === aiCol.target &&
                  o.confidence >= aiCol.confidence,
              )
            )
              continue;
            for (const o of columns) {
              if (o !== c && o.field === aiCol.target) {
                o.field = null;
                o.confidence = 0;
                o.reason = `the AI assistant reads "${c.header}" as this field`;
              }
            }
            c.field = aiCol.target;
            c.confidence = aiCol.confidence;
            c.reason = `AI: ${aiCol.reason}`;
            aiOrigin.add(c.column);
          }
          for (const c of columns) {
            if (!c.header.trim()) continue;
            const isUser = ctx.column.has(
              `${sheetKey}::${normalizeKey(c.header)}`,
            );
            if (!isUser && !aiOrigin.has(c.column))
              addProposal({
                kind: 'column',
                sheet: grid.name,
                source: c.header,
                target: c.field,
                confidence: String(c.confidence),
                origin: c.origin,
                reason: c.reason,
              });
            if (c.field && c.confidence < MAPPING_CONFIDENT && !isUser) {
              addIssue({
                code: MIGRATION_CODES.MAPPING_UNCONFIRMED,
                severity: 'warning',
                sheet: grid.name,
                field: `column::${c.header}`,
                message: `Column "${c.header}" ${c.reason}; we read it as "${target.fields.find((f) => f.key === c.field)?.header}". Confirm or change it.`,
                options: [
                  ...target.fields.map((f) => ({
                    value: f.key,
                    label: f.header,
                  })),
                  { value: '', label: 'Do not import this column' },
                ],
              });
            }
          }
          const missing = missingFields(target, columns);
          for (const f of missing.required) {
            addIssue({
              code: MIGRATION_CODES.MIGRATION_REQUIRED_COLUMN_MISSING,
              severity: 'blocking',
              sheet: grid.name,
              field: f.key,
              message: `"${grid.name}" has no "${f.header}" column. Pick the column that holds it.`,
              options: columns
                .filter((c) => !c.field && c.header.trim())
                .map((c) => ({ value: c.header, label: c.header })),
            });
          }

          // ── 3. Values ───────────────────────────────────────────────
          const dateOrder: Record<string, 'dmy' | 'mdy'> = {};
          for (const [k, v] of ctx.dateOrder) {
            const [scope, field] = k.split('::');
            if (scope === sheetKey) dateOrder[field] = v;
          }
          const mapValue = (field: string, raw: unknown): string | null => {
            const decided = ctx.value.get(`${field}::${normalizeKey(raw)}`);
            if (decided !== undefined) return decided || null;
            const r = mapEnumValue(field, raw);
            return r.confidence >= 1 ? r.value : null;
          };
          const normalised = normalizeRows(
            target,
            grid.rows,
            detection.headerRowIndex,
            columns,
            { dateOrder, mapValue },
          );
          for (const field of normalised.ambiguousDateFields) {
            addIssue({
              code: MIGRATION_CODES.AMBIGUOUS_DATE_FORMAT,
              severity: 'blocking',
              sheet: grid.name,
              field,
              message: `Dates in "${target.fields.find((f) => f.key === field)?.header}" on "${grid.name}" could be day/month/year or month/day/year. Which is it for this file?`,
              options: [
                { value: 'dmy', label: 'Day / month / year (dd/mm/yyyy)' },
                { value: 'mdy', label: 'Month / day / year (mm/dd/yyyy)' },
              ],
            });
          }
          // Unknown enum values: one issue per distinct source value, with a proposal.
          for (const row of normalised.rows) {
            for (const e of row.errors) {
              if (e.code !== 'INVALID_VALUE' || !e.field) continue;
              const raw =
                row.raw[columns.find((c) => c.field === e.field)?.header ?? ''];
              const guess = mapEnumValue(e.field, raw);
              const key = issueKey({
                code: MIGRATION_CODES.INVALID_VALUE,
                sheet: grid.name,
                field: `${e.field}::${normalizeKey(raw)}`,
              });
              if (!issues.has(key)) {
                issues.set(key, {
                  code: MIGRATION_CODES.INVALID_VALUE,
                  severity: 'blocking',
                  sheet: grid.name,
                  field: `${e.field}::${normalizeKey(raw)}`,
                  message: `"${String(raw)}" in "${target.fields.find((f) => f.key === e.field)?.header}" is not a value we know${guess.value ? ` — it ${guess.reason}; did you mean ${guess.value}?` : ''}. Choose what it means.`,
                  options: enumOptions(e.field).map((v) => ({
                    value: v,
                    label: v,
                  })),
                });
                addProposal({
                  kind: 'value',
                  sheet: grid.name,
                  source: `${e.field}::${String(raw)}`,
                  target: guess.value,
                  confidence: String(guess.confidence),
                  origin: 'rule',
                  reason: guess.reason,
                });
              }
            }
          }
          // Cell edits and skips chosen by the owner.
          for (const row of normalised.rows) {
            for (const field of target.fields) {
              const edit = ctx.cells.get(
                `${sheetKey}::${row.rowNumber}::${field.key}`,
              );
              if (edit === undefined) continue;
              row.errors = row.errors.filter((e) => e.field !== field.key);
              const parsed = this.parseCell(
                field.kind,
                edit,
                dateOrder[field.key],
                mapValue,
                field.key,
              );
              if (
                field.kind === 'amount' ||
                field.kind === 'quantity' ||
                field.kind === 'date'
              ) {
                // The correction is now what was "typed": the second reader
                // reads it too, below.
                row.normalized[`${field.key}Text`] = edit === '' ? null : edit;
              }
              if (parsed.ok) row.normalized[field.key] = parsed.value;
              else
                row.errors.push({
                  field: field.key,
                  code: parsed.code,
                  message: `${field.header} ${parsed.message}`,
                });
            }
          }
          // ── 4. Readback: the second reader must agree with the first on
          // every figure, or the owner decides what the cell means.
          for (const row of normalised.rows) {
            for (const field of target.fields) {
              if (
                field.kind !== 'amount' &&
                field.kind !== 'quantity' &&
                field.kind !== 'date'
              )
                continue;
              if (row.errors.some((e) => e.field === field.key)) continue;
              const text = row.normalized[`${field.key}Text`];
              const first = row.normalized[field.key];
              if ((text ?? null) === null && (first ?? null) === null) continue;
              const verdict = readbackAgrees(
                field.kind,
                first,
                row.normalized[`${field.key}Side`],
                text,
                row.normalized[`${field.key}Order`] as
                  | ReadbackOrder
                  | undefined,
              );
              if (verdict.agrees) continue;
              row.errors.push({
                field: field.key,
                code:
                  field.kind === 'date'
                    ? MIGRATION_CODES.DATE_READBACK_MISMATCH
                    : MIGRATION_CODES.AMOUNT_READBACK_MISMATCH,
                message: `${field.header}: "${text ?? ''}" reads as ${String(first ?? '(blank)')} one way and as ${verdict.readback} the other. Type it plainly${field.kind === 'date' ? ', e.g. 2026-06-30' : ', e.g. 120000'}, so there is only one way to read it.`,
              });
            }
          }
          works.push({ grid, fileId: file.id, target, rows: normalised.rows });
        }
        detectedByFile.set(file.id, detected);
      }
      for (const [fileId, detected] of detectedByFile)
        await em.update(MigrationFile, { id: fileId }, { detected });

      // ── 4. Matching against the company's masters and within the files ──
      const existing = await this.loadExisting(em, companyId);
      const staging: Array<Partial<MigrationStagingRow>> = [...proofStaging];
      // A "Total" line is accounted for (rejected, with its reason) and
      // otherwise ignored: it is the file's own arithmetic, not a record.
      for (const w of works) {
        const totals = w.rows.filter((r) => r.totalRow);
        for (const row of totals)
          staging.push(
            this.stagingRow(
              batch,
              w,
              { ...row, errors: [] },
              'rejected',
              'A total line, not a record',
              null,
            ),
          );
        w.rows = w.rows.filter((r) => !r.totalRow);
      }
      const rowIssues = (w: SheetWork, row: NormalizedRow) => {
        for (const e of row.errors) {
          if (e.code === 'INVALID_VALUE' || e.code === 'AMBIGUOUS_DATE_FORMAT')
            continue; // issued per value / per column above
          addIssue({
            code: e.code as IssueDraft['code'],
            severity: 'blocking',
            sheet: w.grid.name,
            rowNumber: row.rowNumber,
            field: e.field,
            message: `Row ${row.rowNumber}: ${e.message}`,
          });
        }
      };
      const byType = (key: MigrationEntityType) =>
        works.filter((w) => w.target.key === key);
      const rowsOf = (key: MigrationEntityType) =>
        byType(key).flatMap((w) => w.rows.map((row) => ({ w, row })));

      // Masters: customers, vendors, items.
      const masterIds: Record<
        'customers' | 'vendors' | 'items',
        Map<string, string>
      > = { customers: new Map(), vendors: new Map(), items: new Map() };
      for (const key of ['customers', 'vendors', 'items'] as const) {
        const all = rowsOf(key);
        const matches = matchMasters(
          all.map(({ row }) => ({
            code: (row.normalized.code ?? row.normalized.sku) as string | null,
            name: row.normalized.name as string | null,
          })),
          existing[key],
        );
        all.forEach(({ w, row }, i) => {
          const m = matches[i];
          const skipReason = ctx.skips.get(
            `${normalizeKey(w.grid.name)}::${row.rowNumber}`,
          );
          let outcome: StagingOutcome = 'pending';
          let reason: string | null = null;
          let match: MigrationStagingRow['match'] = null;
          const codeOrName = String(
            row.normalized.code ??
              row.normalized.sku ??
              row.normalized.name ??
              '',
          );
          const decided =
            ctx.matches.get(`${key}::${normalizeKey(codeOrName)}`) ??
            ctx.matches.get(`${key}::${normalizeKey(row.normalized.name)}`);
          const dupDecision = ctx.matches.get(
            `dup::${normalizeKey(w.grid.name)}::${row.rowNumber}`,
          );
          if (skipReason) {
            outcome = 'rejected';
            reason = skipReason;
          } else if (row.errors.length) {
            rowIssues(w, row);
          } else if (m.duplicateOf !== null) {
            const first = all[m.duplicateOf];
            if (dupDecision === 'merge') {
              outcome = 'merged';
              reason = `Same as row ${first.row.rowNumber} of ${first.w.grid.name}`;
              match = {
                mergedIntoRowId: `${first.w.grid.name}:${first.row.rowNumber}`,
              };
            } else {
              addIssue({
                code: MIGRATION_CODES.DUPLICATE_RECORD,
                severity: 'blocking',
                sheet: w.grid.name,
                rowNumber: row.rowNumber,
                field: `dup::${row.rowNumber}`,
                message: `Row ${row.rowNumber} (${row.normalized.name ?? codeOrName}) is the same ${key.slice(0, -1)} as row ${first.row.rowNumber} of "${first.w.grid.name}". Merge them, or skip this row.`,
                options: [
                  {
                    value: 'merge',
                    label: `Merge into row ${first.row.rowNumber}`,
                  },
                  { value: 'skip', label: 'Skip this row' },
                ],
              });
            }
          } else if (decided && decided !== 'create') {
            outcome = 'merged';
            reason = 'Matched by the owner';
            match = { recordId: decided, by: 'user' };
          } else if (m.recordId) {
            outcome = 'merged';
            reason = `Already in FinMatrix (same ${m.by})`;
            match = { recordId: m.recordId, by: m.by! };
          } else {
            outcome = 'imported';
          }
          if (outcome !== 'pending' || !row.errors.length) {
            // Register how open items can reach this master.
            const idKey = `${w.grid.name}:${row.rowNumber}`;
            if (row.normalized.code)
              masterIds[key].set(
                `code:${normalizeKey(row.normalized.code)}`,
                idKey,
              );
            if (row.normalized.sku)
              masterIds[key].set(
                `code:${normalizeKey(row.normalized.sku)}`,
                idKey,
              );
            if (row.normalized.name)
              masterIds[key].set(
                `name:${normalizeKey(row.normalized.name)}`,
                idKey,
              );
          }
          staging.push(this.stagingRow(batch, w, row, outcome, reason, match));
        });
      }

      // Accounts: the owner's chart wins (mapping/chart-plan). Every owner
      // account keeps its number and name; FinMatrix's own accounts adopt them
      // or step aside.
      const accountRows = rowsOf('accounts');
      const tbRows = rowsOf('trial_balance');
      // Several trial balance lines under one number with different names
      // (Tally's party ledgers under 1100 / 2000) name parties, not the
      // account: the number alone identifies it.
      const tbNames = new Map<string, Set<string>>();
      for (const { row } of tbRows) {
        const nk = normalizeKey(String(row.normalized.accountNumber ?? ''));
        if (!nk) continue;
        const names = tbNames.get(nk) ?? new Set<string>();
        names.add(normalizeKey(row.normalized.accountName));
        tbNames.set(nk, names);
      }
      const tbAccountName = (nk: string, name: unknown) =>
        (tbNames.get(nk)?.size ?? 0) > 1
          ? null
          : ((name as string | null) ?? null);
      const sourceAccounts = new Map<
        string,
        {
          number: string;
          name: string | null;
          type: string | null;
          kind: string | null;
        }
      >();
      const accountsToStage: Array<{
        w: SheetWork;
        row: NormalizedRow;
        nk: string;
      }> = [];
      for (const { w, row } of accountRows) {
        const skipReason = ctx.skips.get(
          `${normalizeKey(w.grid.name)}::${row.rowNumber}`,
        );
        if (skipReason) {
          staging.push(
            this.stagingRow(batch, w, row, 'rejected', skipReason, null),
          );
          continue;
        }
        if (row.errors.length) {
          rowIssues(w, row);
          staging.push(this.stagingRow(batch, w, row, 'pending', null, null));
          continue;
        }
        const number = String(row.normalized.accountNumber);
        const nk = normalizeKey(number);
        if (sourceAccounts.has(nk)) {
          addIssue({
            code: MIGRATION_CODES.DUPLICATE_RECORD,
            severity: 'blocking',
            sheet: w.grid.name,
            rowNumber: row.rowNumber,
            field: 'accounts',
            message: `Row ${row.rowNumber}: account ${number} appears twice on the Accounts sheet. Skip one of them.`,
            options: [{ value: 'skip', label: 'Skip this row' }],
          });
          staging.push(this.stagingRow(batch, w, row, 'pending', null, null));
          continue;
        }
        sourceAccounts.set(nk, {
          number,
          name: (row.normalized.accountName as string | null) ?? null,
          type: (row.normalized.type as string | null) ?? null,
          kind: (row.normalized.kind as string | null) ?? null,
        });
        accountsToStage.push({ w, row, nk });
      }
      for (const { row } of tbRows) {
        const number = row.normalized.accountNumber
          ? String(row.normalized.accountNumber)
          : '';
        const nk = normalizeKey(number);
        if (nk && !sourceAccounts.has(nk))
          sourceAccounts.set(nk, {
            number,
            name: tbAccountName(nk, row.normalized.accountName),
            type: null,
            kind: null,
          });
      }

      const plan = planChart(
        existing.accounts.map((a) => ({
          id: a.id,
          accountNumber: a.accountNumber,
          name: a.name,
          type: a.type,
          subType: a.subType,
          systemRole: a.systemRole,
        })),
        [...sourceAccounts.values()],
        {
          roleDecision: (role) =>
            ctx.value.get(`chart::${normalizeKey(role)}`) || undefined,
          accountDecision: (k) => ctx.accounts.get(k) || undefined,
        },
      );
      const fmById = new Map(existing.accounts.map((a) => [a.id, a]));
      const fmByNumber = new Map(
        existing.accounts.map((a) => [normalizeKey(a.accountNumber), a]),
      );
      // A FinMatrix account's number once the plan is applied.
      const finalOf = (number: string) => {
        const a = fmByNumber.get(normalizeKey(number));
        return a ? (plan.finalNumber.get(a.id) ?? a.accountNumber) : number;
      };
      const what = (a: {
        accountNumber: string;
        name: string;
        systemRole: string | null;
      }) =>
        a.systemRole
          ? `FinMatrix's ${roleLabel(a.systemRole as SystemRole)} account (${a.accountNumber} ${a.name})`
          : `FinMatrix's ${a.accountNumber} ${a.name}`;

      for (const { w, row, nk } of accountsToStage) {
        const into = plan.mergedInto.get(nk);
        const fm = into ? fmById.get(into) : undefined;
        staging.push(
          fm
            ? this.stagingRow(
                batch,
                w,
                row,
                'merged',
                `${what(fm)} becomes ${String(row.normalized.accountNumber)} ${String(row.normalized.accountName ?? '')}`.trim(),
                { recordId: fm.id, by: fm.systemRole ? 'role' : 'number' },
              )
            : this.stagingRow(
                batch,
                w,
                Object.assign(row, {
                  normalized: {
                    ...row.normalized,
                    // A system role this company has no account for yet.
                    ...(plan.newRoles.has(nk)
                      ? { systemRole: plan.newRoles.get(nk) }
                      : {}),
                  },
                }),
                'imported',
                null,
                null,
              ),
        );
      }
      // The chart as it will be: each FinMatrix account that changes, applied
      // by the commit before anything posts (never imported as a row).
      plan.changes.forEach((c, i) => {
        const values = { ...c } as Record<string, unknown>;
        staging.push({
          companyId: batch.companyId,
          batchId: batch.id,
          fileId: null,
          sheet: 'Your chart in FinMatrix',
          rowNumber: i + 1,
          rowHash: createHash('sha256')
            .update(JSON.stringify(values))
            .digest('hex'),
          entityType: 'chart_change',
          raw: values,
          normalized: values,
          outcome: 'merged',
          reason:
            c.change === 'adopt'
              ? `Takes your number and name: ${c.fromNumber} ${c.fromName} → ${c.toNumber} ${c.toName}`
              : `Steps aside for your ${c.fromNumber}: ${c.fromNumber} ${c.fromName} → ${c.toNumber}`,
          match: { recordId: c.accountId, by: 'number' },
        });
      });
      // A control role two of the owner's accounts fit equally well: asked.
      for (const r of plan.roles.filter((x) => x.unsure)) {
        const fm = fmById.get(r.accountId)!;
        addIssue({
          code: MIGRATION_CODES.MAPPING_UNCONFIRMED,
          severity: 'warning',
          sheet: 'Accounts',
          field: `chart::${r.role}`,
          message: `Which of your accounts is your ${roleLabel(r.role)}? ${r.candidates.length} fit equally well; we chose ${r.chosen}. ${what(fm)} takes its number and name. Confirm or choose another.`,
          options: [
            ...r.candidates.map((n) => ({
              value: n,
              label:
                `${n} ${sourceAccounts.get(normalizeKey(n))?.name ?? ''}`.trim(),
            })),
            {
              value: 'keep',
              label: `None of them: keep FinMatrix's own ${roleLabel(r.role)}`,
            },
          ],
        });
      }

      const accountTargets = new Map<string, string>(); // norm source number → final FinMatrix number | 'NEW' | 'NEW:<type>'
      for (const [nk, src] of sourceAccounts) {
        const into = plan.mergedInto.get(nk);
        const decided = ctx.accounts.get(nk);
        const aiAcct = ai.account.get(nk);
        let target: string | null = null;
        let confidence = 0;
        let reason = '';
        let origin: 'rule' | 'ai' = 'rule';
        if (into) {
          const fm = fmById.get(into)!;
          target = plan.finalNumber.get(into) ?? src.number;
          const role = plan.roles.find((r) => r.accountId === into);
          confidence = decided ? 1 : role?.unsure ? 0.6 : 1;
          reason =
            target === src.number
              ? `${what(fm)} takes your number and name`
              : `goes into ${what(fm)}`;
          // The proposal names the FinMatrix account by its number today.
          accountTargets.set(nk, target);
          if (!decided)
            addProposal({
              kind: 'account',
              sheet: '',
              source: src.number,
              target: fm.accountNumber,
              confidence: String(confidence),
              origin: 'rule',
              reason,
            });
          continue;
        }
        if (decided) {
          accountTargets.set(
            nk,
            decided.startsWith('NEW') ? decided : finalOf(decided),
          );
          continue;
        }
        if (
          aiAcct?.target &&
          validAccountTarget(aiAcct.target, existing) &&
          aiAcct.confidence >= MAPPING_CONFIDENT
        ) {
          target = finalOf(aiAcct.target);
          confidence = aiAcct.confidence;
          reason = `AI: ${aiAcct.reason}`;
          origin = 'ai';
        } else if (src.type) {
          target = 'NEW';
          confidence = 1;
          reason = 'a new account, with your number and name';
        }
        if (target) {
          accountTargets.set(nk, target);
          if (origin === 'rule')
            addProposal({
              kind: 'account',
              sheet: '',
              source: src.number,
              target,
              confidence: String(confidence),
              origin: 'rule',
              reason,
            });
        } else {
          addIssue({
            code: MIGRATION_CODES.UNKNOWN_ACCOUNT,
            severity: 'blocking',
            sheet: 'Trial Balance',
            field: `account::${src.number}`,
            message: `Account ${src.number}${src.name ? ` (${src.name})` : ''} is in the trial balance but not on the Accounts sheet or in FinMatrix. Create it (it keeps your number) as an account of the right type, or put its balance into an existing account.`,
            options: [
              ...NEW_ACCOUNT_OPTIONS.map((t) => ({
                value: `NEW:${t}`,
                label: `Create ${src.number}${src.name ? ` ${src.name}` : ''} as a new ${t} account`,
              })),
              ...existing.accounts
                .filter((a) => a.isActive)
                .map((a) => ({
                  value: a.accountNumber,
                  label: `${finalOf(a.accountNumber)} ${a.name}`,
                })),
            ],
          });
        }
      }
      for (const { w, row } of tbRows) {
        const skipReason = ctx.skips.get(
          `${normalizeKey(w.grid.name)}::${row.rowNumber}`,
        );
        if (skipReason) {
          staging.push(
            this.stagingRow(batch, w, row, 'rejected', skipReason, null),
          );
          continue;
        }
        if (row.errors.length) {
          rowIssues(w, row);
          staging.push(this.stagingRow(batch, w, row, 'pending', null, null));
          continue;
        }
        const nk = normalizeKey(String(row.normalized.accountNumber));
        let target = accountTargets.get(nk);
        // 'NEW:<type>': the account is created from the trial balance line itself.
        if (target?.startsWith('NEW:')) {
          const role = plan.newRoles.get(nk);
          row.normalized.newAccount = {
            type: target.slice(4),
            name:
              row.normalized.accountName ??
              String(row.normalized.accountNumber),
            // A role it clearly is, when the type chosen is the role's.
            ...(role && SYSTEM_ACCOUNT_DEFS[role].type === target.slice(4)
              ? { systemRole: role }
              : {}),
          };
          target = 'NEW';
        }
        row.normalized.targetAccount = target ?? null;
        staging.push(
          this.stagingRow(
            batch,
            w,
            row,
            target ? 'imported' : 'pending',
            null,
            null,
          ),
        );
      }

      // Open items and stock: resolve their references.
      const resolveRef = (
        key: 'customers' | 'vendors' | 'items',
        ref: string,
      ): { kind: 'row' | 'existing' | 'create'; id: string } | null => {
        const nk = normalizeKey(ref);
        if (!nk) return null;
        const decided = ctx.matches.get(`${key}::${nk}`);
        if (decided === 'create') return { kind: 'create', id: ref };
        if (decided?.startsWith('row:'))
          return { kind: 'row', id: decided.slice(4) };
        if (decided) return { kind: 'existing', id: decided };
        const rowRef =
          masterIds[key].get(`code:${nk}`) ?? masterIds[key].get(`name:${nk}`);
        if (rowRef) return { kind: 'row', id: rowRef };
        const ex = existing[key].find(
          (e) => normalizeKey(e.code) === nk || normalizeKey(e.name) === nk,
        );
        if (ex) return { kind: 'existing', id: ex.id };
        return null;
      };
      const refSpecs: Array<{
        type: MigrationEntityType;
        key: 'customers' | 'vendors' | 'items';
        field: string;
        code: IssueDraft['code'];
        label: string;
      }> = [
        {
          type: 'open_invoices',
          key: 'customers',
          field: 'customer',
          code: MIGRATION_CODES.UNKNOWN_CUSTOMER,
          label: 'customer',
        },
        {
          type: 'open_bills',
          key: 'vendors',
          field: 'vendor',
          code: MIGRATION_CODES.UNKNOWN_VENDOR,
          label: 'vendor',
        },
        {
          type: 'stock',
          key: 'items',
          field: 'sku',
          code: MIGRATION_CODES.UNKNOWN_ITEM,
          label: 'item',
        },
      ];
      for (const spec of refSpecs) {
        for (const { w, row } of rowsOf(spec.type)) {
          const skipReason = ctx.skips.get(
            `${normalizeKey(w.grid.name)}::${row.rowNumber}`,
          );
          if (skipReason) {
            staging.push(
              this.stagingRow(batch, w, row, 'rejected', skipReason, null),
            );
            continue;
          }
          if (row.errors.length) {
            rowIssues(w, row);
            staging.push(this.stagingRow(batch, w, row, 'pending', null, null));
            continue;
          }
          const ref = String(row.normalized[spec.field] ?? '');
          const resolved = resolveRef(spec.key, ref);
          if (!resolved) {
            const pool = [
              ...existing[spec.key].map((e) => ({ id: e.id, name: e.name })),
              ...rowsOf(spec.key).map(({ w: ww, row: r }) => ({
                id: `row:${ww.grid.name}:${r.rowNumber}`,
                name: String(r.normalized.name ?? r.normalized.sku ?? ''),
              })),
            ];
            addIssue({
              code: spec.code,
              severity: 'blocking',
              sheet: w.grid.name,
              field: `${spec.key}::${normalizeKey(ref)}`,
              message: `"${ref}" on "${w.grid.name}" is not a ${spec.label} we know. Match it to one, or ${spec.key === 'items' ? 'add it to the Items sheet' : 'create it'}.`,
              options: [
                ...nearestMasters(ref, pool).map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
                ...(spec.key === 'items'
                  ? []
                  : [
                      {
                        value: 'create',
                        label: `Create "${ref}" as a new ${spec.label}`,
                      },
                    ]),
              ],
            });
            staging.push(this.stagingRow(batch, w, row, 'pending', null, null));
            continue;
          }
          row.normalized[`${spec.field}Ref`] = resolved;
          const problems = this.openItemProblems(
            spec.type,
            row,
            batch.cutoverDate,
            existing,
          );
          if (problems.reject) {
            staging.push(
              this.stagingRow(batch, w, row, 'rejected', problems.reject, null),
            );
            continue;
          }
          if (problems.errors.length) {
            for (const e of problems.errors)
              addIssue({
                code: e.code as IssueDraft['code'],
                severity: 'blocking',
                sheet: w.grid.name,
                rowNumber: row.rowNumber,
                field: e.field,
                message: `Row ${row.rowNumber}: ${e.message}`,
              });
            staging.push(this.stagingRow(batch, w, row, 'pending', null, null));
            continue;
          }
          staging.push(this.stagingRow(batch, w, row, 'imported', null, null));
        }
      }

      // Document numbers and stock lines must be unique within the files.
      for (const [type, numberField, partyField] of [
        ['open_invoices', 'invoiceNumber', null],
        ['open_bills', 'billNumber', 'vendor'],
        ['stock', 'sku', null],
      ] as const) {
        const seen = new Map<string, number>();
        for (const st of staging) {
          if (st.entityType !== type || st.outcome !== 'imported') continue;
          const n = st.normalized as Record<string, unknown>;
          const k =
            normalizeKey(n[numberField]) +
            (partyField ? `|${normalizeKey(n[partyField])}` : '');
          const first = seen.get(k);
          if (first === undefined) {
            seen.set(k, st.rowNumber!);
            continue;
          }
          if (ctx.skips.has(`${normalizeKey(st.sheet)}::${st.rowNumber}`))
            continue;
          st.outcome = 'pending';
          st.reason = `Same ${type === 'stock' ? 'SKU' : 'number'} as row ${first}`;
          addIssue({
            code: MIGRATION_CODES.DUPLICATE_RECORD,
            severity: 'blocking',
            sheet: st.sheet,
            rowNumber: st.rowNumber,
            field: numberField,
            message: `Row ${st.rowNumber}: ${String(n[numberField])} appears again (first on row ${first}). Skip one of the rows, or correct the number.`,
            options: [{ value: 'skip', label: 'Skip this row' }],
          });
        }
      }

      // Stock sheet needs the inventory feature.
      if (byType('stock').length > 0) {
        const features = await companyFeatures(em, companyId);
        if (!features.inventory) {
          addIssue({
            code: MIGRATION_CODES.MIGRATION_FEATURE_DISABLED,
            severity: 'blocking',
            sheet: byType('stock')[0].grid.name,
            message:
              'This company does not track inventory on its plan, so the Stock sheet cannot be imported. Remove the sheet, or enable inventory first.',
          });
        }
      }

      // Required sheets for a fresh start: a trial balance.
      if (files.length > 0 && byType('trial_balance').length === 0) {
        addIssue({
          code: MIGRATION_CODES.MIGRATION_UNKNOWN_SHEET,
          severity: 'blocking',
          sheet: null,
          message:
            'No Trial Balance sheet was found. A migration needs the balances as at the cutover date.',
        });
      }

      // ── 5. Persist ─────────────────────────────────────────────────────
      if (staging.length)
        await em.save(
          MigrationStagingRow,
          staging.map((s) => em.create(MigrationStagingRow, s)),
          { chunk: 500 },
        );
      if (proposals.length) {
        // The unique index is (batch, kind, sheet, source); the owner's rows keep precedence.
        const seen = new Set<string>();
        const rows = proposals
          .filter((p) => {
            const k = `${p.kind}|${p.sheet ?? ''}|${p.source}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return !userMappings.some(
              (u) =>
                u.kind === p.kind &&
                (u.sheet ?? '') === (p.sheet ?? '') &&
                u.source === p.source,
            );
          })
          .map((p) =>
            em.create(MigrationMapping, {
              ...p,
              companyId,
              batchId,
              confirmed: false,
              sheet: p.sheet ?? '',
            }),
          );
        if (rows.length) await em.save(rows, { chunk: 500 });
      }
      if (issues.size) {
        await em.save(
          [...issues.values()].map((i) =>
            em.create(MigrationIssue, {
              id: stableIssueId(batchId, issueKey(i)),
              companyId,
              batchId,
              code: i.code,
              severity: i.severity,
              sheet: fitColumn(i.sheet),
              rowNumber: i.rowNumber ?? null,
              field: fitColumn(i.field),
              message: i.message,
              options: i.options ?? null,
              resolution: null,
              resolvedAt: null,
            }),
          ),
          { chunk: 500 },
        );
      }

      const counts = await this.counts(em, batch.id, companyId);
      batch.counts = counts;
      batch.readiness = readinessOf(counts, null);
      batch.checks = null;
      batch.status = files.length === 0 ? 'draft' : 'mapped';
      batch.lastError = null;
      await em.save(batch);
      return batch;
    });
  }

  /** Every Tally XML document across the batch's files, parsed as one bundle. */
  /**
   * A file's sheets (and XML documents): read from its bytes, or — for a
   * large export the background reader has already read — from the stored
   * extract of the sheets it kept.
   */
  private async readContents(
    file: MigrationFile,
    buffer: Buffer,
  ): Promise<Awaited<ReturnType<typeof readUpload>>> {
    if (file.kind !== 'extract') {
      return readUpload(buffer, file.originalName, {
        maxBytes: this.maxBytes,
        maxRows: 100_000,
      });
    }
    let x: SourceExtract;
    try {
      x = JSON.parse(buffer.toString('utf8')) as SourceExtract;
    } catch {
      x = {} as SourceExtract;
    }
    if (x.format !== 'finmatrix-source-extract' || x.version !== 1) {
      throw new BadRequestException({
        code: MIGRATION_CODES.MIGRATION_FILE_UNREADABLE,
        message: `${file.originalName} could not be read back. Remove it and upload it again.`,
      });
    }
    return {
      kind: 'zip',
      sheets: x.sheets,
      ...(x.xml?.length ? { xml: x.xml } : {}),
    };
  }

  /**
   * Every sheet that is a report some system exports (sources/reports),
   * parsed and turned into the starter sheets. The files' contents are kept
   * so the main pass does not read them twice.
   */
  private async sourceReportGrids(
    em: EntityManager,
    batch: MigrationBatch,
    files: MigrationFile[],
    ctx: MappingContext,
    addIssue: (i: IssueDraft) => void,
    proof: Array<Partial<MigrationStagingRow>>,
    roleNumbers: Map<string, string>,
  ): Promise<{
    contents: Map<string, Awaited<ReturnType<typeof readUpload>>>;
    recognised: Map<string, Map<string, string>>;
    byFile: Map<string, SourceGrid[]>;
  }> {
    const contents = new Map<string, Awaited<ReturnType<typeof readUpload>>>();
    const recognised = new Map<string, Map<string, string>>();
    const byFile = new Map<string, SourceGrid[]>();
    const parsed: Array<{ fileId: string; report: ParsedSourceReport }> = [];
    for (const file of files) {
      if (file.kind === 'ptb') continue;
      const stored = await this.storage.read(file.storageKey);
      if (!stored) continue;
      let c;
      try {
        c = await this.readContents(file, await streamToBuffer(stored.stream));
      } catch {
        continue; // reported by the main pass
      }
      contents.set(file.id, c);
      for (const g of c.sheets) {
        // A sheet laid out as the starter workbook's own is never a report.
        if (isStarterSheet(g)) continue;
        const r = recogniseReport(g, REPORT_PROFILES, batch.sourceSystem);
        if (!r) continue;
        const report = parseSourceReport(g, r);
        parsed.push({ fileId: file.id, report });
        const m = recognised.get(file.id) ?? new Map<string, string>();
        m.set(g.name, `${report.source}:${report.kind}`);
        recognised.set(file.id, m);
      }
    }
    if (!parsed.length) return { contents, recognised, byFile };
    const sources = [...new Set(parsed.map((p) => p.report.source))];
    if (sources.length > 1) {
      addIssue({
        code: MIGRATION_CODES.SOURCE_REPORT_DUPLICATE,
        severity: 'blocking',
        sheet: null,
        field: 'report::mixed',
        message: `These files are reports from more than one system (${sources.join(', ')}). A migration brings in one system's books: remove the others.`,
      });
      return { contents, recognised, byFile };
    }
    const profile = REPORT_PROFILES.find((p) => p.source === sources[0])!;
    const chart: Array<{ account_number: string }> = await em.query(
      `SELECT account_number FROM accounts WHERE company_id = $1`,
      [batch.companyId],
    );
    const built = buildCanonical(
      parsed.map((p) => p.report),
      profile,
      {
        openingDate: openingDateOf(batch.cutoverDate),
        accepted: (key) =>
          ctx.value.get(`report::${normalizeKey(key)}`) === 'accept',
        existingAccounts: chart.map((a) => a.account_number),
        controlNumbers: {
          'Accounts Receivable': roleNumbers.get(SYS.AR),
          Inventory: roleNumbers.get(SYS.INVENTORY),
          'Accounts Payable': roleNumbers.get(SYS.AP),
          'Retained Earnings': roleNumbers.get(SYS.RETAINED_EARNINGS),
        },
      },
    );
    for (const i of built.issues) addIssue(i);
    for (const w of built.warnings)
      addIssue({
        code: MIGRATION_CODES.MIGRATION_UNKNOWN_SHEET,
        severity: 'warning',
        sheet: null,
        field: `report::warning::${createHash('sha256').update(w).digest('hex').slice(0, 24)}`,
        message: w,
      });
    if (
      batch.sourceSystem !== profile.source &&
      !['generic_spreadsheet', 'finmatrix_template'].includes(
        batch.sourceSystem,
      )
    )
      addIssue({
        code: MIGRATION_CODES.MIGRATION_UNKNOWN_SHEET,
        severity: 'warning',
        sheet: null,
        field: 'report::source',
        message: `These are ${profile.label} reports. They are read as such; the migration's source is shown as something else.`,
      });
    const first = parsed[0].fileId;
    byFile.set(first, built.grids);
    built.proof.forEach((p, i) => {
      const values = {
        report: p.report,
        key: p.key,
        name: p.name,
        measure: p.measure,
        backup: p.backup,
        printed: p.printed,
      };
      proof.push({
        companyId: batch.companyId,
        batchId: batch.id,
        fileId: first,
        sheet: 'Report totals (proof)',
        rowNumber: i + 1,
        rowHash: createHash('sha256')
          .update(JSON.stringify(values))
          .digest('hex'),
        entityType: 'peachtree_proof',
        raw: values,
        normalized: { ...values, source: p.kind },
        outcome: 'merged',
        reason: "Compared with the source's own report; not imported.",
        match: null,
      });
    });
    return { contents, recognised, byFile };
  }

  /** Each system role's account number in this company today. */
  private async roleNumbers(
    em: EntityManager,
    companyId: string,
  ): Promise<Map<string, string>> {
    const rows: Array<{ role: string; number: string }> = await em.query(
      `SELECT system_role AS role, account_number AS number FROM accounts WHERE company_id = $1 AND system_role IS NOT NULL`,
      [companyId],
    );
    return new Map(rows.map((r) => [r.role, r.number]));
  }

  private async tallyGrids(
    files: MigrationFile[],
    roleNumbers: Map<string, string>,
  ): Promise<{ byFile: Map<string, SourceGrid[]>; warnings: string[] }> {
    const docs: Array<{ xml: string; fileIndex: number }> = [];
    for (const [i, file] of files.entries()) {
      if (file.kind !== 'xml' && file.kind !== 'zip' && file.kind !== 'extract')
        continue;
      const stored = await this.storage.read(file.storageKey);
      if (!stored) continue;
      try {
        const contents = await this.readContents(
          file,
          await streamToBuffer(stored.stream),
        );
        for (const xml of contents.xml ?? []) docs.push({ xml, fileIndex: i });
      } catch {
        // Reported by the main pass.
      }
    }
    const byFile = new Map<string, SourceGrid[]>();
    if (docs.length === 0) return { byFile, warnings: [] };
    const bundle = parseTallyDocuments(docs, {
      cash: roleNumbers.get(SYS.CASH),
      receivables: roleNumbers.get(SYS.AR),
      inventory: roleNumbers.get(SYS.INVENTORY),
      payables: roleNumbers.get(SYS.AP),
      profitAndLoss: roleNumbers.get(SYS.RETAINED_EARNINGS),
    });
    for (const g of bundle.grids) {
      const id = files[g.fileIndex].id;
      byFile.set(id, [
        ...(byFile.get(id) ?? []),
        { name: g.name, rows: g.rows },
      ]);
    }
    return { byFile, warnings: bundle.warnings };
  }

  /** Row counts, issue counts and mapping confidence for a batch. */
  async counts(
    em: EntityManager,
    batchId: string,
    companyId: string,
  ): Promise<MigrationCounts> {
    const rows: MigrationCounts['rows'] = {};
    const raw: Array<{
      entity_type: string | null;
      outcome: string;
      n: string;
    }> = await em.query(
      `SELECT entity_type, outcome, COUNT(*)::int AS n FROM migration_staging_rows WHERE batch_id = $1 AND company_id = $2 GROUP BY entity_type, outcome`,
      [batchId, companyId],
    );
    for (const r of raw) {
      const key = r.entity_type ?? 'unknown';
      rows[key] ??= {
        source: 0,
        imported: 0,
        merged: 0,
        rejected: 0,
        pending: 0,
      };
      const n = Number(r.n);
      rows[key].source += n;
      rows[key][r.outcome as 'imported' | 'merged' | 'rejected' | 'pending'] +=
        n;
    }
    const iss: Array<{ severity: string; resolved: boolean; n: string }> =
      await em.query(
        `SELECT severity, (resolved_at IS NOT NULL) AS resolved, COUNT(*)::int AS n FROM migration_issues WHERE batch_id = $1 AND company_id = $2 GROUP BY severity, resolved`,
        [batchId, companyId],
      );
    const issues = { blocking: 0, warning: 0, resolved: 0 };
    for (const r of iss) {
      if (r.resolved) issues.resolved += Number(r.n);
      else issues[r.severity as 'blocking' | 'warning'] += Number(r.n);
    }
    const maps: Array<{ total: string; confident: string }> = await em.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE target IS NOT NULL AND (confirmed OR confidence >= $3))::int AS confident
         FROM migration_mappings WHERE batch_id = $1 AND company_id = $2 AND kind IN ('sheet','column','value','account')
          AND NOT (kind = 'column' AND target IS NULL)`,
      [batchId, companyId, MAPPING_CONFIDENT],
    );
    return {
      rows,
      issues,
      mappings: {
        total: Number(maps[0]?.total ?? 0),
        confident: Number(maps[0]?.confident ?? 0),
      },
    };
  }

  /**
   * The rules an open item or stock line must meet before it can be posted.
   * A line with nothing left to pay is not an open item: it is set aside
   * with that reason (rejected rows are still accounted for).
   */
  private openItemProblems(
    type: MigrationEntityType,
    row: NormalizedRow,
    cutover: string,
    existing: ExistingMasters,
  ): {
    reject: string | null;
    errors: Array<{ code: string; field: string; message: string }>;
  } {
    const n = row.normalized;
    const errors: Array<{ code: string; field: string; message: string }> = [];
    if (type === 'open_invoices' || type === 'open_bills') {
      const due = new Decimal(String(n.amountDue ?? 0));
      const original = new Decimal(String(n.originalAmount ?? 0));
      const dateField = type === 'open_invoices' ? 'invoiceDate' : 'billDate';
      const numberField =
        type === 'open_invoices' ? 'invoiceNumber' : 'billNumber';
      if (due.isZero())
        return {
          reject: 'Nothing is due on this document, so it is not an open item.',
          errors,
        };
      if (due.lessThan(0))
        errors.push({
          code: 'INVALID_AMOUNT',
          field: 'amountDue',
          message: `Amount due is negative (${due.toFixed()}). Enter credits and advances in the trial balance, not as open items.`,
        });
      if (original.lessThan(due))
        errors.push({
          code: 'INVALID_AMOUNT',
          field: 'originalAmount',
          message: `Original amount ${original.toFixed()} is less than the amount due ${due.toFixed()}.`,
        });
      // The cutover day is FinMatrix's first day: the opening balances are
      // those at the close of the day before, and a document dated the cutover
      // day or later is entered in FinMatrix (the trial balance's receivable
      // or payable cannot include it either).
      if (n[dateField] && String(n[dateField]) >= cutover)
        errors.push({
          code: 'INVALID_DATE',
          field: dateField,
          message: `Dated ${String(n[dateField])}, on or after the cutover date ${cutover}. Open items are what was unpaid at the close of the day before; enter this one in FinMatrix instead.`,
        });
      if (n.dueDate && n[dateField] && String(n.dueDate) < String(n[dateField]))
        errors.push({
          code: 'INVALID_DATE',
          field: 'dueDate',
          message: `Due date ${String(n.dueDate)} is before the document date.`,
        });
      const number = String(n[numberField] ?? '');
      if (type === 'open_invoices' && number.length > 32)
        errors.push({
          code: 'INVALID_VALUE',
          field: numberField,
          message: `Invoice number "${number}" is longer than 32 characters.`,
        });
      if (type === 'open_bills' && number.length > 64)
        errors.push({
          code: 'INVALID_VALUE',
          field: numberField,
          message: `Bill number "${number}" is longer than 64 characters.`,
        });
      if (
        type === 'open_invoices' &&
        existing.invoiceNumbers.has(normalizeKey(number))
      )
        errors.push({
          code: 'DUPLICATE_RECORD',
          field: numberField,
          message: `An invoice numbered ${number} already exists in FinMatrix.`,
        });
    }
    if (type === 'stock') {
      const qty = new Decimal(String(n.quantityOnHand ?? 0));
      const cost = new Decimal(String(n.unitCost ?? 0));
      if (qty.isZero()) return { reject: 'Quantity on hand is zero.', errors };
      if (qty.lessThan(0))
        errors.push({
          code: 'INVALID_AMOUNT',
          field: 'quantityOnHand',
          message: `Quantity ${qty.toFixed()} is negative.`,
        });
      if (!cost.greaterThan(0))
        errors.push({
          code: 'INVALID_AMOUNT',
          field: 'unitCost',
          message:
            'Unit cost must be more than zero: stock with no cost has no value to post.',
        });
      if (n.value !== null && n.value !== undefined && n.value !== '') {
        const value = new Decimal(String(n.value));
        // The unit cost has four decimals; it must multiply back to the value
        // to within what that rounding allows.
        const slack = qty.abs().times('0.00005').plus('0.005');
        if (value.lessThanOrEqualTo(0))
          errors.push({
            code: 'INVALID_AMOUNT',
            field: 'value',
            message: `Stock value ${value.toFixed()} must be more than zero.`,
          });
        else if (
          qty.greaterThan(0) &&
          qty.times(cost).minus(value).abs().greaterThan(slack)
        )
          errors.push({
            code: 'INVALID_AMOUNT',
            field: 'value',
            message: `Stock value ${value.toFixed(2)} is not quantity × unit cost (${qty.toFixed()} × ${cost.toFixed()} = ${qty.times(cost).toFixed(2)}).`,
          });
      }
      const ref = n.skuRef as { kind: string; id: string } | undefined;
      if (
        ref?.kind === 'existing' &&
        existing.items.find((i) => i.id === ref.id)?.hasStock
      ) {
        errors.push({
          code: 'DUPLICATE_RECORD',
          field: 'sku',
          message: `${String(n.sku)} already has stock or stock history in FinMatrix, so its opening stock cannot be set again.`,
        });
      }
    }
    return { reject: null, errors };
  }

  private parseCell(
    kind: string,
    text: string,
    order: 'dmy' | 'mdy' | undefined,
    mapValue: (field: string, raw: unknown) => string | null,
    field: string,
  ):
    | { ok: true; value: unknown }
    | { ok: false; code: string; message: string } {
    switch (kind) {
      case 'amount':
      case 'quantity': {
        const r = kind === 'amount' ? parseAmount(text) : parseQuantity(text);
        return r.ok
          ? { ok: true, value: r.amount?.value ?? null }
          : { ok: false, code: 'INVALID_AMOUNT', message: r.error };
      }
      case 'date': {
        const r = parseDate(text, order);
        if (r.ok) return { ok: true, value: r.iso };
        return {
          ok: false,
          code: 'ambiguous' in r ? 'AMBIGUOUS_DATE_FORMAT' : 'INVALID_DATE',
          message: 'ambiguous' in r ? 'could be read two ways.' : r.error,
        };
      }
      case 'enum': {
        const v = mapValue(field, text) ?? mapEnumValue(field, text).value;
        return v
          ? { ok: true, value: v }
          : {
              ok: false,
              code: 'INVALID_VALUE',
              message: `"${text}" is not a value we know.`,
            };
      }
      default:
        return { ok: true, value: text.trim() === '' ? null : text.trim() };
    }
  }

  /**
   * A Peachtree backup's sheets: its stored extract, Peachtree's reports and
   * the owner's acceptances made into the starter workbook's sheets, the
   * issues to show, and one proof row per line compared with a report.
   */
  private async peachtreeContents(
    em: EntityManager,
    batch: MigrationBatch,
    file: MigrationFile,
    buffer: Buffer,
    io: {
      reports: ParsedReport[];
      ctx: MappingContext;
      addIssue: (i: IssueDraft) => void;
      proof: Array<Partial<MigrationStagingRow>>;
    },
  ): Promise<{ kind: 'ptb'; sheets: SourceGrid[] }> {
    let extract: PeachtreeExtract;
    try {
      extract = JSON.parse(buffer.toString('utf8')) as PeachtreeExtract;
    } catch {
      extract = {} as PeachtreeExtract;
    }
    if (
      extract.format !== 'finmatrix-peachtree-extract' ||
      extract.version !== 1
    ) {
      throw new BadRequestException({
        code: MIGRATION_CODES.MIGRATION_FILE_UNREADABLE,
        message: `${file.originalName} could not be read back. Remove it and upload the backup again.`,
      });
    }
    const company = await em.findOne(Company, {
      where: { id: batch.companyId },
      select: { id: true, fiscalYearStartMonth: true },
    });
    const chart: Array<{ account_number: string }> = await em.query(
      `SELECT account_number FROM accounts WHERE company_id = $1`,
      [batch.companyId],
    );
    const built = buildPeachtreeSheets(extract, io.reports, {
      accepted: (key) =>
        io.ctx.value.get(`peachtree::${normalizeKey(key)}`) === 'accept',
      fiscalYearStartMonth: clampMonth(company?.fiscalYearStartMonth),
      existingAccounts: chart.map((a) => a.account_number),
      fileName: file.originalName,
    });
    for (const i of built.issues) io.addIssue(i);
    for (const w of extract.warnings ?? []) {
      io.addIssue({
        code: MIGRATION_CODES.MIGRATION_UNKNOWN_SHEET,
        severity: 'warning',
        sheet: file.originalName,
        field: `peachtree::warning::${createHash('sha256').update(w).digest('hex').slice(0, 24)}`,
        message: w,
      });
    }
    built.proof.forEach((p, i) => {
      const values = {
        report: REPORT_TITLES[p.source],
        key: p.key,
        name: p.name,
        measure: p.measure,
        backup: p.backup,
        printed: p.printed,
      };
      io.proof.push({
        companyId: batch.companyId,
        batchId: batch.id,
        fileId: file.id,
        sheet: 'Peachtree reports (proof)',
        rowNumber: i + 1,
        rowHash: createHash('sha256')
          .update(JSON.stringify(values))
          .digest('hex'),
        entityType: 'peachtree_proof',
        raw: values,
        normalized: { ...values, source: p.source },
        outcome: 'merged',
        reason: "Compared with Peachtree's own report; not imported.",
        match: null,
      });
    });
    return { kind: 'ptb', sheets: built.grids };
  }

  private stagingRow(
    batch: MigrationBatch,
    w: SheetWork,
    row: NormalizedRow,
    outcome: StagingOutcome,
    reason: string | null,
    match: MigrationStagingRow['match'],
  ): Partial<MigrationStagingRow> {
    return {
      companyId: batch.companyId,
      batchId: batch.id,
      fileId: w.fileId,
      sheet: w.grid.name,
      rowNumber: row.rowNumber,
      rowHash: row.rowHash,
      entityType: w.target.key,
      raw: row.raw,
      normalized: row.normalized,
      outcome,
      reason:
        reason ??
        (row.errors.length ? row.errors.map((e) => e.message).join(' ') : null),
      match,
    };
  }

  private async loadExisting(
    em: EntityManager,
    companyId: string,
  ): Promise<ExistingMasters> {
    // Sequential on purpose: these run on the transaction's one connection.
    const customers = await em.find(Customer, {
      where: { companyId },
      select: { id: true, code: true, name: true },
    });
    const vendors = await em.find(Vendor, {
      where: { companyId },
      select: { id: true, code: true, companyName: true },
    });
    const items = await em.find(InventoryItem, {
      where: { companyId },
      select: { id: true, sku: true, name: true, quantityOnHand: true },
    });
    const accounts = await em.find(Account, {
      where: { companyId },
      select: {
        id: true,
        accountNumber: true,
        name: true,
        type: true,
        subType: true,
        systemRole: true,
        isActive: true,
      },
    });
    const movementCounts: Array<{ item_id: string }> = await em.query(
      `SELECT DISTINCT item_id FROM inventory_movements WHERE company_id = $1`,
      [companyId],
    );
    const moved = new Set(movementCounts.map((m) => m.item_id));
    const invoiceNumbers: Array<{ invoice_number: string }> = await em.query(
      `SELECT invoice_number FROM invoices WHERE company_id = $1`,
      [companyId],
    );
    return {
      invoiceNumbers: new Set(
        invoiceNumbers.map((r) => normalizeKey(r.invoice_number)),
      ),
      customers: customers.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
      })),
      vendors: vendors.map((v) => ({
        id: v.id,
        code: v.code,
        name: v.companyName,
      })),
      items: items.map((i) => ({
        id: i.id,
        code: i.sku,
        name: i.name,
        sku: i.sku,
        hasStock:
          !new Decimal(i.quantityOnHand ?? 0).isZero() || moved.has(i.id),
      })),
      accounts: accounts.map((a) => ({
        id: a.id,
        accountNumber: a.accountNumber,
        name: a.name,
        type: a.type,
        subType: a.subType ?? null,
        systemRole: a.systemRole ?? null,
        isActive: a.isActive,
      })),
    };
  }
}

export const AI_QUESTION_CODE = 'AI_QUESTION';
const NEW_ACCOUNT_OPTIONS = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
] as const;

/** An account mapping target the commit can act on: an existing number, or NEW:<type>. */
export function validAccountTarget(
  target: string,
  existing: { accounts: Array<{ accountNumber: string }> },
): boolean {
  if (target.startsWith('NEW:'))
    return (NEW_ACCOUNT_OPTIONS as readonly string[]).includes(target.slice(4));
  return existing.accounts.some((a) => a.accountNumber === target);
}

interface AiProposal {
  target: string | null;
  confidence: number;
  reason: string;
}

/** The AI assistant's stored proposals, keyed as the analysis looks them up. */
class AiProposals {
  readonly sheet = new Map<string, AiProposal>();
  readonly column = new Map<string, AiProposal>();
  readonly account = new Map<string, AiProposal>();

  static from(rows: MigrationMapping[]): AiProposals {
    const p = new AiProposals();
    for (const m of rows) {
      const v = {
        target: m.target,
        confidence: Number(m.confidence),
        reason: m.reason ?? 'proposed by the AI assistant',
      };
      if (m.kind === 'sheet') p.sheet.set(normalizeKey(m.source), v);
      if (m.kind === 'column')
        p.column.set(`${normalizeKey(m.sheet)}::${normalizeKey(m.source)}`, v);
      if (m.kind === 'account') p.account.set(normalizeKey(m.source), v);
    }
    return p;
  }
}

/** rows accounted + mappings confident + checks passed, over their totals, floored. */
export function readinessOf(
  counts: MigrationCounts,
  checks: Array<{ passed: boolean }> | null,
): number {
  let num = 0;
  let den = 0;
  for (const r of Object.values(counts.rows)) {
    num += r.imported + r.merged + r.rejected;
    den += r.source;
  }
  num += counts.mappings.confident;
  den += counts.mappings.total;
  const totalChecks = CHECK_CODES.length;
  num += checks ? checks.filter((c) => c.passed).length : 0;
  den += totalChecks;
  if (den === 0) return 0;
  return Math.floor((num / den) * 100);
}

/**
 * An issue's sheet and field are varchar(64). A longer one (a long file name,
 * a long key) keeps its start and gains a hash of the whole, so it stays
 * stable and distinct instead of failing the analysis.
 */
export function fitColumn(
  v: string | null | undefined,
  max = 64,
): string | null {
  if (v === null || v === undefined) return null;
  if (v.length <= max) return v;
  const h = createHash('sha256').update(v).digest('hex').slice(0, 16);
  return `${v.slice(0, max - h.length - 1)}~${h}`;
}

/**
 * Issues are rebuilt on every analysis, but an issue about the same thing
 * (code, sheet, row, field) keeps the same id, so a client that answers
 * several issues from one list never holds a stale id.
 */
export function stableIssueId(batchId: string, key: string): string {
  const h = createHash('sha256').update(`${batchId}|${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
