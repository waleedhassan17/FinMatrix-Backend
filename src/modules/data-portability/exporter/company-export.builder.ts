import { Injectable, Logger } from '@nestjs/common';
import archiver from 'archiver';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { EntityManager } from 'typeorm';
import { StorageService } from '../../../common/storage/storage.service';
import { Company } from '../../companies/entities/company.entity';
import { User } from '../../users/entities/user.entity';
import {
  REPORT_RANGE_DEFAULTS,
  ReportsService,
} from '../../reports/reports.service';
import { fiscalYearStart, clampMonth } from '../../reports/fiscal-year';
import { CsvSink } from './csv-sink';
import {
  EXPORT_ENTITIES,
  exportColumns,
  iterateExportRows,
} from './export-entities';
import { listCompanyAttachments } from './attachments';
import { backendCommit, buildManifest, ManifestEntity } from './manifest';
import { ExportReportPdfs } from './report-pdfs';
import { serializeRow } from './row-serializer';
import { XlsxSink } from './xlsx-sink';

export interface BuildExportArgs {
  manager: EntityManager;
  companyId: string;
  exportId: string;
  /** Business day the backup describes. */
  asOf: string;
  includeXlsx: boolean;
  requestedBy: string;
  /** Where the ZIP bytes go (a StorageStreamSink's stream). */
  sink: Writable;
  onProgress?: (note: string) => void;
}

export interface BuildExportResult {
  entities: Record<string, ManifestEntity>;
  attachments: { included: number; missing: number };
  reports: string[];
  bytes: number;
  peakRssBytes: number;
}

/** Highest resident set size seen while building — for the perf report. */
class PeakRss {
  max = process.memoryUsage().rss;
  sample() {
    const rss = process.memoryUsage().rss;
    if (rss > this.max) this.max = rss;
  }
}

/**
 * Builds one backup ZIP, streaming end to end.
 *
 * Order inside the archive: data/*.csv (every registry entry, parents before
 * lines), the optional workbook, reports/*.pdf, attachments/, and
 * manifest.json last because it holds the checksum of everything before it.
 *
 * Nothing is buffered whole. Rows are read a page at a time and written into
 * the CSV entry the archive is consuming; the workbook is written to a temp
 * file by ExcelJS's streaming writer and added from disk; attachments are
 * piped straight from storage. Each entry is awaited before the next starts,
 * so at most one table is in flight — that is what keeps a 50,000-document
 * company inside a 1 GB task.
 *
 * A read of a company's data goes through the registry's scoped query and
 * nowhere else; the attachments query is scoped by the owning tables.
 */
@Injectable()
export class CompanyExportBuilder {
  private readonly logger = new Logger(CompanyExportBuilder.name);

  constructor(
    private readonly reports: ReportsService,
    private readonly pdfs: ExportReportPdfs,
    private readonly storage: StorageService,
  ) {}

  async build(args: BuildExportArgs): Promise<BuildExportResult> {
    const { manager, companyId } = args;
    if (!companyId) throw new Error('Export requires a companyId');
    const company = await manager.findOne(Company, {
      where: { id: companyId },
    });
    if (!company) throw new Error(`Company ${companyId} not found`);
    const user = await manager.findOne(User, {
      where: { id: args.requestedBy },
    });

    const archive = archiver('zip', { zlib: { level: 6 } });
    let failure: Error | null = null;
    const fail = (e: Error) => {
      if (!failure) failure = e;
    };
    archive.on('warning', (w) => this.logger.warn(`zip warning: ${w.message}`));
    archive.on('error', fail);
    args.sink.on('error', fail);
    const sinkDone = new Promise<void>((resolve) => {
      args.sink.on('finish', resolve);
      args.sink.on('close', resolve);
    });
    archive.pipe(args.sink);
    const peak = new PeakRss();
    const throwIfFailed = () => {
      if (failure) throw failure;
    };

    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'finmatrix-export-'),
    );
    const xlsxPath = path.join(tmpDir, 'FinMatrix-Export.xlsx');
    const xlsx = args.includeXlsx ? new XlsxSink(xlsxPath) : null;
    const entities: Record<string, ManifestEntity> = {};

    try {
      // ── data/*.csv (and the workbook's sheets, from the same pass) ────
      for (const def of EXPORT_ENTITIES) {
        const columns = exportColumns(manager, def);
        const headers = columns.map((c) => c.header);
        const csv = new CsvSink(headers);
        const sheet = xlsx ? xlsx.sheet(def.name, headers) : null;
        const name = `data/${def.name}.csv`;
        const written = this.entryWritten(archive, name);
        archive.append(csv.readable, { name });
        for await (const page of iterateExportRows(manager, def, companyId)) {
          for (const row of page) {
            const values = serializeRow(
              row as Record<string, unknown>,
              columns,
            );
            await csv.write(values);
            sheet?.addRow(values);
          }
          peak.sample();
          throwIfFailed();
        }
        const stats = await csv.end();
        await written;
        if (sheet) await sheet.commit();
        entities[def.name] = { rows: stats.rows, sha256: stats.sha256 };
        args.onProgress?.(`${def.name}: ${stats.rows} rows`);
      }

      // ── FinMatrix-Export.xlsx ─────────────────────────────────────────
      if (xlsx) {
        await xlsx.finish();
        const written = this.entryWritten(archive, 'FinMatrix-Export.xlsx');
        archive.file(xlsxPath, { name: 'FinMatrix-Export.xlsx' });
        await written;
        peak.sample();
      }

      // ── reports/*.pdf ─────────────────────────────────────────────────
      const trialBalance = await this.reports.trialBalance(
        companyId,
        REPORT_RANGE_DEFAULTS.startDate,
        args.asOf,
      );
      const fyStart = fiscalYearStart(
        clampMonth(company.fiscalYearStartMonth),
        args.asOf,
      );
      const pdfs = await this.pdfs.build({
        company,
        asOf: args.asOf,
        fiscalYearStart: fyStart,
        trialBalance,
      });
      const reports: string[] = [];
      for (const pdf of pdfs) {
        const name = `reports/${pdf.name}`;
        const written = this.entryWritten(archive, name);
        archive.append(pdf.buffer, { name });
        await written;
        reports.push(name);
      }

      // ── attachments/ ──────────────────────────────────────────────────
      const refs = await listCompanyAttachments(manager, companyId, company);
      let included = 0;
      let missing = 0;
      for (const ref of refs) {
        // A storage outage throws (ServiceUnavailableException) and fails the
        // backup — an incomplete archive that looks complete is worse than a
        // retry. A file that is simply gone is counted and skipped.
        const stored = await this.storage.read(ref.storageKey);
        if (!stored) {
          missing += 1;
          continue;
        }
        const written = this.entryWritten(archive, ref.zipPath);
        archive.append(stored.stream, { name: ref.zipPath });
        await written;
        included += 1;
        peak.sample();
        throwIfFailed();
      }

      // ── manifest.json ─────────────────────────────────────────────────
      const manifest = buildManifest({
        backendCommit: backendCommit(),
        company: {
          id: company.id,
          name: company.name,
          currency: company.homeCurrency ?? 'PKR',
          fiscalYearStart: fyStart,
        },
        exportedAt: new Date(),
        exportedBy: {
          userId: args.requestedBy,
          name: user?.displayName ?? user?.email ?? args.requestedBy,
        },
        asOf: args.asOf,
        includeXlsx: Boolean(xlsx),
        entities,
        trialBalance,
        reports,
        attachments: { included, missing },
      });
      const manifestWritten = this.entryWritten(archive, 'manifest.json');
      archive.append(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), {
        name: 'manifest.json',
      });
      await manifestWritten;

      await archive.finalize();
      await sinkDone;
      throwIfFailed();
      return {
        entities,
        attachments: { included, missing },
        reports,
        bytes: archive.pointer(),
        peakRssBytes: peak.max,
      };
    } catch (err) {
      archive.abort();
      throw err;
    } finally {
      await fs.promises
        .rm(tmpDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  /** Resolves once the archive has fully written the named entry. */
  private entryWritten(
    archive: archiver.Archiver,
    name: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onEntry = (entry: archiver.EntryData) => {
        if (entry.name === name) {
          cleanup();
          resolve();
        }
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        archive.off('entry', onEntry);
        archive.off('error', onError);
      };
      archive.on('entry', onEntry);
      archive.on('error', onError);
    });
  }
}
