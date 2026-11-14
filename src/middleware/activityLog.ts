/**
 * CRUD audit trail.
 *
 * Every /api/v1 request is mapped to a CRUD action by HTTP method
 * (POST→CREATE, GET→READ, PUT/PATCH→UPDATE, DELETE→DELETE) and written to
 * `activity_logs` once the response has finished, so logging never delays
 * the response. Noise that would drown the log is skipped: token refresh,
 * visit beacons, and the log viewer reading itself.
 */
import type { ActivityAction } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/database.js';
import { logger } from '../utils/logger.js';

const ACTION_BY_METHOD: Record<string, ActivityAction> = {
  POST: 'CREATE',
  GET: 'READ',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
};

const SKIP = [/^\/api\/v1\/auth\/refresh$/, /^\/api\/v1\/analytics\/visit$/, /^\/api\/v1\/admin\/logs/];

export function activityLog(req: Request, res: Response, next: NextFunction): void {
  const action = ACTION_BY_METHOD[req.method];
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
  if (!action || SKIP.some((pattern) => pattern.test(path))) {
    next();
    return;
  }

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const routePath = (req.route as { path?: string } | undefined)?.path;
    const userAgent = req.get('user-agent');
    prisma.activityLog
      .create({
        data: {
          userId: req.auth?.userId ?? null,
          action,
          method: req.method,
          path: path.slice(0, 512),
          route: routePath ? `${req.baseUrl}${routePath}`.slice(0, 255) : null,
          statusCode: res.statusCode,
          durationMs,
          ipAddress: req.ip ?? null,
          userAgent: userAgent ? userAgent.slice(0, 512) : null,
          requestId: String(req.id).slice(0, 64),
        },
      })
      .catch((error: unknown) => logger.error({ err: error }, 'activity log write failed'));
  });
  next();
}
