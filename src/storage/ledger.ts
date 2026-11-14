/**
 * Storage ledger: one `storage_objects` row per stored file.
 *
 * Writes go through storage.service (uploadFile / uploadBuffer / deletes),
 * so every R2 object is counted. The database resolves the owner from the
 * key, keeps per-user totals with triggers, and rejects user uploads over the
 * quota (error STORAGE_QUOTA_EXCEEDED, see migration 002).
 *
 * These run as the table owner (system context). Ledger failures on
 * generated files are logged, not thrown: a finished render is never lost
 * because bookkeeping blipped (storage:backfill reconciles).
 */
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { sql, withSqlRetry } from '../studio/sql.js';

export type ObjectKind = 'UPLOAD' | 'GENERATED';

/** Keys under system/ (model weights, temp files) are platform-owned and not counted. */
const counted = (key: string): boolean => !key.startsWith('system/') && !key.startsWith('_');

export function isQuotaError(error: unknown): boolean {
  return (error as { message?: string }).message === 'STORAGE_QUOTA_EXCEEDED';
}

export function quotaError(detail?: string): AppError {
  return new AppError(402, 'STORAGE_FULL', 'Your storage is full. Download your files to a backup drive and delete them here, or buy more storage, then try again.', detail ? { detail } : undefined);
}

/** Records a generated file (soft: never throws). */
export async function track(key: string, bytes: number, kind: ObjectKind = 'GENERATED'): Promise<void> {
  if (!counted(key)) return;
  try {
    await withSqlRetry(
      () => sql`
        INSERT INTO storage_objects (key, bytes, kind) VALUES (${key}, ${Math.max(0, Math.round(bytes))}, ${kind})
        ON CONFLICT (key) DO UPDATE SET bytes = EXCLUDED.bytes, kind = EXCLUDED.kind`,
    );
  } catch (error) {
    if (kind === 'UPLOAD' && isQuotaError(error)) throw error;
    logger.warn({ err: error, key }, 'storage ledger write failed (non-fatal)');
  }
}

/**
 * Records a file the user uploaded (presigned PUT / multipart). The database
 * refuses it when it would exceed the user's quota: the caller then deletes
 * the object and gets a 402 STORAGE_FULL.
 */
export async function trackUpload(key: string, bytes: number, remove: () => Promise<void>): Promise<void> {
  try {
    await track(key, bytes, 'UPLOAD');
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await remove().catch(() => undefined);
    throw quotaError((error as { detail?: string }).detail);
  }
}

export async function untrack(key: string): Promise<void> {
  await withSqlRetry(() => sql`DELETE FROM storage_objects WHERE key = ${key}`).catch((error: unknown) => logger.warn({ err: error, key }, 'storage ledger delete failed'));
}

export async function untrackPrefix(prefix: string): Promise<void> {
  const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  await withSqlRetry(() => sql`DELETE FROM storage_objects WHERE key LIKE ${pattern}`).catch((error: unknown) => logger.warn({ err: error, prefix }, 'storage ledger delete failed'));
}
