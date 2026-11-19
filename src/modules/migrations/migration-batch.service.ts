import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { Readable } from 'stream';
import { DataSource, EntityManager, In } from 'typeorm';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { StorageService } from '../../common/storage/storage.service';
import { businessToday } from '../../common/utils/business-date.util';
import { Account } from '../accounts/entities/account.entity';
import { Company } from '../companies/entities/company.entity';
import { User } from '../users/entities/user.entity';
import {
  MigrationAnalysisService,
  readinessOf,
} from './analysis/migration-analysis.service';
import { MigrationAiService } from './ai/migration-ai.service';
import { buildAsTyped } from './certificate/as-typed';
import { renderCertificatePdf } from './certificate/certificate-pdf';
import {
  assertBooksEmpty,
  CertificatePreview,
  MigrationCommitService,
} from './commit/migration-commit.service';
import { MigrationRollbackService } from './commit/migration-rollback.service';
import {
  CreateMigrationDto,
  IssuesQueryDto,
  MappingPatchItemDto,
  ResolveIssueDto,
  SignOffDto,
} from './dto/migration.dto';
import {
  MigrationBatch,
  MigrationStatus,
} from './entities/migration-batch.entity';
import { MigrationFile } from './entities/migration-file.entity';
import {
  MigrationUpload,
  MigrationUploadPart,
} from './entities/migration-upload.entity';
import { MigrationIssue } from './entities/migration-issue.entity';
import {
  MappingKind,
  MigrationMapping,
} from './entities/migration-mapping.entity';
import {
  MigrationProfile,
  ProfileMappings,
} from './entities/migration-profile.entity';
import { MigrationStagingRow } from './entities/migration-staging-row.entity';
import { normalizeKey } from './parsers/text-normalize';
import { readUpload } from './readers/read-upload';
import {
  assertEditable,
  assertTransition,
  lockEditable,
  stepFor,
  transitionAtomically,
} from './state-machine';
import { TARGET_SHEETS } from './targets';
import { buildStarterWorkbook } from './template/starter-workbook';
import { openingDateOf } from './opening-date';

export interface UploadedMigrationFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const FILE_BUCKET = 'migration-files';
const KIND_MIME: Record<MigrationFile['kind'], string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  zip: 'application/zip',
  xml: 'application/xml',
  ptb: 'application/x-peachtree-backup',
  extract: 'application/json',
};
const CERT_BUCKET = 'migration-certificates';

interface Decision {
  kind: MappingKind;
  sheet: string;
  source: string;
  target: string | null;
}

/**
 * The Migration Center's one entry point for the controller: owns the status
 * machine and turns every owner action into decisions (user mappings), then
 * re-runs the analysis so the batch always reflects the files plus those
 * decisions — nothing else.
 */
@Injectable()
export class MigrationBatchService {
  private readonly maxBytes: number;
  private readonly logger = new Logger(MigrationBatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly analysis: MigrationAnalysisService,
    private readonly committer: MigrationCommitService,
    private readonly rollbacker: MigrationRollbackService,
    private readonly audit: OperationalAuditService,
    private readonly ai: MigrationAiService,
  ) {
    this.maxBytes = Number(
      config.get('MIGRATION_MAX_FILE_BYTES') ?? 26_214_400,
    );
  }

  // ── Batches ───────────────────────────────────────────────────────────
  async create(
    companyId: string,
    user: AuthenticatedUser,
    dto: CreateMigrationDto,
  ) {
    const today = businessToday();
    if (dto.cutoverDate > today) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `The cutover date ${dto.cutoverDate} is in the future. Choose today or an earlier day: the opening balances are those at the close of the day before it.`,
      });
    }
    await assertBooksEmpty(this.dataSource.manager, companyId);
    const batch = await this.dataSource.manager.save(
      this.dataSource.manager.create(MigrationBatch, {
        companyId,
        sourceSystem: dto.sourceSystem,
        cutoverDate: dto.cutoverDate,
        status: 'draft',
        readiness: 0,
        checks: null,
        counts: null,
        lastError: null,
        createdBy: user.id,
        signedOffBy: null,
        signedOffAt: null,
        committedBy: null,
        committedAt: null,
        closedAt: null,
        rolledBackAt: null,
        certificateStorageKey: null,
        previousBooksLockedUntil: null,
      }),
    );
    await this.log(companyId, user.id, 'migration_created', batch.id, {
      sourceSystem: dto.sourceSystem,
      cutoverDate: dto.cutoverDate,
    });
    return this.view(batch);
  }

  async list(companyId: string) {
    const rows = await this.dataSource.manager.find(MigrationBatch, {
      where: { companyId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return Promise.all(rows.map((b) => this.view(b)));
  }

  async get(companyId: string, id: string) {
    return this.view(await this.load(companyId, id), true);
  }

  async template(companyId: string, cutoverDate?: string): Promise<Buffer> {
    const company = await this.dataSource.manager.findOneOrFail(Company, {
      where: { id: companyId },
    });
    return buildStarterWorkbook({
      companyName: company.name,
      cutoverDate:
        cutoverDate && /^\d{4}-\d{2}-\d{2}$/.test(cutoverDate)
          ? cutoverDate
          : 'your cutover date',
    });
  }

  // ── Files ─────────────────────────────────────────────────────────────
  async addFiles(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    files: UploadedMigrationFile[],
  ) {
    const batch = await this.load(companyId, id);
    assertEditable(batch.status);
    assertTransition(batch.status, 'uploaded');
    if (!files || files.length === 0) {
      throw new BadRequestException({
        code: 'MIGRATION_FILE_UNREADABLE',
        message: 'Choose at least one file to upload.',
      });
    }
    const stored: Array<{ row: Partial<MigrationFile>; key: string }> = [];
    for (const f of files) {
      const name = utf8Name(f.originalname);
      if (/\.ptb$/i.test(name)) {
        throw new UnsupportedMediaTypeException({
          code: 'MIGRATION_USE_LARGE_UPLOAD',
          message: `${name} is a Peachtree backup. Upload it with "Upload Peachtree backup", which sends it in pieces and reads it in the background.`,
        });
      }
      if (f.size > this.maxBytes) {
        throw new BadRequestException({
          code: 'MIGRATION_FILE_TOO_LARGE',
          message: `${name} is ${(f.size / 1_048_576).toFixed(1)} MB; the limit is ${Math.round(this.maxBytes / 1_048_576)} MB.`,
        });
      }
      // Read it now, so an unreadable file is refused at the door with its reason.
      const contents = await readUpload(f.buffer, name, {
        maxBytes: this.maxBytes,
        maxRows: 100_000,
      });
      const fileId = randomUUID();
      // The bytes decided the type, so the stored copy is labelled by them,
      // not by what the phone claimed (often application/octet-stream).
      const mimeType = KIND_MIME[contents.kind];
      const put = await this.storage.putBuffer({
        bucket: FILE_BUCKET,
        buffer: f.buffer,
        mimeType,
        originalName: name,
        publicPath: `/migrations/${id}/files/${fileId}`,
      });
      stored.push({
        key: put.key,
        row: {
          id: fileId,
          companyId,
          batchId: id,
          originalName: name.slice(0, 255),
          mimeType,
          sizeBytes: f.size,
          storageKey: put.key,
          sha256: createHash('sha256').update(f.buffer).digest('hex'),
          kind: contents.kind,
          detected: null,
        },
      });
    }
    // The files join the batch only if it can still take them: checked under
    // the batch lock, in the same transaction that records them.
    try {
      await this.dataSource.transaction(async (em) => {
        const live = await lockEditable(em, companyId, id);
        assertTransition(live.status, 'uploaded');
        for (const s of stored) await em.save(em.create(MigrationFile, s.row));
        await this.touch(live, 'uploaded', em);
      });
    } catch (err) {
      for (const s of stored)
        await this.storage.remove(s.key).catch(() => undefined);
      throw err;
    }
    await this.log(companyId, user.id, 'migration_files_added', id, {
      files: files.map((f) => ({
        name: utf8Name(f.originalname),
        size: f.size,
      })),
    });
    const analysed = await this.reanalyse(companyId, id);
    // The assistant looks only at what the rules left uncertain, and only when switched on.
    if (this.ai.enabled()) {
      const outcome = await this.ai.assist(id, companyId);
      if (outcome.ran) {
        await this.log(companyId, user.id, 'migration_ai_assisted', id, {
          ...outcome,
        });
        return this.reanalyse(companyId, id);
      }
    }
    return analysed;
  }

  /**
   * A Peachtree backup has been read (uploads/migration-read.worker): record
   * it as the batch's file — its name, size and SHA-256 as uploaded, the read
   * extract as its stored copy — and drop the upload's pieces, in one
   * transaction under the batch lock; then analyse. One backup per batch.
   */
  async addReadBackup(input: {
    companyId: string;
    userId: string;
    batchId: string;
    uploadId: string;
    name: string;
    size: number;
    sha256: string;
    storageKey: string;
    /** 'ptb': a Peachtree backup read; 'extract': another large export read. */
    kind?: 'ptb' | 'extract';
  }): Promise<string> {
    const { companyId, batchId } = input;
    const kind = input.kind ?? 'ptb';
    const fileId = randomUUID();
    await this.dataSource.transaction(async (em) => {
      const live = await lockEditable(em, companyId, batchId);
      assertTransition(live.status, 'uploaded');
      const other =
        kind === 'ptb'
          ? await em.findOne(MigrationFile, {
              where: { batchId, companyId, kind: 'ptb' },
            })
          : null;
      if (other) {
        throw new ConflictException({
          code: 'MIGRATION_INVALID_TRANSITION',
          message: `This migration already has a Peachtree backup (${other.originalName}). Remove it before adding another.`,
        });
      }
      await em.save(
        em.create(MigrationFile, {
          id: fileId,
          companyId,
          batchId,
          originalName: input.name.slice(0, 255),
          mimeType: KIND_MIME[kind],
          sizeBytes: input.size,
          storageKey: input.storageKey,
          sha256: input.sha256,
          kind,
          detected: null,
        }),
      );
      // Still `reading` until the analysis below has run: the owner's page
      // keeps following it, and shows the sheets the moment they exist.
      await em.update(
        MigrationUpload,
        { id: input.uploadId, companyId },
        {
          fileId,
          progress: { stage: 'analysing' },
          errorCode: null,
          error: null,
          sha256: input.sha256,
        },
      );
      await em.delete(MigrationUploadPart, { uploadId: input.uploadId });
      await this.touch(live, 'uploaded', em);
    });
    await this.log(companyId, input.userId, 'migration_backup_added', batchId, {
      name: input.name,
      size: input.size,
      sha256: input.sha256,
    });
    await this.finishBackupRead(companyId, batchId, input.uploadId);
    return fileId;
  }

  /**
   * Analyse the batch with its newly recorded backup, then mark the upload
   * read. Also how the read worker finishes a read whose process died after
   * the backup was recorded. An analysis that fails records lastError on the
   * batch; the backup stays.
   */
  async finishBackupRead(companyId: string, batchId: string, uploadId: string) {
    await this.reanalyse(companyId, batchId).catch((err: Error) =>
      this.logger.error(
        `Migration ${batchId}: analysis after reading the backup failed: ${err.message}`,
      ),
    );
    await this.dataSource.manager.update(
      MigrationUpload,
      { id: uploadId, companyId },
      { status: 'read', finishedAt: new Date(), progress: { stage: 'done' } },
    );
  }

  async removeFile(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    fileId: string,
  ) {
    const batch = await this.load(companyId, id);
    assertEditable(batch.status);
    const file = await this.dataSource.manager.findOne(MigrationFile, {
      where: { id: fileId, batchId: id, companyId },
    });
    if (!file)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'File not found',
      });
    await this.dataSource.transaction(async (em) => {
      const live = await lockEditable(em, companyId, id);
      await em.delete(MigrationFile, { id: fileId, batchId: id, companyId });
      // A backup's upload goes with it (its pieces went when it was read).
      if (file.kind === 'ptb') {
        const ups = await em.find(MigrationUpload, {
          where: { fileId, batchId: id, companyId },
        });
        if (ups.length) {
          await em.delete(MigrationUploadPart, {
            uploadId: In(ups.map((u) => u.id)),
          });
          await em.delete(MigrationUpload, { id: In(ups.map((u) => u.id)) });
        }
      }
      await this.touch(live, 'uploaded', em);
    });
    await this.storage.remove(file.storageKey);
    await this.log(companyId, user.id, 'migration_file_removed', id, {
      file: file.originalName,
    });
    return this.reanalyse(companyId, id);
  }

  // ── Mappings ──────────────────────────────────────────────────────────
  async getMappings(companyId: string, id: string) {
    await this.load(companyId, id);
    const em = this.dataSource.manager;
    const rows = await em.find(MigrationMapping, {
      where: { batchId: id, companyId },
      order: { kind: 'ASC', sheet: 'ASC', source: 'ASC' },
    });
    const files = await em.find(MigrationFile, {
      where: { batchId: id, companyId },
    });
    const accounts = await em.find(Account, {
      where: { companyId, isActive: true },
      order: { accountNumber: 'ASC' },
    });
    const sourceAccounts = await this.sourceAccounts(id);
    const view = (m: MigrationMapping) => ({
      id: m.id,
      kind: m.kind,
      sheet: m.sheet || null,
      source: m.source,
      target: m.target,
      confidence: Number(m.confidence),
      origin: m.origin,
      reason: m.reason,
      confirmed: m.confirmed,
      needsReview:
        m.target === null
          ? m.kind !== 'column'
          : !m.confirmed && Number(m.confidence) < 0.9,
    });
    return {
      sheets: files.flatMap((f) =>
        (f.detected ?? []).map((d) => ({
          file: f.originalName,
          fileId: f.id,
          ...d,
        })),
      ),
      mappings: {
        sheet: rows.filter((r) => r.kind === 'sheet').map(view),
        column: rows.filter((r) => r.kind === 'column').map(view),
        value: rows.filter((r) => r.kind === 'value').map(view),
        account: rows.filter((r) => r.kind === 'account').map(view),
      },
      decisions: rows
        .filter((r) => ['match', 'cell', 'skip'].includes(r.kind))
        .map(view),
      targets: TARGET_SHEETS.map((t) => ({
        key: t.key,
        name: t.name,
        fields: t.fields.map((f) => ({
          key: f.key,
          header: f.header,
          required: !!f.required,
          kind: f.kind,
        })),
      })),
      chartOfAccounts: accounts.map((a) => ({
        number: a.accountNumber,
        name: a.name,
        type: a.type,
      })),
      sourceAccounts,
    };
  }

  /**
   * Each source account as the owner knows it — name, type, balance — and
   * the number it is created under when FinMatrix already uses its own.
   */
  private async sourceAccounts(batchId: string) {
    const staged = await this.dataSource.manager.find(MigrationStagingRow, {
      where: { batchId, entityType: In(['accounts', 'trial_balance']) },
      select: { entityType: true, normalized: true },
    });
    const byNumber = new Map<
      string,
      {
        number: string;
        name: string | null;
        type: string | null;
        balance: Decimal;
        createAs: string | null;
        tbNames: Set<string>;
      }
    >();
    const amount = (v: unknown) => {
      try {
        return new Decimal(String(v ?? 0) || 0);
      } catch {
        return new Decimal(0);
      }
    };
    for (const r of staged) {
      const v = r.normalized ?? {};
      const number = String(v.sourceNumber ?? v.accountNumber ?? '').trim();
      if (!number) continue;
      const a = byNumber.get(number) ?? {
        number,
        name: null,
        type: null,
        balance: new Decimal(0),
        createAs: null,
        tbNames: new Set<string>(),
      };
      if (r.entityType === 'accounts') {
        a.name = (v.accountName as string | null) ?? a.name;
        a.type = (v.type as string | null) ?? a.type;
        if (v.sourceNumber) a.createAs = String(v.accountNumber);
      } else {
        if (v.accountName) a.tbNames.add(String(v.accountName));
        a.balance = a.balance.plus(amount(v.debit)).minus(amount(v.credit));
        const fresh = v.newAccount as { number?: string } | undefined;
        if (fresh?.number) a.createAs = fresh.number;
      }
      byNumber.set(number, a);
    }
    return [...byNumber.values()].map((a) => ({
      number: a.number,
      // Several names under one number are parties (Tally), not the account.
      name: a.name ?? (a.tbNames.size === 1 ? [...a.tbNames][0] : null),
      type: a.type,
      balance: a.balance.toFixed(2),
      createAs: a.createAs,
    }));
  }

  async patchMappings(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    items: MappingPatchItemDto[],
  ) {
    const batch = await this.load(companyId, id);
    assertEditable(batch.status);
    if (!items?.length)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Send at least one mapping.',
      });
    await this.decide(
      companyId,
      id,
      items.map((i) => ({
        kind: i.kind,
        sheet:
          i.kind === 'account' || i.kind === 'match' || i.kind === 'sheet'
            ? ''
            : (i.sheet ?? ''),
        source: i.source,
        target: i.target ?? null,
      })),
    );
    await this.touch(batch, 'mapped');
    await this.log(companyId, user.id, 'migration_mappings_changed', id, {
      count: items.length,
    });
    return this.reanalyse(companyId, id);
  }

  // ── Issues ────────────────────────────────────────────────────────────
  async listIssues(companyId: string, id: string, q: IssuesQueryDto) {
    await this.load(companyId, id);
    const em = this.dataSource.manager;
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(200, Math.max(1, q.limit ?? 50));
    const groups: Array<{ code: string; severity: string; count: number }> = (
      await em.query(
        `SELECT code, severity, COUNT(*)::int AS count FROM migration_issues WHERE batch_id = $1 AND company_id = $2 AND resolved_at IS NULL GROUP BY code, severity ORDER BY severity, code`,
        [id, companyId],
      )
    ).map((g: { code: string; severity: string; count: number }) => ({
      ...g,
      count: Number(g.count),
    }));
    const qb = em
      .createQueryBuilder(MigrationIssue, 'i')
      .where('i.batchId = :id AND i.companyId = :companyId', { id, companyId });
    if (q.code) qb.andWhere('i.code = :code', { code: q.code });
    if (q.severity)
      qb.andWhere('i.severity = :severity', { severity: q.severity });
    if ((q.state ?? 'open') === 'open') qb.andWhere('i.resolvedAt IS NULL');
    if (q.state === 'resolved') qb.andWhere('i.resolvedAt IS NOT NULL');
    const [items, total] = await qb
      .orderBy('i.severity', 'ASC')
      .addOrderBy('i.code', 'ASC')
      .addOrderBy('i.sheet', 'ASC')
      .addOrderBy('i.rowNumber', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { groups, items, total, page, limit };
  }

  async resolveIssue(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    issueId: string,
    dto: ResolveIssueDto,
  ) {
    const batch = await this.load(companyId, id);
    assertEditable(batch.status);
    const em = this.dataSource.manager;
    const issue = await em.findOne(MigrationIssue, {
      where: { id: issueId, batchId: id, companyId },
    });
    if (!issue)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Issue not found',
      });
    if (dto.action === 'skip' && !dto.reason?.trim()) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message:
          'Say why the row is skipped; the certificate lists every skipped row with its reason.',
      });
    }
    // Every report is as of one other date: the owner moves the cutover date
    // to match (only to the date offered, never into the future).
    if (dto.value?.startsWith('cutover:')) {
      const offered = (issue.options ?? []).some((o) => o.value === dto.value);
      const to = dto.value.slice('cutover:'.length);
      if (!offered || !/^\d{4}-\d{2}-\d{2}$/.test(to))
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message:
            'That answer does not resolve this issue. Choose one of the offered options.',
        });
      if (to > businessToday())
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `The cutover date ${to} is in the future. Choose today or an earlier day.`,
        });
      const from = batch.cutoverDate;
      if (batch.status !== 'mapped') assertTransition(batch.status, 'mapped');
      // One guarded update: only while the batch is still editable.
      await transitionAtomically(
        em,
        batch,
        'mapped',
        { cutoverDate: to, signedOffAt: null, signedOffBy: null },
        { editableOnly: true },
      );
      await this.log(companyId, user.id, 'migration_cutover_changed', id, {
        from,
        to,
        issue: issue.code,
      });
      return this.reanalyse(companyId, id);
    }
    const targets = dto.applyToAll
      ? await em.find(MigrationIssue, {
          where: {
            batchId: id,
            companyId,
            code: issue.code,
            sheet: issue.sheet ?? undefined,
          },
        })
      : [issue];
    const decisions: Decision[] = [];
    for (const t of targets)
      decisions.push(...(await this.decisionsFor(companyId, id, t, dto)));
    if (decisions.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message:
          'That answer does not resolve this issue. Choose one of the offered options.',
      });
    }
    await this.decide(companyId, id, decisions);
    await this.touch(batch, 'mapped');
    await this.log(companyId, user.id, 'migration_issue_resolved', id, {
      code: issue.code,
      action: dto.action,
      value: dto.value ?? null,
      reason: dto.reason ?? null,
      issues: targets.length,
    });
    return this.reanalyse(companyId, id);
  }

  /** What an answer to an issue means, as owner decisions. */
  private async decisionsFor(
    companyId: string,
    batchId: string,
    issue: MigrationIssue,
    dto: ResolveIssueDto,
  ): Promise<Decision[]> {
    const value = dto.value ?? null;
    const sheet = issue.sheet ?? '';
    const field = issue.field ?? '';
    const skipRow = (): Decision[] =>
      issue.rowNumber
        ? [
            {
              kind: 'skip',
              sheet,
              source: String(issue.rowNumber),
              target: dto.reason ?? 'Skipped by the owner',
            },
          ]
        : [];
    const skipSheet = (): Decision[] =>
      sheet
        ? [{ kind: 'sheet', sheet: '', source: sheet, target: 'skip' }]
        : [];
    switch (issue.code) {
      case 'MIGRATION_UNKNOWN_SHEET':
      case 'MIGRATION_FEATURE_DISABLED':
        if (dto.action === 'skip') return skipSheet();
        return sheet && value
          ? [{ kind: 'sheet', sheet: '', source: sheet, target: value }]
          : [];
      case 'MAPPING_UNCONFIRMED':
        if (field.startsWith('column::'))
          return [
            {
              kind: 'column',
              sheet,
              source: field.slice('column::'.length),
              target: dto.action === 'skip' ? '' : (value ?? ''),
            },
          ];
        if (field.startsWith('account::'))
          return value
            ? [
                {
                  kind: 'account',
                  sheet: '',
                  source: field.slice('account::'.length),
                  target: value,
                },
              ]
            : [];
        if (dto.action === 'skip') return skipSheet();
        return sheet && value
          ? [{ kind: 'sheet', sheet: '', source: sheet, target: value }]
          : [];
      case 'UNKNOWN_ACCOUNT':
        return value && field.startsWith('account::')
          ? [
              {
                kind: 'account',
                sheet: '',
                source: field.slice('account::'.length),
                target: value,
              },
            ]
          : [];
      case 'MIGRATION_REQUIRED_COLUMN_MISSING':
        if (dto.action === 'skip') return skipSheet();
        return value
          ? [{ kind: 'column', sheet, source: value, target: field }]
          : [];
      case 'AMBIGUOUS_DATE_FORMAT':
        if (!issue.rowNumber)
          return value === 'dmy' || value === 'mdy'
            ? [
                {
                  kind: 'value',
                  sheet,
                  source: `dateOrder::${field}`,
                  target: value,
                },
              ]
            : [];
        return dto.action === 'skip'
          ? skipRow()
          : value
            ? [
                {
                  kind: 'cell',
                  sheet,
                  source: `${issue.rowNumber}::${field}`,
                  target: value,
                },
              ]
            : [];
      case 'INVALID_VALUE':
        if (!issue.rowNumber)
          return value
            ? [{ kind: 'value', sheet, source: field, target: value }]
            : [];
        return dto.action === 'skip'
          ? skipRow()
          : value !== null
            ? [
                {
                  kind: 'cell',
                  sheet,
                  source: `${issue.rowNumber}::${field}`,
                  target: value,
                },
              ]
            : [];
      case 'UNKNOWN_CUSTOMER':
      case 'UNKNOWN_VENDOR':
      case 'UNKNOWN_ITEM': {
        if (dto.action !== 'skip')
          return value
            ? [{ kind: 'match', sheet: '', source: field, target: value }]
            : [];
        // Skip every row on the sheet that names this party or item.
        const [, ref] = field.split('::');
        const refField =
          issue.code === 'UNKNOWN_CUSTOMER'
            ? 'customer'
            : issue.code === 'UNKNOWN_VENDOR'
              ? 'vendor'
              : 'sku';
        const rows = await this.dataSource.manager.find(MigrationStagingRow, {
          where: { batchId, companyId, sheet },
        });
        return rows
          .filter(
            (r) =>
              normalizeKey(
                (r.normalized as Record<string, unknown> | null)?.[refField],
              ) === ref,
          )
          .map((r) => ({
            kind: 'skip' as const,
            sheet,
            source: String(r.rowNumber),
            target: dto.reason ?? 'Skipped by the owner',
          }));
      }
      case 'DUPLICATE_RECORD':
        if (
          field.startsWith('dup::') &&
          dto.action === 'map' &&
          value === 'merge'
        )
          return [
            {
              kind: 'match',
              sheet: '',
              source: `dup::${normalizeKey(sheet)}::${issue.rowNumber}`,
              target: 'merge',
            },
          ];
        if (dto.action === 'skip' || value === 'skip') return skipRow();
        return value !== null && issue.rowNumber
          ? [
              {
                kind: 'cell',
                sheet,
                source: `${issue.rowNumber}::${field}`,
                target: value,
              },
            ]
          : [];
      case 'MIGRATION_FILE_UNREADABLE':
      case 'MIGRATION_FILE_TOO_LARGE':
        throw new BadRequestException({
          code: issue.code,
          message: 'Remove this file and upload a readable copy.',
        });
      // A Peachtree difference or credit the owner may accept: kept on the
      // account the message names, shown on the certificate.
      case 'PEACHTREE_CONTROL_DIFFERENCE':
      case 'PEACHTREE_NET_CREDIT':
        return value === 'accept' && field.startsWith('peachtree::')
          ? [{ kind: 'value', sheet: '', source: field, target: 'accept' }]
          : [];
      // A report's date the owner confirms, or credits they accept to hold
      // on an advances account (sources/reports/canonical).
      case 'SOURCE_REPORT_DATE':
      case 'SOURCE_NET_CREDIT':
        if (value === 'accept' && field.startsWith('report::'))
          return [
            { kind: 'value', sheet: '', source: field, target: 'accept' },
          ];
        throw new BadRequestException({
          code: issue.code,
          message:
            'Export the report again as the message describes and upload it; the migration checks again then.',
        });
      case 'SOURCE_REPORTS_MISSING':
      case 'SOURCE_REPORT_DUPLICATE':
      case 'SOURCE_TOTALS_MISMATCH':
        throw new BadRequestException({
          code: issue.code,
          message:
            'Upload (or remove) the report as the message describes; the migration checks again then. Nothing is imported from a report FinMatrix cannot prove.',
        });
      case 'PEACHTREE_CROSSCHECK_FAILED':
      case 'PEACHTREE_POSTED_AFTER_CUTOVER':
        throw new BadRequestException({
          code: issue.code,
          message:
            'This is fixed in Peachtree, not here: correct it there, make a new backup, remove this one and upload the new one.',
        });
      case 'PEACHTREE_FISCAL_YEAR':
        throw new BadRequestException({
          code: issue.code,
          message:
            "Change this company's fiscal year start in Settings → Company; the migration checks again when you return.",
        });
      case 'PEACHTREE_REPORTS_MISSING':
      case 'PEACHTREE_REPORT_MISMATCH':
        throw new BadRequestException({
          code: issue.code,
          message:
            "Upload Peachtree's report as the message describes (or remove the wrong one); the migration checks again then.",
        });
      default:
        // INVALID_AMOUNT, INVALID_DATE, MISSING_REQUIRED_VALUE and other row problems.
        if (dto.action === 'skip') return skipRow();
        return value !== null && issue.rowNumber
          ? [
              {
                kind: 'cell',
                sheet,
                source: `${issue.rowNumber}::${field}`,
                target: value,
              },
            ]
          : [];
    }
  }

  /** Store owner decisions, replacing any proposal or earlier decision on the same key. */
  private async decide(
    companyId: string,
    batchId: string,
    decisions: Decision[],
  ) {
    await this.dataSource.transaction(async (em) => {
      await lockEditable(em, companyId, batchId);
      for (const dcs of decisions) {
        await em.delete(MigrationMapping, {
          batchId,
          companyId,
          kind: dcs.kind,
          sheet: dcs.sheet,
          source: dcs.source,
        });
        await em.save(
          em.create(MigrationMapping, {
            companyId,
            batchId,
            kind: dcs.kind,
            sheet: dcs.sheet,
            source: dcs.source.slice(0, 255),
            target: dcs.target === null ? null : dcs.target.slice(0, 128),
            confidence: '1',
            origin: 'user',
            reason: 'chosen by the owner',
            confirmed: true,
          }),
        );
      }
    });
  }

  // ── Checks, dry run, sign-off ─────────────────────────────────────────
  async validate(companyId: string, user: AuthenticatedUser, id: string) {
    const { batch, preview } = await this.runChecks(companyId, user, id);
    return { ...(await this.view(batch, true)), checks: preview.checks };
  }

  async dryRun(companyId: string, user: AuthenticatedUser, id: string) {
    const { batch, preview } = await this.runChecks(companyId, user, id);
    return { batch: await this.view(batch, true), certificate: preview };
  }

  private async runChecks(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ batch: MigrationBatch; preview: CertificatePreview }> {
    let batch = await this.load(companyId, id);
    if (batch.status === 'uploaded')
      batch = await this.analysis.analyse(id, companyId);
    assertTransition(batch.status, 'validated');
    const preview = await this.committer.dryRun(batch, user.id);
    const em = this.dataSource.manager;
    const counts = await this.analysis.counts(em, id, companyId);
    const readiness = readinessOf(counts, preview.checks);
    const ready =
      preview.allPassed && readiness === 100 && counts.issues.blocking === 0;
    const status: MigrationStatus = ready ? 'ready' : 'validated';
    // A new result un-signs: the owner signs what they last saw. The write
    // is conditional on the batch still being where the checks found it: a
    // commit that landed meanwhile must not be overwritten with 'validated'.
    const written = await em.update(
      MigrationBatch,
      { id, status: In(['mapped', 'validated', 'ready']) },
      {
        status,
        readiness,
        counts: jsonColumn(counts),
        checks: jsonColumn(preview.checks),
        lastError: null,
        ...(batch.status !== status || !ready
          ? { signedOffAt: null, signedOffBy: null }
          : {}),
      },
    );
    if (!written.affected) {
      const now = await this.load(companyId, id);
      assertTransition(now.status, 'validated');
    }
    await this.log(companyId, user.id, 'migration_validated', id, {
      status,
      readiness,
      failed: preview.checks.filter((c) => !c.passed).map((c) => c.code),
    });
    batch = await this.load(companyId, id);
    return { batch, preview };
  }

  async signOff(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
    dto: SignOffDto,
  ) {
    const batch = await this.load(companyId, id);
    if (batch.status !== 'ready') {
      throw new ConflictException({
        code: 'MIGRATION_INVALID_TRANSITION',
        message:
          'Only a migration whose checks all pass can be signed off. Run the checks first.',
      });
    }
    if (!dto.confirmed || !dto.spotCheckDone) {
      throw new BadRequestException({
        code: 'NOT_SIGNED_OFF',
        message:
          'Confirm the certificate and tick every spot check before signing off.',
      });
    }
    await transitionAtomically(
      this.dataSource.manager,
      batch,
      'ready',
      { signedOffBy: user.id, signedOffAt: new Date() },
      { from: ['ready'] },
    );
    await this.log(companyId, user.id, 'migration_signed_off', id, {});
    return this.get(companyId, id);
  }

  // ── Commit, rollback, close ───────────────────────────────────────────
  async commit(companyId: string, user: AuthenticatedUser, id: string) {
    const batch = await this.load(companyId, id);
    assertTransition(batch.status, 'committed');
    if (!batch.signedOffAt) {
      throw new ConflictException({
        code: 'NOT_SIGNED_OFF',
        message: 'Sign off the certificate before importing.',
      });
    }
    const preview = await this.committer.commit(
      batch,
      user.id,
      async (em: EntityManager, p) => {
        await em.update(
          MigrationBatch,
          { id },
          {
            status: 'committed',
            committedAt: new Date(),
            committedBy: user.id,
            checks: jsonColumn(p.checks),
            readiness: 100,
            lastError: null,
          },
        );
        await this.saveProfile(em, batch);
      },
    );
    // The certificate is stored after the transaction: a storage hiccup must
    // not undo an import that balanced. It can be re-rendered on request.
    const fresh = await this.load(companyId, id);
    try {
      const pdf = await this.renderCertificate(fresh, {
        ...preview,
        mode: 'commit',
      });
      const stored = await this.storage.putBuffer({
        bucket: CERT_BUCKET,
        buffer: pdf,
        mimeType: 'application/pdf',
        originalName: `migration-certificate-${id}.pdf`,
        publicPath: `/migrations/${id}/certificate`,
      });
      await this.dataSource.manager.update(
        MigrationBatch,
        { id },
        { certificateStorageKey: stored.key },
      );
    } catch {
      // GET /certificate renders it again.
    }
    await this.log(companyId, user.id, 'migration_committed', id, {
      created: preview.created,
      postings: preview.postings.map((p) => p.reference),
    });
    return { batch: await this.get(companyId, id), certificate: preview };
  }

  async rollback(companyId: string, user: AuthenticatedUser, id: string) {
    const batch = await this.load(companyId, id);
    assertTransition(batch.status, 'rolled_back');
    const result = await this.rollbacker.rollback(batch, user.id);
    await this.log(companyId, user.id, 'migration_rolled_back', id, result);
    return { batch: await this.get(companyId, id), result };
  }

  async close(companyId: string, user: AuthenticatedUser, id: string) {
    const batch = await this.load(companyId, id);
    assertTransition(batch.status, 'closed');
    await transitionAtomically(
      this.dataSource.manager,
      batch,
      'closed',
      { closedAt: new Date() },
      { from: ['committed'] },
    );
    await this.log(companyId, user.id, 'migration_closed', id, {});
    return this.get(companyId, id);
  }

  async certificate(
    companyId: string,
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ stream: Readable; fileName: string; preview: boolean }> {
    const batch = await this.load(companyId, id);
    if (batch.certificateStorageKey) {
      const stored = await this.storage.read(batch.certificateStorageKey);
      if (stored)
        return {
          stream: stored.stream,
          fileName: `migration-certificate-${id.slice(0, 8)}.pdf`,
          preview: false,
        };
    }
    if (
      batch.status === 'committed' ||
      batch.status === 'closed' ||
      (batch.status === 'rolled_back' && batch.committedAt)
    ) {
      // Stored copy missing: render the final certificate from the saved checks.
      const company = await this.dataSource.manager.findOneOrFail(Company, {
        where: { id: companyId },
      });
      const counts = await this.analysis.counts(
        this.dataSource.manager,
        id,
        companyId,
      );
      const preview: CertificatePreview = {
        batchId: id,
        companyName: company.name,
        sourceSystem: batch.sourceSystem,
        cutoverDate: batch.cutoverDate,
        openingDate: openingDateOf(batch.cutoverDate),
        generatedAt: new Date().toISOString(),
        mode: 'commit',
        checks: batch.checks ?? [],
        allPassed: true,
        rowCounts: Object.entries(counts.rows).map(([entity, r]) => ({
          entity,
          ...r,
        })),
        rejectedRows: [],
        rejectedTotal: Object.values(counts.rows).reduce(
          (s, r) => s + r.rejected,
          0,
        ),
        spotChecks: [],
        asTyped: buildAsTyped(
          await this.dataSource.manager.find(MigrationStagingRow, {
            where: { batchId: id, companyId },
          }),
          null,
        ),
        postings: [],
        created: {},
      };
      return {
        stream: Readable.from(await this.renderCertificate(batch, preview)),
        fileName: `migration-certificate-${id.slice(0, 8)}.pdf`,
        preview: false,
      };
    }
    if (!['mapped', 'validated', 'ready'].includes(batch.status)) {
      throw new ConflictException({
        code: 'MIGRATION_INVALID_TRANSITION',
        message: 'There is nothing to certify yet. Upload the files first.',
      });
    }
    const preview = await this.committer.dryRun(batch, user.id);
    return {
      stream: Readable.from(await this.renderCertificate(batch, preview)),
      fileName: `migration-certificate-preview-${id.slice(0, 8)}.pdf`,
      preview: true,
    };
  }

  private async renderCertificate(
    batch: MigrationBatch,
    preview: CertificatePreview,
  ): Promise<Buffer> {
    const em = this.dataSource.manager;
    const company = await em.findOneOrFail(Company, {
      where: { id: batch.companyId },
    });
    const signer = batch.signedOffBy
      ? await em.findOne(User, { where: { id: batch.signedOffBy } })
      : null;
    return renderCertificatePdf({
      company,
      preview,
      signedOff: batch.signedOffAt
        ? {
            name: signer?.displayName ?? signer?.email ?? 'Owner',
            at: batch.signedOffAt,
          }
        : null,
      committedAt: batch.committedAt,
    });
  }

  /** Confirmed decisions become the company's profile for this source. */
  private async saveProfile(em: EntityManager, batch: MigrationBatch) {
    const decisions = await em.find(MigrationMapping, {
      where: {
        batchId: batch.id,
        companyId: batch.companyId,
        kind: In(['column', 'value', 'account']),
        origin: 'user',
      },
    });
    // Signing off the certificate confirms every mapping in effect, so the
    // confident rule and AI proposals join the owner's own decisions.
    const proposals = await em.find(MigrationMapping, {
      where: {
        batchId: batch.id,
        companyId: batch.companyId,
        kind: In(['column', 'account']),
        origin: In(['rule', 'ai']),
      },
    });
    const files = await em.find(MigrationFile, {
      where: { batchId: batch.id, companyId: batch.companyId },
    });
    const targetOf = new Map<string, string>();
    for (const f of files)
      for (const d of f.detected ?? [])
        if (d.target) targetOf.set(d.sheet, d.target);
    const mappings: ProfileMappings = { columns: {}, values: {}, accounts: {} };
    for (const m of [
      ...proposals.filter((p) => Number(p.confidence) >= 0.9 && p.target),
      ...decisions,
    ]) {
      if (m.kind === 'column') {
        const target = targetOf.get(m.sheet);
        if (!target || m.target === null) continue;
        (mappings.columns[target] ??= {})[normalizeKey(m.source)] = m.target;
      } else if (
        m.kind === 'value' &&
        !m.source.startsWith('dateOrder::') &&
        m.target
      ) {
        mappings.values[m.source] = m.target;
      } else if (m.kind === 'account' && m.target && m.target !== 'NEW') {
        // Plain NEW needs this batch's Accounts sheet; NEW:<type> and numbers stand alone.
        mappings.accounts[m.source] = m.target;
      }
    }
    const name = 'default';
    const existing = await em.findOne(MigrationProfile, {
      where: {
        companyId: batch.companyId,
        sourceSystem: batch.sourceSystem,
        name,
      },
    });
    if (existing) {
      existing.mappings = {
        columns: { ...existing.mappings.columns, ...mappings.columns },
        values: { ...existing.mappings.values, ...mappings.values },
        accounts: { ...existing.mappings.accounts, ...mappings.accounts },
      };
      existing.usedCount += 1;
      existing.lastUsedAt = new Date();
      await em.save(existing);
    } else {
      await em.save(
        em.create(MigrationProfile, {
          companyId: batch.companyId,
          sourceSystem: batch.sourceSystem,
          name,
          mappings,
          usedCount: 1,
          lastUsedAt: new Date(),
        }),
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  private async reanalyse(companyId: string, id: string) {
    try {
      await this.analysis.analyse(id, companyId);
    } catch (err) {
      await this.dataSource.manager.update(
        MigrationBatch,
        { id },
        { lastError: (err as Error).message.slice(0, 1000) },
      );
      throw err;
    }
    return this.get(companyId, id);
  }

  /** Move to a new pre-commit status and drop the sign-off. */
  private async touch(
    batch: MigrationBatch,
    to: MigrationStatus,
    em: EntityManager = this.dataSource.manager,
  ) {
    if (batch.status !== to) assertTransition(batch.status, to);
    await transitionAtomically(
      em,
      batch,
      to,
      { signedOffAt: null, signedOffBy: null },
      { editableOnly: true },
    );
  }

  private async load(companyId: string, id: string): Promise<MigrationBatch> {
    const batch = await this.dataSource.manager.findOne(MigrationBatch, {
      where: { id, companyId },
    });
    if (!batch)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Migration not found',
      });
    return batch;
  }

  private async view(batch: MigrationBatch, detail = false) {
    const em = this.dataSource.manager;
    const files = detail
      ? await em.find(MigrationFile, {
          where: { batchId: batch.id, companyId: batch.companyId },
          order: { createdAt: 'ASC' },
        })
      : [];
    const blocking = batch.counts?.issues.blocking ?? 0;
    const signer = batch.signedOffBy
      ? await em.findOne(User, {
          where: { id: batch.signedOffBy },
          select: { id: true, displayName: true },
        })
      : null;
    return {
      id: batch.id,
      sourceSystem: batch.sourceSystem,
      cutoverDate: batch.cutoverDate,
      // The date every posting carries and the books close through.
      openingDate: openingDateOf(batch.cutoverDate),
      status: batch.status,
      step: stepFor(batch.status, blocking > 0),
      readiness: batch.readiness,
      counts: batch.counts,
      checks: batch.checks,
      issues: { blocking, warning: batch.counts?.issues.warning ?? 0 },
      lastError: batch.lastError,
      signedOffAt: batch.signedOffAt?.toISOString() ?? null,
      signedOffBy: signer ? { id: signer.id, name: signer.displayName } : null,
      committedAt: batch.committedAt?.toISOString() ?? null,
      closedAt: batch.closedAt?.toISOString() ?? null,
      rolledBackAt: batch.rolledBackAt?.toISOString() ?? null,
      certificateAvailable:
        !!batch.certificateStorageKey ||
        ['committed', 'closed'].includes(batch.status),
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
      ...(detail
        ? {
            uploads: (
              await em.find(MigrationUpload, {
                where: { batchId: batch.id, companyId: batch.companyId },
                order: { createdAt: 'DESC' },
                take: 5,
              })
            ).map((u) => ({
              id: u.id,
              name: u.originalName,
              size: u.sizeBytes,
              status: u.status,
              progress: u.progress,
              errorCode: u.errorCode,
              error: u.error,
              fileId: u.fileId,
              updatedAt: u.updatedAt.toISOString(),
            })),
            files: files.map((f) => ({
              id: f.id,
              originalName: f.originalName,
              sizeBytes: f.sizeBytes,
              kind: f.kind,
              detected: f.detected,
              createdAt: f.createdAt.toISOString(),
            })),
          }
        : {}),
    };
  }

  private async log(
    companyId: string,
    actorUserId: string,
    action: string,
    batchId: string,
    details: Record<string, unknown>,
  ) {
    await this.audit.record({
      companyId,
      actorUserId,
      action,
      targetType: 'migration_batch',
      targetId: batchId,
      details,
    });
  }
}

/**
 * A jsonb value for update(): TypeORM's deep-partial typing cannot see that a
 * Record<string, unknown> is plain JSON, so the value is passed through as-is.
 */
function jsonColumn<T>(value: T): never {
  return value as never;
}

/** multer decodes file names as latin1; recover UTF-8 names (Urdu file names). */
export function utf8Name(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}
