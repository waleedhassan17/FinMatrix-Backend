import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export type ItemImageVariant = 'display' | 'thumb';

export interface ItemImageUrls {
  imageUrl: string | null;
  thumbnailUrl: string | null;
}

const DAY = 86_400;
/** A link is valid for at least 7 days and at most 8 (see expiryFor). */
const VALID_DAYS = 8;
/** verify() refuses an `exp` further out than any link this server issues. */
const MAX_AHEAD_DAYS = VALID_DAYS + 1;

/**
 * Signed, expiring URLs for item photos.
 *
 * Every other stored file in FinMatrix is streamed through an auth-gated route,
 * and the clients download it with their token first. That is fine for a
 * receipt opened once; it is not fine for a 25-row item list, where every
 * thumbnail would be a separate authenticated fetch, a web `<img>` cannot send
 * a bearer header at all, and react-pdf has to fetch the image itself to put it
 * on a quotation.
 *
 * So the URL carries its own authorisation: an HMAC over the image id, the
 * rendition and an expiry. Whoever holds the link can see that one photo until
 * it expires — the same contract as an S3 presigned URL — and nobody can mint
 * a link for another photo without the server's key.
 *
 * The expiry is rounded to the end of a UTC day, so every response issued
 * during a day carries the IDENTICAL URL for a given photo. Browsers, Android's
 * image cache and react-query all key on the URL, so that is what lets a list
 * that refetches every 30 s keep hitting the cache instead of re-downloading.
 */
@Injectable()
export class MediaUrlSigner {
  private readonly logger = new Logger(MediaUrlSigner.name);
  private readonly key: Buffer;
  private readonly base: string;

  constructor(config: ConfigService) {
    // A dedicated secret when one is configured; otherwise a key DERIVED from
    // JWT_SECRET under its own label, so a leaked media signature can never be
    // replayed as anything to do with a session token.
    const dedicated = config.get<string>('MEDIA_URL_SECRET');
    const jwtSecret = config.get<string>('JWT_SECRET', '');
    this.key = dedicated
      ? Buffer.from(dedicated, 'utf8')
      : createHmac('sha256', jwtSecret)
          .update('finmatrix:media-url:v1')
          .digest();

    // Built exactly as StorageService.publicBase is, so a photo URL and a
    // stored-file URL always agree about which host the API lives on.
    const appUrl = config.get<string>('APP_URL', 'http://localhost:3000');
    const apiPrefix = config.get<string>('API_PREFIX', 'api/v1');
    this.base = `${appUrl.replace(/\/$/, '')}/${apiPrefix.replace(/^\/|\/$/g, '')}`;

    if (
      config.get<string>('NODE_ENV') === 'production' &&
      !/^https:\/\//i.test(appUrl)
    ) {
      // The web app is served over https; an http photo URL is mixed content
      // and the browser will refuse to load it.
      this.logger.warn(
        `APP_URL is not https (${appUrl}) — item photos will not load on the web app.`,
      );
    }
  }

  /** `{imageUrl, thumbnailUrl}` for an item's current photo, or both null. */
  urlsFor(
    imageId: string | null | undefined,
    nowMs = Date.now(),
  ): ItemImageUrls {
    if (!imageId) return { imageUrl: null, thumbnailUrl: null };
    const exp = MediaUrlSigner.expiryFor(nowMs);
    return {
      imageUrl: this.url(imageId, 'display', exp),
      thumbnailUrl: this.url(imageId, 'thumb', exp),
    };
  }

  verify(
    imageId: string,
    variant: ItemImageVariant,
    exp: string | undefined,
    sig: string | undefined,
    nowMs = Date.now(),
  ): boolean {
    if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
    const expSec = Number(exp);
    const nowSec = Math.floor(nowMs / 1000);
    if (expSec <= nowSec || expSec > nowSec + MAX_AHEAD_DAYS * DAY)
      return false;

    const expected = Buffer.from(this.sign(imageId, variant, expSec), 'utf8');
    const given = Buffer.from(sig, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** End of the UTC day VALID_DAYS from now — identical all day long. */
  static expiryFor(nowMs: number): number {
    return (Math.floor(nowMs / 1000 / DAY) + VALID_DAYS) * DAY;
  }

  private url(imageId: string, variant: ItemImageVariant, exp: number): string {
    // The path ends in `.jpg` on purpose: the web PDF renderer only embeds
    // images whose URL says png/jpg, and every rendition is a JPEG.
    return (
      `${this.base}/media/item-images/${imageId}/${variant}.jpg` +
      `?exp=${exp}&sig=${this.sign(imageId, variant, exp)}`
    );
  }

  private sign(
    imageId: string,
    variant: ItemImageVariant,
    exp: number,
  ): string {
    return createHmac('sha256', this.key)
      .update(`item-image|${imageId}|${variant}|${exp}`)
      .digest('base64url');
  }
}
