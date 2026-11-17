/**
 * Authenticated encryption for secrets at rest (TOTP seeds, SMTP passwords,
 * AI keys).
 *
 * AES-256-GCM with a random 96-bit IV per value. Stored as
 * `v1.<iv>.<tag>.<ciphertext>` (base64url), so the format can evolve.
 *
 * Key ring: new values are always encrypted with the current key
 * (DATA_ENCRYPTION_KEY, or a development key derived from JWT_ACCESS_SECRET
 * when it is unset). Decryption also tries older keys, so setting or
 * changing DATA_ENCRYPTION_KEY never locks anyone out:
 *   - DATA_ENCRYPTION_KEY_PREVIOUS, when rotating from one real key to another;
 *   - the derived development key, for values written before a real key was set.
 * `pnpm secrets:rotate` re-encrypts everything with the current key, after
 * which the older keys are no longer needed.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from './logger.js';

function derivedKey(): Buffer {
  return createHash('sha256').update(`${env.APP_SLUG}:data-key:${env.JWT_ACCESS_SECRET}`).digest();
}

function loadKeys(): Buffer[] {
  if (!env.DATA_ENCRYPTION_KEY) {
    logger.warn('DATA_ENCRYPTION_KEY is not set; deriving a development key from JWT_ACCESS_SECRET');
    return [derivedKey()];
  }
  const ring: Buffer[] = [Buffer.from(env.DATA_ENCRYPTION_KEY, 'hex')];
  if (env.DATA_ENCRYPTION_KEY_PREVIOUS) ring.push(Buffer.from(env.DATA_ENCRYPTION_KEY_PREVIOUS, 'hex'));
  ring.push(derivedKey());
  return ring;
}

/** [current, ...older]. */
const KEYS = loadKeys();
const CURRENT = KEYS[0]!;

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', CURRENT, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptWith(key: Buffer, iv: string, tag: string, ciphertext: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Decrypts with the current key, falling back to older keys. `rotated` is
 * true when an older key was needed (the value should be re-encrypted).
 */
export function decryptSecretWithInfo(payload: string): { plaintext: string; rotated: boolean } {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported secret format');
  for (const [index, key] of KEYS.entries()) {
    try {
      return { plaintext: decryptWith(key, iv, tag, ciphertext), rotated: index > 0 };
    } catch {
      // wrong key: try the next one
    }
  }
  throw new Error('Secret could not be decrypted with DATA_ENCRYPTION_KEY or any previous key. Was it encrypted with a key that is no longer configured?');
}

export function decryptSecret(payload: string): string {
  return decryptSecretWithInfo(payload).plaintext;
}

/**
 * A keyed one-way fingerprint (HMAC-SHA256) for values that must never be
 * stored but must be matched, such as government ID numbers: the same input
 * always gives the same fingerprint, and it cannot be reversed without the key.
 * `purpose` separates domains so a fingerprint from one use never matches another.
 */
export function fingerprint(purpose: string, value: string): string {
  return createHmac('sha256', CURRENT).update(`${purpose}\u0000${value}`).digest('hex');
}
