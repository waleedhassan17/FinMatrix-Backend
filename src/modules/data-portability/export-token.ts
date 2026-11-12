import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface ExportTokenClaims {
  exportId: string;
  companyId: string;
  /** Unix seconds. */
  exp: number;
}

/** verify() refuses an `exp` further out than any token this server issues. */
const MAX_AHEAD_SECONDS = 8 * 86_400;

/**
 * Signed, expiring download tokens for backup ZIPs.
 *
 * A finished backup is fetched by a browser's <a href> and by a phone's
 * download manager, neither of which sends a bearer header. So, as with item
 * photos (MediaUrlSigner), the link carries its own authorisation: an HMAC
 * over the export id, the company and an expiry. Whoever holds the link can
 * download that one file until it expires — and the expiry is the file's own,
 * so a leaked link outlives the file by nothing.
 *
 * The token names the company as well as the export so the download route
 * can refuse a token that was minted for export X but presented against
 * export Y without a database round-trip first.
 *
 * Key: EXPORT_TOKEN_SECRET when configured (required in production), else a
 * key DERIVED from JWT_SECRET under its own label, so a leaked export token
 * can never be replayed as anything to do with a session.
 */
@Injectable()
export class ExportTokenSigner {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = ExportTokenSigner.keyFrom(
      config.get<string>('EXPORT_TOKEN_SECRET'),
      config.get<string>('JWT_SECRET', ''),
    );
  }

  static keyFrom(dedicated: string | undefined, jwtSecret: string): Buffer {
    return dedicated
      ? Buffer.from(dedicated, 'utf8')
      : createHmac('sha256', jwtSecret)
          .update('finmatrix:export-download:v1')
          .digest();
  }

  /** `<payload>.<signature>`, both base64url; payload = id:company:exp. */
  sign(claims: ExportTokenClaims): string {
    const payload = Buffer.from(
      `${claims.exportId}:${claims.companyId}:${Math.floor(claims.exp)}`,
      'utf8',
    ).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  /** The claims when the token is intact and unexpired; otherwise null. */
  verify(
    token: string | undefined,
    nowMs = Date.now(),
  ): ExportTokenClaims | null {
    return this.inspect(token, nowMs).claims;
  }

  /**
   * verify() with the reason: an expired link and a forged one get different
   * answers from the download route (410 EXPORT_EXPIRED vs 403), because the
   * owner can fix one by making a new backup and should be told about the
   * other.
   */
  inspect(
    token: string | undefined,
    nowMs = Date.now(),
  ): {
    claims: ExportTokenClaims | null;
    reason: 'ok' | 'invalid' | 'expired';
  } {
    const invalid = { claims: null, reason: 'invalid' as const };
    if (!token || token.length > 512) return invalid;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return invalid;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'utf8');
    const expected = Buffer.from(this.signature(payload), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return invalid;

    let decoded: string;
    try {
      decoded = Buffer.from(payload, 'base64url').toString('utf8');
    } catch {
      return invalid;
    }
    const parts = decoded.split(':');
    if (parts.length !== 3) return invalid;
    const [exportId, companyId, expRaw] = parts;
    if (
      !UUID.test(exportId) ||
      !UUID.test(companyId) ||
      !/^\d{1,12}$/.test(expRaw)
    )
      return invalid;
    const exp = Number(expRaw);
    const nowSec = Math.floor(nowMs / 1000);
    if (exp > nowSec + MAX_AHEAD_SECONDS) return invalid;
    if (exp <= nowSec) return { claims: null, reason: 'expired' };
    return { claims: { exportId, companyId, exp }, reason: 'ok' };
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
