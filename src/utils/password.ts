/**
 * Password hashing with argon2id (OWASP 2024 baseline parameters).
 */
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** True when a stored hash was produced with weaker parameters than today's. */
export function passwordNeedsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, HASH_OPTIONS);
}

/**
 * A real argon2id hash of a random string, computed once at boot. Login
 * verifies against it when the email is unknown, so "no such user" and
 * "wrong password" take the same time and cannot be told apart.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash(`timing-equaliser-${randomUUID()}`, HASH_OPTIONS);
  return dummyHash;
}
