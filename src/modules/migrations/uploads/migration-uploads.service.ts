import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { DataSource, In } from 'typeorm';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { assertBooksEmpty } from '../commit/migration-commit.service';
import { MigrationBatch } from '../entities/migration-batch.entity';
import { MigrationFile } from '../entities/migration-file.entity';
import {
  MigrationUpload,
  MigrationUploadPart,
} from '../entities/migration-upload.entity';
import { assertEditable, lockEditable } from '../state-machine';

/** Each piece is one request: small enough for any connection, big enough to be quick. */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
/** Only Peachtree / Sage 50 backups come this way; spreadsheets keep their own route. */
/** A Peachtree backup, or any other export too big for the direct route. */
const LARGE_KINDS = /\.(ptb|zip|xlsx|csv|tsv|txt|iif|xml)$/i;
/** Uploads waiting for pieces this long are abandoned and removed. */
export const ABANDONED_AFTER_HOURS = 24;

const ACTIVE: MigrationUpload['status'][] = [
  'receiving',
  'received',
  'reading',
];

export interface StartUploadDto {
  name: string;
  size: number;
}

/**
 * Large uploads for the Migration Center, in pieces held in the database
 * until the background reader (migration-read.worker) has read the file.
 *
 * Starting an upload with the same name and size as one already receiving
 * returns that upload, with the pieces the server holds — so a dropped
 * connection, a closed browser or an app killed mid-way resumes rather than
 * starting again. A piece may be sent twice; the second replaces the first.
 */
@Injectable()
export class MigrationUploadsService {
  readonly maxBytes: number;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.maxBytes = Number(
      config.get('MIGRATION_MAX_UPLOAD_BYTES') ?? 2_147_483_648,
    );
  }

  partCount(u: Pick<MigrationUpload, 'sizeBytes' | 'partSize'>): number {
    return Math.max(1, Math.ceil(u.sizeBytes / u.partSize));
  }

  private expectedPartSize(u: MigrationUpload, partNo: number): number {
    const last = this.partCount(u) - 1;
    return partNo < last ? u.partSize : u.sizeBytes - u.partSize * last;
  }

  async start(
    companyId: string,
    user: AuthenticatedUser,
    batchId: string,
    dto: StartUploadDto,
  ) {
    const name = String(dto.name ?? '')
      .trim()
      .slice(0, 255);
    const size = Number(dto.size);
    if (!name || !LARGE_KINDS.test(name)) {
      throw new BadRequestException({
        code: 'MIGRATION_FILE_UNREADABLE',
        message:
          'This way takes a Peachtree backup (.ptb) or a large export: .zip, .xlsx, .csv, .tsv, .txt, .iif or .xml.',
      });
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'The file size is missing.',
      });
    }
    if (size > this.maxBytes) {
      throw new PayloadTooLargeException({
        code: 'MIGRATION_FILE_TOO_LARGE',
        message: `${name} is ${gb(size)}; the limit is ${gb(this.maxBytes)}.`,
      });
    }
    return this.dataSource.transaction(async (em) => {
      await lockEditable(em, companyId, batchId);
      await assertBooksEmpty(em, companyId, batchId);
      const backup = await em.findOne(MigrationFile, {
        where: { batchId, companyId, kind: 'ptb' },
      });
      if (backup) {
        throw new ConflictException({
          code: 'MIGRATION_INVALID_TRANSITION',
          message: `This migration already has a Peachtree backup (${backup.originalName}). Remove it before adding another.`,
        });
      }
      const active = await em.find(MigrationUpload, {
        where: { batchId, companyId, status: In(ACTIVE) },
      });
      const same = active.find(
        (u) =>
          u.status === 'receiving' &&
          u.originalName === name &&
          u.sizeBytes === size,
      );
      if (same) return this.view(same, em);
      if (active.length) {
        throw new ConflictException({
          code: 'MIGRATION_INVALID_TRANSITION',
          message: `${active[0].originalName} is still being ${active[0].status === 'receiving' ? 'uploaded' : 'read'}. Wait for it, or cancel it first.`,
        });
      }
      const upload = await em.save(
        em.create(MigrationUpload, {
          companyId,
          batchId,
          originalName: name,
          sizeBytes: size,
          partSize: UPLOAD_PART_BYTES,
          status: 'receiving',
          progress: null,
          sha256: null,
          errorCode: null,
          error: null,
          attempts: 0,
          fileId: null,
          createdBy: user.id,
          receivedAt: null,
          startedAt: null,
          finishedAt: null,
        }),
      );
      return this.view(upload, em);
    });
  }

  async putPart(
    companyId: string,
    batchId: string,
    uploadId: string,
    partNo: number,
    body: Buffer,
    sha256?: string,
  ) {
    const upload = await this.load(companyId, batchId, uploadId);
    if (upload.status !== 'receiving') {
      throw new ConflictException({
        code: 'MIGRATION_INVALID_TRANSITION',
        message: 'This upload is complete; it takes no more pieces.',
      });
    }
    if (
      !Number.isInteger(partNo) ||
      partNo < 0 ||
      partNo >= this.partCount(upload)
    ) {
      throw new BadRequestException({
        code: 'MIGRATION_UPLOAD_INCOMPLETE',
        message: `There is no piece ${partNo} in this upload.`,
      });
    }
    const expected = this.expectedPartSize(upload, partNo);
    if (body.length !== expected) {
      throw new BadRequestException({
        code: 'MIGRATION_UPLOAD_PART_CORRUPT',
        message: `Piece ${partNo} arrived with ${body.length} bytes; it has ${expected}. Send it again.`,
      });
    }
    if (sha256) {
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== sha256.trim().toLowerCase()) {
        throw new BadRequestException({
          code: 'MIGRATION_UPLOAD_PART_CORRUPT',
          message: `Piece ${partNo} was damaged on the way. Send it again.`,
        });
      }
    }
    await this.dataSource.query(
      `INSERT INTO migration_upload_parts (upload_id, part_no, size_bytes, data)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (upload_id, part_no) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, created_at = now()`,
      [upload.id, partNo, body.length, body],
    );
    await this.dataSource.query(
      `UPDATE migration_uploads SET updated_at = now() WHERE id = $1`,
      [upload.id],
    );
    return { partNo, received: true };
  }

  async complete(companyId: string, batchId: string, uploadId: string) {
    return this.dataSource.transaction(async (em) => {
      await lockEditable(em, companyId, batchId);
      const upload = await em.findOne(MigrationUpload, {
        where: { id: uploadId, batchId, companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!upload) throw notFound();
      if (upload.status !== 'receiving') return this.view(upload, em);
      const [held] = await em.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(size_bytes), 0)::bigint AS bytes
           FROM migration_upload_parts WHERE upload_id = $1`,
        [upload.id],
      );
      const total = this.partCount(upload);
      if (Number(held.n) !== total || Number(held.bytes) !== upload.sizeBytes) {
        const missing = await this.missingParts(em, upload);
        throw new BadRequestException({
          code: 'MIGRATION_UPLOAD_INCOMPLETE',
          message: `${missing.length} of ${total} pieces have not arrived yet.`,
          details: { missing: missing.slice(0, 50) },
        });
      }
      upload.status = 'received';
      upload.receivedAt = new Date();
      upload.progress = {
        stage: 'assembling',
        done: 0,
        total: upload.sizeBytes,
      };
      await em.save(upload);
      return this.view(upload, em);
    });
  }

  async status(companyId: string, batchId: string, uploadId: string) {
    const upload = await this.load(companyId, batchId, uploadId);
    return this.view(upload);
  }

  async listForBatch(companyId: string, batchId: string) {
    const rows = await this.dataSource.manager.find(MigrationUpload, {
      where: { batchId, companyId },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    return Promise.all(rows.map((u) => this.view(u)));
  }

  async cancel(companyId: string, batchId: string, uploadId: string) {
    const batch = await this.dataSource.manager.findOne(MigrationBatch, {
      where: { id: batchId, companyId },
    });
    if (!batch) throw notFound();
    assertEditable(batch.status);
    const upload = await this.load(companyId, batchId, uploadId);
    if (upload.status === 'reading') {
      throw new ConflictException({
        code: 'MIGRATION_INVALID_TRANSITION',
        message:
          'The backup is being read right now. Wait a moment, then remove the file if you do not want it.',
      });
    }
    await this.dataSource.transaction(async (em) => {
      await em.delete(MigrationUploadPart, { uploadId: upload.id });
      await em.delete(MigrationUpload, { id: upload.id });
    });
    return { id: upload.id, cancelled: true };
  }

  private async load(companyId: string, batchId: string, uploadId: string) {
    const upload = await this.dataSource.manager.findOne(MigrationUpload, {
      where: { id: uploadId, batchId, companyId },
    });
    if (!upload) throw notFound();
    return upload;
  }

  private async missingParts(
    em: { query: DataSource['query'] },
    upload: MigrationUpload,
  ): Promise<number[]> {
    const rows: Array<{ part_no: number }> = await em.query(
      `SELECT part_no FROM migration_upload_parts WHERE upload_id = $1`,
      [upload.id],
    );
    const have = new Set(rows.map((r) => Number(r.part_no)));
    const out: number[] = [];
    for (let i = 0; i < this.partCount(upload); i++)
      if (!have.has(i)) out.push(i);
    return out;
  }

  private async view(
    u: MigrationUpload,
    em: { query: DataSource['query'] } = this.dataSource,
  ) {
    const received: number[] =
      u.status === 'receiving'
        ? (
            await em.query(
              `SELECT part_no FROM migration_upload_parts WHERE upload_id = $1 ORDER BY part_no`,
              [u.id],
            )
          ).map((r: { part_no: number }) => Number(r.part_no))
        : [];
    return {
      id: u.id,
      batchId: u.batchId,
      name: u.originalName,
      size: u.sizeBytes,
      partSize: u.partSize,
      parts: this.partCount(u),
      status: u.status,
      received,
      progress: u.progress,
      errorCode: u.errorCode,
      error: u.error,
      fileId: u.fileId,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }
}

const notFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: 'Upload not found' });

const gb = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** Read a raw request body up to `limit` bytes; refuse anything larger. */
export async function readRawBody(
  req: NodeJS.ReadableStream,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > limit) {
      throw new PayloadTooLargeException({
        code: 'MIGRATION_UPLOAD_PART_CORRUPT',
        message: `A piece may be at most ${limit} bytes.`,
      });
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, size);
}
