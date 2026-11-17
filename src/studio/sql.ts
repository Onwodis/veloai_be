/**
 * Direct PostgreSQL (Neon) access for the AI video studio, without Prisma.
 *
 * `sql` uses DATABASE_URL (the Neon pooler, fine for app queries; prepared
 * statements are off because PgBouncer in transaction mode can't keep them).
 * Schema changes run over the direct, non-pooled host: see `migrate()`.
 */
// Scripts reach the database through this module: apply the connect settings here too.
import '../config/network.js';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  // Keep connections warm for 4 minutes: a fresh TLS connection to Neon costs several
  // round trips (seconds on a slow link), and with 30 s most requests paid for one.
  idle_timeout: 240,
  // A suspended Neon compute can take a while to wake.
  connect_timeout: 30,
  prepare: false,
  // snake_case columns ⇄ camelCase rows (also applies to sql(object) inserts).
  transform: { ...postgres.camel, undefined: null },
  onnotice: () => undefined,
});

export type Sql = typeof sql;
export type Tx = postgres.TransactionSql;

/** JSON parameter helper (postgres.js wants an explicit JSON value). */
export const json = (value: unknown): postgres.Parameter => sql.json(value as postgres.JSONValue);

/** Connection errors where the statement never ran, so a retry can't apply it twice. */
const TRANSIENT = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', '57P01', '08006', '08001']);

/**
 * True when the database could not be reached (the statement never ran).
 * Node reports a failed multi-address connect as an AggregateError whose own
 * code may be missing, with the real codes on its inner errors.
 */
export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT.has(code)) return true;
  const inner = (error as { errors?: unknown }).errors;
  return Array.isArray(inner) && inner.some((item) => isTransientDbError(item));
}

/** Retries a query through momentary Neon outages (0.5 s, 1 s, 2 s, 4 s). */
export async function withSqlRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'AGGREGATE';
      if (!isTransientDbError(error) || attempt >= attempts) throw error;
      const delay = 500 * 2 ** (attempt - 1);
      logger.warn({ attempt, delay, code }, 'studio database unreachable, retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Neon's direct host is the pooler host without `-pooler`. */
export function directUrl(): string {
  return env.DIRECT_DATABASE_URL ?? env.DATABASE_URL.replace(/-pooler(?=[.-])/, '');
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies `migrations/*.sql` in name order, each once, inside a transaction,
 * recording them in `studio_migrations`. Safe to run on every deploy.
 */
export async function migrate(): Promise<string[]> {
  const db = postgres(directUrl(), { max: 1, connect_timeout: 30, onnotice: () => undefined });
  try {
    await db`CREATE TABLE IF NOT EXISTS studio_migrations (name varchar(200) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await db<{ name: string }[]>`SELECT name FROM studio_migrations`).map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await db.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO studio_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }
    return applied;
  } finally {
    await db.end({ timeout: 5 });
  }
}

export async function closeSql(): Promise<void> {
  await sql.end({ timeout: 5 });
}
