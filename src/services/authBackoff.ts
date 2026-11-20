/**
 * Backoff and escalating lockout for credential checks (password and 2FA).
 *
 *   delay      every wrong attempt answers a little slower (250 ms, 500 ms, 1 s … up to 4 s), per
 *              email address, whether or not the account exists (no enumeration by timing)
 *   lockout    the account's own threshold (LOGIN_MAX_FAILED_ATTEMPTS) locks it for
 *              LOGIN_LOCKOUT_SECONDS, doubling with each lock in the same 24 h (15 min, 30 min,
 *              1 h … capped at 24 h). A successful sign-in clears the escalation.
 *   2FA        wrong codes count per user across sign-in attempts too (a new password step gives a
 *              fresh challenge, not fresh guesses): MFA_MAX_FAILURES in 15 min locks the account.
 * Counters live in Redis so they hold across API replicas.
 */
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { env } from '../config/env.js';
import { prisma } from '../config/database.js';
import { redis } from '../config/redis.js';

const WINDOW_SECONDS = 15 * 60;
const STRIKE_SECONDS = 24 * 60 * 60;
const MAX_LOCK_SECONDS = 24 * 60 * 60;
/** Wrong 2FA codes per user (across challenges) before the account locks. */
export const MFA_MAX_FAILURES = 10;

const key = (...parts: string[]): string => `${env.APP_SLUG}:auth:${parts.join(':')}`;
const emailKey = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);

/** Exponential delay for the nth failure in the window (n ≥ 1). */
export const backoffMs = (failures: number): number => Math.min(4000, 250 * 2 ** Math.max(0, failures - 1));

/** Counts a failed password attempt for this email and waits out its backoff. */
export async function failedPasswordDelay(email: string): Promise<void> {
  const counter = key('pw-fails', emailKey(email));
  const failures = await redis.incr(counter);
  if (failures === 1) await redis.expire(counter, WINDOW_SECONDS);
  await sleep(backoffMs(failures));
}

/** A correct password clears the email's backoff (not the 2FA count: the password alone isn't a sign-in). */
export async function clearBackoff(email: string): Promise<void> {
  await redis.del(key('pw-fails', emailKey(email)));
}

/** A completed sign-in (second factor passed) clears the 2FA count and the lock escalation. */
export async function clearSignInFailures(userId: string): Promise<void> {
  await redis.del(key('strikes', userId), key('mfa-fails', userId));
}

/** Locks the account, longer for each lock in the last 24 h. Returns when it opens again. */
export async function lockAccount(userId: string): Promise<Date> {
  const counter = key('strikes', userId);
  const strikes = await redis.incr(counter);
  await redis.expire(counter, STRIKE_SECONDS);
  const seconds = Math.min(MAX_LOCK_SECONDS, env.LOGIN_LOCKOUT_SECONDS * 2 ** (strikes - 1));
  const until = new Date(Date.now() + seconds * 1000);
  await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: until } });
  return until;
}

/** Counts a wrong 2FA code for the user; true when the account has just been locked for it. */
export async function failedMfa(userId: string): Promise<{ locked: Date | null }> {
  const counter = key('mfa-fails', userId);
  const failures = await redis.incr(counter);
  if (failures === 1) await redis.expire(counter, WINDOW_SECONDS);
  await sleep(backoffMs(failures));
  if (failures < MFA_MAX_FAILURES) return { locked: null };
  await redis.del(counter);
  return { locked: await lockAccount(userId) };
}

/** Seconds until a date (for Retry-After), at least 1. */
export const secondsUntil = (date: Date): number => Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
