/**
 * Redis-backed rate limiters.
 *
 * Counters live in Redis so limits hold across every API replica. Limits are
 * keyed by client IP (resolved through `trust proxy`).
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { rateLimit, type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { verifyAccessToken } from '../utils/tokens.js';

function store(prefix: string): RedisStore {
  return new RedisStore({
    prefix: `${env.APP_SLUG}:rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
  });
}

function limiter(prefix: string, options: Partial<Options>): RateLimitRequestHandler {
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: store(prefix),
    // RateLimit / RateLimit-Policy (IETF draft 8) on every response; Retry-After on a 429.
    handler: (_req, res, _next, opts) => {
      res.status(opts.statusCode).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down and try again shortly.',
        },
      });
    },
    ...options,
  });
}

/** Baseline for the whole API (per IP; the edge proxy applies its own per-IP limit first). */
export const globalLimiter = limiter('global', { windowMs: 60_000, limit: 300 });

/** The signed-in user behind a request (a valid access token), or null. */
function userKey(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  if (!match?.[1]) return null;
  try {
    return `u:${verifyAccessToken(match[1]).sub}`;
  } catch {
    return null;
  }
}

/**
 * Per user, across all their IPs and devices (a token can't buy more by switching networks).
 * Anonymous requests are left to the per-IP limits.
 */
export const userLimiter = limiter('user', {
  windowMs: 60_000,
  limit: 300,
  skip: (req) => userKey(req) === null,
  keyGenerator: (req) => userKey(req) ?? 'anonymous',
});

/**
 * Sign-in attempts per email address, whatever the IP (stops a spread-out attack on one
 * account). Keyed by a hash so addresses are not stored in Redis; unknown emails count the same.
 */
export const loginAccountLimiter = limiter('login-account', {
  windowMs: 60 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof (req.body as { email?: unknown } | undefined)?.email === 'string' ? (req.body as { email: string }).email : '';
    return `e:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
  },
});

/** Credential endpoints: 10 attempts per 15 minutes per IP. Successful logins don't count. */
export const loginLimiter = limiter('login', {
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
});

/** Account creation: 5 per hour per IP. */
export const registerLimiter = limiter('register', { windowMs: 60 * 60_000, limit: 5 });

/** 2FA codes: 30 tries / 15 min per IP, on top of 5 per challenge. */
export const mfaLimiter = limiter('mfa', { windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true });

/** Emailed recovery links: 5 per hour per IP (stops inbox flooding). */
export const recoveryLimiter = limiter('recovery', { windowMs: 60 * 60_000, limit: 5 });

/** Visit beacons: one per page load is plenty. */
export const visitLimiter = limiter('visit', { windowMs: 60_000, limit: 60 });

/** Token refresh: generous for many tabs, tight enough to stop token grinding. */
export const refreshLimiter = limiter('refresh', { windowMs: 15 * 60_000, limit: 60 });

/** Identity documents and data requests: rare actions, tight limits. */
export const kycLimiter = limiter('kyc', { windowMs: 60 * 60_000, limit: 30 });
export const dataRequestLimiter = limiter('data-request', { windowMs: 24 * 60 * 60_000, limit: 10 });
export const exportLimiter = limiter('data-export', { windowMs: 60 * 60_000, limit: 5 });
