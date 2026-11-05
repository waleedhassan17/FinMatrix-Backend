import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * A company's own WhatsApp access token, encrypted at rest with AES-256-GCM
 * under MESSAGING_ENCRYPTION_KEY (32 bytes, base64). Same stored shape as
 * CredentialVaultService (`v1:iv:tag:ciphertext`, each part base64) so the two
 * read alike, but a separate key: rotating one never breaks the other.
 *
 * GCM is authenticated, so a tampered value or a wrong key fails to decrypt
 * (decryptToken returns null) instead of yielding a plausible wrong token.
 */
const SCHEME = 'v1';
const IV_BYTES = 12;

export function messagingKey(raw: string | undefined | null): Buffer | null {
  if (!raw || raw.trim() === '') return null;
  const key = Buffer.from(raw.trim(), 'base64');
  return key.length === 32 ? key : null;
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    SCHEME,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptToken(
  stored: string | null | undefined,
  key: Buffer | null,
): string | null {
  if (!stored || !key) return null;
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== SCHEME) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1], 'base64'),
    );
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** What the settings API shows instead of a token: the last four characters. */
export function maskToken(plaintext: string | null): string | null {
  if (!plaintext) return null;
  return `••••${plaintext.slice(-4)}`;
}
