import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface StoredFile {
  /** Path on disk relative to the storage root, e.g. "bill-photos/2026/04/<uuid>.jpg". */
  key: string;
  /** Absolute filesystem path. */
  absolutePath: string;
  /** Public URL the frontend can use to fetch the file (auth-gated). */
  url: string;
  size: number;
  mimeType: string;
  originalName: string;
}

/**
 * Local-filesystem storage. Good enough for dev + ephemeral prod (Render free).
 *
 * To upgrade to S3/R2/Backblaze without changing call sites, swap the body of
 * `putBuffer` and `read` for an S3 client implementation. Keep the same
 * StoredFile shape.
 *
 * NOTE: Container filesystems on Render/Heroku are ephemeral — files written
 * here disappear on every redeploy. For real production usage, swap to S3.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;
  private readonly publicBase: string;

  constructor(private readonly config: ConfigService) {
    this.root = this.config.get<string>('UPLOAD_STORAGE_PATH', './storage');
    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3000');
    const apiPrefix = this.config.get<string>('API_PREFIX', 'api/v1');
    this.publicBase = `${appUrl.replace(/\/$/, '')}/${apiPrefix.replace(/^\/|\/$/g, '')}`;
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * Persist a buffer under <bucket>/yyyy/mm/<uuid>.<ext>.
   * Returns metadata + a URL that points at the controller endpoint
   * which streams the file back (so we can keep auth on it).
   */
  async putBuffer(opts: {
    bucket: string;
    buffer: Buffer;
    mimeType: string;
    originalName: string;
    /** URL pattern, e.g. `/inventory-update-requests/${requestId}/bill-photo`. */
    publicPath: string;
  }): Promise<StoredFile> {
    const ext = path.extname(opts.originalName).toLowerCase() || this.extFromMime(opts.mimeType);
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const filename = `${randomUUID()}${ext}`;
    const key = path.posix.join(opts.bucket, yyyy, mm, filename);
    const absolutePath = path.join(this.root, key);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, opts.buffer);
    this.logger.log(`Stored ${key} (${opts.buffer.length} bytes)`);
    return {
      key,
      absolutePath,
      url: `${this.publicBase}${opts.publicPath.startsWith('/') ? '' : '/'}${opts.publicPath}`,
      size: opts.buffer.length,
      mimeType: opts.mimeType,
      originalName: opts.originalName,
    };
  }

  /** Stream a previously-stored file back. */
  async read(key: string): Promise<{ stream: fs.ReadStream; absolutePath: string } | null> {
    const absolutePath = path.join(this.root, key);
    try {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
    } catch {
      return null;
    }
    return { stream: fs.createReadStream(absolutePath), absolutePath };
  }

  async remove(key: string): Promise<void> {
    const absolutePath = path.join(this.root, key);
    try {
      await fs.promises.unlink(absolutePath);
    } catch {
      // best-effort; ignore
    }
  }

  private extFromMime(mime: string): string {
    switch (mime) {
      case 'image/jpeg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      default:
        return '.bin';
    }
  }
}
