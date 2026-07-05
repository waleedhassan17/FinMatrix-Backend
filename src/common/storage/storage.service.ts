import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v2 as cloudinary } from 'cloudinary';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { StoredFileRecord } from './stored-file.entity';

export interface StoredFile {
  /**
   * Storage key persisted in Postgres. Format identifies the backend:
   *   "cld:<public_id>.<format>"  → Cloudinary (authenticated delivery)
   *   "db:<uuid>"                 → Postgres bytea
   *   anything else               → legacy local-disk path (read-only)
   */
  key: string;
  /** Public URL the frontend can use to fetch the file (auth-gated API route). */
  url: string;
  size: number;
  mimeType: string;
  originalName: string;
}

export interface ReadableStoredFile {
  stream: Readable;
  mimeType: string | null;
  size: number | null;
}

/**
 * Durable file storage (phase3 Chunk 1).
 *
 * Heroku's dyno filesystem is wiped on every restart/deploy, so uploads are
 * NEVER written to local disk anymore:
 *   1. Cloudinary, when CLOUDINARY_URL is configured — assets are uploaded
 *      with `type: 'authenticated'` so they are NOT publicly reachable;
 *      the API streams them back through its own auth-gated endpoints via
 *      short-lived signed URLs.
 *   2. Postgres bytea otherwise (and as the fallback when a Cloudinary
 *      upload fails) — the same pattern already proven for payment
 *      screenshots.
 * Legacy disk keys written before this change remain readable.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;
  private readonly publicBase: string;
  private readonly cloudinaryEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(StoredFileRecord)
    private readonly fileRepo: Repository<StoredFileRecord>,
  ) {
    this.root = this.config.get<string>('UPLOAD_STORAGE_PATH', './storage');
    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3000');
    const apiPrefix = this.config.get<string>('API_PREFIX', 'api/v1');
    this.publicBase = `${appUrl.replace(/\/$/, '')}/${apiPrefix.replace(/^\/|\/$/g, '')}`;

    // The SDK auto-configures from CLOUDINARY_URL; calling config() with no
    // overrides just reads the resolved values.
    const cloudinaryUrl = this.config.get<string>('CLOUDINARY_URL', '');
    this.cloudinaryEnabled = !!cloudinaryUrl;
    if (this.cloudinaryEnabled) {
      cloudinary.config({ secure: true });
      this.logger.log('Storage backend: Cloudinary (authenticated delivery)');
    } else {
      this.logger.log('Storage backend: Postgres bytea (CLOUDINARY_URL not set)');
    }
  }

  /**
   * Persist a buffer durably. Returns metadata + a URL that points at the
   * controller endpoint which streams the file back (so auth stays on it).
   */
  async putBuffer(opts: {
    bucket: string;
    buffer: Buffer;
    mimeType: string;
    originalName: string;
    /** URL pattern, e.g. `/inventory-update-requests/${requestId}/bill-photo`. */
    publicPath: string;
  }): Promise<StoredFile> {
    const url = `${this.publicBase}${opts.publicPath.startsWith('/') ? '' : '/'}${opts.publicPath}`;
    const base = {
      url,
      size: opts.buffer.length,
      mimeType: opts.mimeType,
      originalName: opts.originalName,
    };

    if (this.cloudinaryEnabled) {
      try {
        const key = await this.uploadToCloudinary(opts);
        this.logger.log(`Stored ${key} on Cloudinary (${opts.buffer.length} bytes)`);
        return { key, ...base };
      } catch (err) {
        // Never lose an upload because the CDN hiccuped — fall back to Postgres.
        this.logger.error(
          `Cloudinary upload failed, falling back to Postgres: ${(err as Error).message}`,
        );
      }
    }

    const record = await this.fileRepo.save(
      this.fileRepo.create({
        bucket: opts.bucket,
        mimeType: opts.mimeType,
        originalName: opts.originalName,
        size: opts.buffer.length,
        data: opts.buffer,
      }),
    );
    this.logger.log(`Stored db:${record.id} in Postgres (${opts.buffer.length} bytes)`);
    return { key: `db:${record.id}`, ...base };
  }

  /** Stream a previously-stored file back, regardless of backend. */
  async read(key: string): Promise<ReadableStoredFile | null> {
    if (key.startsWith('cld:')) return this.readFromCloudinary(key);
    if (key.startsWith('db:')) return this.readFromDatabase(key.slice(3));
    return this.readFromDisk(key);
  }

  async remove(key: string): Promise<void> {
    try {
      if (key.startsWith('cld:')) {
        const publicId = key.slice(4).replace(/\.[a-z0-9]+$/i, '');
        await cloudinary.uploader.destroy(publicId, { type: 'authenticated' });
      } else if (key.startsWith('db:')) {
        await this.fileRepo.delete({ id: key.slice(3) });
      } else {
        await fs.promises.unlink(path.join(this.root, key));
      }
    } catch {
      // best-effort; ignore
    }
  }

  // ── Cloudinary backend ─────────────────────────────

  private async uploadToCloudinary(opts: {
    bucket: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<string> {
    const now = new Date();
    const folder = `${opts.bucket}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const publicId = `${folder}/${randomUUID()}`;
    const dataUri = `data:${opts.mimeType};base64,${opts.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      public_id: publicId,
      resource_type: 'image',
      // Authenticated assets are not publicly accessible — delivery requires
      // a signed URL, which only this API generates.
      type: 'authenticated',
      overwrite: false,
    });
    return `cld:${result.public_id}.${result.format}`;
  }

  private async readFromCloudinary(key: string): Promise<ReadableStoredFile | null> {
    if (!this.cloudinaryEnabled) {
      this.logger.error(`Cannot read ${key}: CLOUDINARY_URL is not configured`);
      return null;
    }
    const rest = key.slice(4);
    const extMatch = rest.match(/\.([a-z0-9]+)$/i);
    const format = extMatch?.[1] ?? 'jpg';
    const publicId = rest.replace(/\.[a-z0-9]+$/i, '');
    // Short-lived signed delivery URL; the asset itself stays private.
    const signedUrl = cloudinary.url(`${publicId}.${format}`, {
      resource_type: 'image',
      type: 'authenticated',
      sign_url: true,
      secure: true,
    });
    const res = await fetch(signedUrl);
    if (!res.ok || !res.body) {
      this.logger.error(`Cloudinary fetch failed for ${key}: HTTP ${res.status}`);
      return null;
    }
    const length = res.headers.get('content-length');
    return {
      stream: Readable.fromWeb(res.body as import('stream/web').ReadableStream),
      mimeType: res.headers.get('content-type') ?? this.mimeFromExt(format),
      size: length ? parseInt(length, 10) : null,
    };
  }

  // ── Postgres backend ───────────────────────────────

  private async readFromDatabase(id: string): Promise<ReadableStoredFile | null> {
    const record = await this.fileRepo
      .createQueryBuilder('f')
      .addSelect('f.data')
      .where('f.id = :id', { id })
      .getOne();
    if (!record?.data) return null;
    return {
      stream: Readable.from(record.data),
      mimeType: record.mimeType,
      size: record.size,
    };
  }

  // ── Legacy disk backend (read-only) ────────────────

  private async readFromDisk(key: string): Promise<ReadableStoredFile | null> {
    const absolutePath = path.join(this.root, key);
    try {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
    } catch {
      return null;
    }
    return {
      stream: fs.createReadStream(absolutePath),
      mimeType: this.mimeFromExt(path.extname(absolutePath).slice(1)),
      size: null,
    };
  }

  private mimeFromExt(ext: string): string {
    switch (ext.toLowerCase()) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      default:
        return 'application/octet-stream';
    }
  }
}
