import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
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
import { assertEditable, assertTransition, stepFor } from './state-machine';
import { TARGET_SHEETS } from './targets';
import { buildStarterWorkbook } from './template/starter-workbook';

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
        message: `The cutover date ${dto.cutoverDate} is in the future. Choose a day that has ended.`,
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
    for (const f of files) {
      const name = utf8Name(f.originalname);
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
      const stored = await this.storage.putBuffer({
        bucket: FILE_BUCKET,
        buffer: f.buffer,
        mimeType,
        originalName: name,
        publicPath: `/migrations/${id}/files/${fileId}`,
      });
      await this.dataSource.manager.save(
        this.dataSource.manager.create(MigrationFile, {
          id: fileId,
          companyId,
          batchId: id,
          originalName: name.slice(0, 255),
          mimeType,
          sizeBytes: f.size,
          storageKey: stored.key,
          sha256: createHash('sha256').update(f.buffer).digest('hex'),
          kind: contents.kind,
          detected: null,
        }),
      );
    }
    await this.touch(batch, 'uploaded');
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
    await this.dataSource.manager.delete(MigrationFile, { id: fileId });
    await this.storage.remove(file.storageKey);
    await this.touch(batch, 'uploaded');
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
    };
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
    await this.dataSource.manager.update(
      MigrationBatch,
      { id },
      { signedOffBy: user.id, signedOffAt: new Date() },
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
    await this.dataSource.manager.update(
      MigrationBatch,
      { id },
      { status: 'closed', closedAt: new Date() },
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
  private async touch(batch: MigrationBatch, to: MigrationStatus) {
    if (batch.status !== to) assertTransition(batch.status, to);
    await this.dataSource.manager.update(
      MigrationBatch,
      { id: batch.id },
      { status: to, signedOffAt: null, signedOffBy: null },
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
