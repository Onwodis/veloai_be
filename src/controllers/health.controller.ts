/**
 * Liveness and readiness probes for the orchestrator.
 */
import type { Request, Response } from 'express';
import { pingDatabase } from '../config/database.js';
import { pingRedis } from '../config/redis.js';

/** Process is up and the event loop is responsive. */
export function live(_req: Request, res: Response): void {
  res.json({ status: 'ok' });
}

/** Process can serve traffic: every dependency answers. */
export async function ready(_req: Request, res: Response): Promise<void> {
  const [database, cache] = await Promise.all([pingDatabase(), pingRedis()]);
  const healthy = database && cache;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks: { database: database ? 'ok' : 'down', redis: cache ? 'ok' : 'down' },
  });
}
