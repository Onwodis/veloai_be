/**
 * Cryptographic primitives shared across the auth stack.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest. Used to store refresh tokens without keeping the raw value. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against itself so the call still costs the same time.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** RFC 4122 v4 identifier. */
export function newId(): string {
  return randomUUID();
}
