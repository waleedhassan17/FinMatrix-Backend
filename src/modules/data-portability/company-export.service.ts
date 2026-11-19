import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Readable } from 'stream';
import { Repository } from 'typeorm';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { StorageService } from '../../common/storage/storage.service';
import { businessToday } from '../../common/utils/business-date.util';
import { Company } from '../companies/entities/company.entity';
import { CompanyExport } from './entities/company-export.entity';
import { backupFileName } from './exporter/manifest';
import { ExportTokenSigner } from './export-token';

/** Backups an owner may start per company per rolling hour. */
export const EXPORTS_PER_HOUR = 3;
const LIST_LIMIT = 50;

export interface CompanyExportView {
  id: string;
  status: CompanyExport['status'];
  includeXlsx: boolean;
  fileName: string;
  asOf: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  error: string | null;
  summary: CompanyExport['summary'];
  /** Signed link, present only while the file can be downloaded. */
  downloadUrl: string | null;
}

export interface OpenedDownload {
  stream: Readable;
  size: number | null;
  fileName: string;
}

@Injectable()
export class CompanyExportService {
  private readonly publicBase: string;

  constructor(
    @InjectRepository(CompanyExport)
    private readonly repo: Repository<CompanyExport>,
    private readonly config: ConfigService,
    private readonly signer: ExportTokenSigner,
    private readonly storage: StorageService,
    private readonly audit: OperationalAuditService,
  ) {
    const appUrl = config.get<string>('APP_URL', 'http://localhost:3000');
    const apiPrefix = config.get<string>('API_PREFIX', 'api/v1');
    this.publicBase = `${appUrl.replace(/\/$/, '')}/${apiPrefix.replace(/^\/|\/$/g, '')}`;
  }

  /**
   * Queue a backup. The per-company limit is enforced here, by rows, rather
   * than with @Throttle: the throttler keys on IP, and a shop's whole staff
   * shares one, while this rule is about one company's books.
   */
  async request(
    companyId: string,
    user: AuthenticatedUser,
    includeXlsx: boolean,
  ): Promise<{ id: string; status: 'queued' }> {
    const company = await this.repo.manager.findOne(Company, {
      where: { id: companyId },
    });
    if (!company)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Company not found',
      });

    const recent = await this.repo
      .createQueryBuilder('e')
      .where('e.companyId = :companyId', { companyId })
      .andWhere("e.createdAt > now() - interval '1 hour'")
      .getCount();
    if (recent >= EXPORTS_PER_HOUR) {
      throw new HttpException(
        {
          code: 'EXPORT_RATE_LIMITED',
          message: `You can create up to ${EXPORTS_PER_HOUR} backups an hour. Download the latest one, or try again in a little while.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const asOf = businessToday();
    const row = await this.repo.save(
      this.repo.create({
        companyId,
        requestedBy: user.id,
        status: 'queued',
        includeXlsx,
        asOf,
        fileName: backupFileName(company.name, asOf),
        storageKey: null,
        sizeBytes: null,
        error: null,
        attempts: 0,
        summary: null,
        startedAt: null,
        completedAt: null,
        expiresAt: null,
      }),
    );
    await this.audit.record({
      companyId,
      actorUserId: user.id,
      action: 'export_requested',
      targetType: 'company_export',
      targetId: row.id,
      details: { includeXlsx },
    });
    return { id: row.id, status: 'queued' };
  }

  async list(companyId: string): Promise<CompanyExportView[]> {
    const rows = await this.repo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
      take: LIST_LIMIT,
    });
    return rows.map((r) => this.toView(r));
  }

  async get(companyId: string, id: string): Promise<CompanyExportView> {
    const row = await this.repo.findOne({ where: { id, companyId } });
    if (!row)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Export not found',
      });
    return this.toView(row);
  }

  toView(row: CompanyExport): CompanyExportView {
    const downloadable =
      row.status === 'ready' &&
      !!row.storageKey &&
      !!row.expiresAt &&
      row.expiresAt.getTime() > Date.now();
    return {
      id: row.id,
      status: row.status,
      includeXlsx: row.includeXlsx,
      fileName: row.fileName,
      asOf: row.asOf,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
      error: row.error,
      summary: row.summary,
      downloadUrl: downloadable ? this.downloadUrl(row) : null,
    };
  }

  /** The signed link; its expiry is the file's own. */
  downloadUrl(row: CompanyExport): string {
    const exp = Math.floor((row.expiresAt as Date).getTime() / 1000);
    const token = this.signer.sign({
      exportId: row.id,
      companyId: row.companyId,
      exp,
    });
    return `${this.publicBase}/data-portability/exports/${row.id}/download?token=${encodeURIComponent(token)}`;
  }

  /**
   * Resolve a download: the token IS the authorisation (no session), so it
   * is checked before the row is even looked up, and it must name this very
   * export. Every outcome has a code the clients map to plain words.
   */
  async openDownload(
    exportId: string,
    token: string | undefined,
    client: { ip?: string; userAgent?: string },
  ): Promise<OpenedDownload> {
    const verdict = this.signer.inspect(token);
    if (!verdict.claims) {
      if (verdict.reason === 'expired') {
        throw new GoneException({
          code: 'EXPORT_EXPIRED',
          message:
            'This download link has expired. Create a new backup to get a fresh one.',
        });
      }
      throw new ForbiddenException({
        code: 'EXPORT_LINK_INVALID',
        message: 'This download link is not valid.',
      });
    }
    if (verdict.claims.exportId !== exportId) {
      throw new ForbiddenException({
        code: 'EXPORT_LINK_INVALID',
        message: 'This download link is not valid for this backup.',
      });
    }
    const row = await this.repo.findOne({
      where: { id: exportId, companyId: verdict.claims.companyId },
    });
    if (!row)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Export not found',
      });
    if (row.status === 'queued' || row.status === 'running') {
      throw new ConflictException({
        code: 'EXPORT_NOT_READY',
        message: 'This backup is still being built. Please try again shortly.',
      });
    }
    if (row.status === 'failed') {
      throw new ConflictException({
        code: 'EXPORT_NOT_READY',
        message: 'This backup failed to build. Create a new one.',
      });
    }
    if (
      row.status === 'expired' ||
      !row.storageKey ||
      !row.expiresAt ||
      row.expiresAt.getTime() <= Date.now()
    ) {
      throw new GoneException({
        code: 'EXPORT_EXPIRED',
        message:
          'This backup has expired and its file was deleted. Create a new backup.',
      });
    }
    const stored = await this.storage.read(row.storageKey);
    if (!stored) {
      // The file is gone before its time (a container was replaced with the
      // file on its disk). Say so plainly and stop advertising the link.
      await this.repo.update(
        { id: row.id },
        { status: 'expired', storageKey: null },
      );
      throw new GoneException({
        code: 'EXPORT_EXPIRED',
        message:
          'This backup file is no longer available. Create a new backup.',
      });
    }
    await this.audit.record({
      companyId: row.companyId,
      actorUserId: null,
      action: 'export_downloaded',
      targetType: 'company_export',
      targetId: row.id,
      details: {
        ip: client.ip ?? null,
        userAgent: (client.userAgent ?? '').slice(0, 200) || null,
      },
    });
    return {
      stream: stored.stream,
      size: row.sizeBytes != null ? Number(row.sizeBytes) : stored.size,
      fileName: row.fileName,
    };
  }
}
