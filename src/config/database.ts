/**
 * PostgreSQL access through Prisma.
 *
 * One client per process; Prisma manages the connection pool internally
 * (size via `connection_limit` on DATABASE_URL).
 */
import { PrismaClient } from '@prisma/client';
import { env, isProduction } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Neon suspends idle computes; waking one can take longer than Prisma's
 * defaults (5 s to connect, 10 s waiting for a pooled connection). Give it
 * 20 s / 30 s unless the URL already sets them.
 */
function withConnectTimeout(url: string): string {
  const extra = [/[?&]connect_timeout=/.test(url) ? null : 'connect_timeout=20', /[?&]pool_timeout=/.test(url) ? null : 'pool_timeout=30'].filter(Boolean);
  if (extra.length === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${extra.join('&')}`;
}

export const prisma = new PrismaClient({
  datasourceUrl: withConnectTimeout(env.DATABASE_URL),
  // Interactive transactions make several round trips to Neon (us-east-2).
  // Prisma's defaults (2 s to start, 5 s to finish) expire on a slow link or a
  // waking compute and fail the job with "Transaction not found" (P2028).
  transactionOptions: { maxWait: 20_000, timeout: 45_000 },
  log: isProduction
    ? [{ emit: 'event', level: 'error' }]
    : [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
});

prisma.$on('error', (event) => {
  logger.error({ target: event.target }, `prisma: ${event.message}`);
});
prisma.$on('warn', (event) => {
  logger.warn({ target: event.target }, `prisma: ${event.message}`);
});

/** Connects at boot, retrying while a suspended Neon compute wakes up. */
export async function connectDatabase(): Promise<void> {
  await withDbRetry(() => prisma.$connect(), 6);
  logger.info('database connection ready');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Errors where the query never reached the server (Neon compute waking up,
 * pooler dropping an idle connection, pool exhausted), so re-running it can't
 * apply a write twice.
 */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P2024', 'P2028']);
// P2028 = an interactive transaction expired or was closed before commit, so it
// was rolled back; withDbRetry always wraps the whole transaction, never a
// statement inside one, so re-running it is safe.

export function isTransientDbError(error: unknown): boolean {
  const { code, errorCode } = (error ?? {}) as { code?: string; errorCode?: string };
  return TRANSIENT_CODES.has(code ?? errorCode ?? '');
}

/**
 * Runs a database call, retrying briefly (0.5 s, 1 s, 2 s, 4 s) when the
 * server was momentarily unreachable. Used by long-running jobs, where one
 * network blip shouldn't fail minutes of finished work.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientDbError(error) || attempt >= attempts) throw error;
      const delay = 500 * 2 ** (attempt - 1);
      logger.warn({ attempt, delay }, 'database unreachable, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Round-trips `SELECT 1`; used by the readiness probe. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
