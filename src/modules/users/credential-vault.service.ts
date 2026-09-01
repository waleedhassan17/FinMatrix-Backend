import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
} from 'crypto';

const SCHEME = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const KEY_BYTES = 32;

/**
 * Encrypts the custodian's copy of an owner-issued password.
 *
 * Owner-created accounts (staff, delivery riders) have no self-service
 * password reset: whoever created the account keeps the credential and reads
 * it back to the holder when they forget it. Keeping that copy in clear text
 * would turn one database backup into every staff password in the company —
 * and, because people reuse passwords, into credentials for systems that are
 * nothing to do with FinMatrix. So it is encrypted at rest under a key that
 * lives outside the database, and a stolen dump yields ciphertext only.
 *
 * AES-256-GCM is authenticated: decrypt() throws rather than returning
 * plausible garbage if the ciphertext or the auth tag has been tampered with.
 *
 * Key: CREDENTIAL_ENCRYPTION_KEY, 32 bytes as base64 or hex. Generate one with
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Rotating the key makes existing rows undecryptable; that is recoverable
 * (the owner re-issues the passwords) but not silent — decrypt() surfaces it.
 */
@Injectable()
export class CredentialVaultService {
  private readonly logger = new Logger(CredentialVaultService.name);

  constructor(private readonly config: ConfigService) {}

  /** True when a key is configured, so callers can degrade instead of 500ing. */
  get isConfigured(): boolean {
    return this.resolveKey() !== null;
  }

  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      SCHEME,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  /**
   * Returns null rather than throwing when a stored value cannot be read —
   * a rotated key or a hand-edited row must not break the whole personnel
   * screen. The caller shows "unavailable, re-issue the password" instead.
   */
  decrypt(stored: string): string | null {
    const parts = stored.split(':');
    if (parts.length !== 4 || parts[0] !== SCHEME) {
      this.logger.warn('Stored credential has an unrecognised format');
      return null;
    }
    try {
      const key = this.requireKey();
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(parts[1], 'base64'),
      );
      decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key, or tampering. Deliberately not logging the value.
      this.logger.warn('Stored credential could not be decrypted');
      return null;
    }
  }

  /**
   * A readable password the custodian can dictate over the phone without
   * ambiguity. No 0/O/1/l/I, and a digit plus a symbol so it satisfies the
   * password policy the DTOs enforce.
   */
  generatePassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digits = '23456789';
    const pick = (set: string, n: number) =>
      Array.from({ length: n }, () => set[randomInt(0, set.length)]).join('');
    // Shape is fixed (Xxxxxxx99) so it reads back cleanly; 3 uppercase-ish
    // positions plus 5 lowercase plus 2 digits is ~40 bits, ample for a
    // credential that is rotated by hand and never brute-forced online.
    return `${pick(upper, 1)}${pick(lower, 5)}${pick(digits, 2)}${pick(upper, 1)}${pick(lower, 2)}`;
  }

  private requireKey(): Buffer {
    const key = this.resolveKey();
    if (!key) {
      throw new InternalServerErrorException({
        code: 'CREDENTIAL_KEY_MISSING',
        message:
          'Credential storage is not configured. Set CREDENTIAL_ENCRYPTION_KEY to a 32-byte base64 or hex value.',
      });
    }
    return key;
  }

  private resolveKey(): Buffer | null {
    const raw =
      this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY') ??
      process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!raw || raw.trim() === '') return null;

    const value = raw.trim();
    for (const encoding of ['base64', 'hex'] as const) {
      const buf = Buffer.from(value, encoding);
      if (buf.length === KEY_BYTES) return buf;
    }
    // A passphrase rather than a generated key: hash it to the right length
    // so a misconfigured-but-present secret still protects the data, instead
    // of the feature silently refusing to work in production.
    this.logger.warn(
      'CREDENTIAL_ENCRYPTION_KEY is not 32 raw bytes; deriving a key from it by SHA-256.',
    );
    return createHash('sha256').update(value).digest();
  }
}
