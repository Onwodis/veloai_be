/**
 * Share-link tokens: AES-256-GCM over {link id, mode, key version}, base64url.
 * Nothing in the URL is readable or guessable; the mode lives inside the
 * ciphertext, so a VIEW link cannot be edited into a DOWNLOAD link.
 *
 * The IV is synthetic (HMAC of the plaintext), so the same link + version always
 * gives the same URL (the list can show it again), while a rotation (new key
 * version) gives a completely different one. The key is derived from
 * DATA_ENCRYPTION_KEY (or the JWT secret in development) with its own label.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import { env } from '../config/env.js';

export type ShareMode = 'VIEW' | 'DOWNLOAD';

interface Payload {
  l: string;
  m: ShareMode;
  v: number;
}

const keys = (() => {
  let cached: { enc: Buffer; iv: Buffer } | null = null;
  return () => {
    if (cached) return cached;
    const root = env.DATA_ENCRYPTION_KEY ?? `${env.APP_SLUG}:${env.JWT_ACCESS_SECRET}`;
    cached = {
      enc: createHash('sha256').update(`share-links:enc:v1:${root}`).digest(),
      iv: createHash('sha256').update(`share-links:iv:v1:${root}`).digest(),
    };
    return cached;
  };
})();

export function encodeShareToken(linkId: string, mode: ShareMode, version: number): string {
  const plaintext = Buffer.from(JSON.stringify({ l: linkId, m: mode, v: version } satisfies Payload));
  const iv = createHmac('sha256', keys().iv).update(plaintext).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', keys().enc, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The link the token points at, or null for anything forged, edited or malformed. */
export function decodeShareToken(token: string): Payload | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 12 + 16 + 10 || raw.length > 400) return null;
    const decipher = createDecipheriv('aes-256-gcm', keys().enc, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as Payload;
    return typeof payload.l === 'string' && (payload.m === 'VIEW' || payload.m === 'DOWNLOAD') && Number.isInteger(payload.v) ? payload : null;
  } catch {
    return null;
  }
}
