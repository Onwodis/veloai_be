/**
 * Redis-backed rate limiters.
 *
 * Counters live in Redis so limits hold across every API replica. Limits are
 * keyed by client IP (resolved through `trust proxy`).
 */
import { rateLimit, type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';

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

/** Baseline for the whole API. */
export const globalLimiter = limiter('global', { windowMs: 60_000, limit: 300 });

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
