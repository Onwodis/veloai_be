/**
 * Centralised error handling.
 *
 * Every response error has the same shape:
 *   { "error": { "code": "...", "message": "...", "details"?: ..., "requestId": "..." } }
 *
 * Unexpected errors are logged with full stack and request id, and answered
 * with a generic message. Stack traces never reach the client in production.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env.js';
import { Prisma } from '@prisma/client';
import { isTransientDbError } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { hideEngine } from '../utils/engineName.js';
import { logger } from '../utils/logger.js';

/** Prisma codes meaning "cannot reach / lost the database", not a bad query. */
const DB_DOWN_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

/**
 * What to log for a server error. Production keeps the full error object;
 * development gets one readable line (Prisma messages run to dozens of lines)
 * plus the first stack frame from our own code.
 */
function logPayload(error: unknown): Record<string, unknown> {
  if (isProduction || !(error instanceof Error)) return { err: error };
  const code = (error as { code?: unknown }).code;
  const message = error.message.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? error.message;
  const where = error.stack?.split('\n').find((line) => line.includes('\\src\\') || line.includes('/src/'))?.trim().replace(/^at /, '');
  return { error: `${error.name}${typeof code === 'string' ? ` ${code}` : ''}: ${message}`, ...(where ? { at: where } : {}) };
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
    stack?: string;
  };
}

function toAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError(
      400,
      'VALIDATION_FAILED',
      'Request validation failed',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return AppError.conflict('A record with these details already exists');
    if (error.code === 'P2025') return AppError.notFound();
    if (DB_DOWN_CODES.has(error.code)) return new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is not reachable right now. Try again shortly.');
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is not reachable right now. Try again shortly.');
  }
  // Direct-SQL (postgres.js) connection failures: the statement never ran, so
  // this is "try again", not a bug. Answered 503 (retryable), not 500.
  if (isTransientDbError(error)) {
    return new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is not reachable right now. Try again shortly.');
  }

  // body-parser errors (malformed JSON, oversized payload) carry `status` and `type`.
  if (typeof error === 'object' && error !== null && 'type' in error && 'status' in error) {
    const { type, status } = error as { type: unknown; status: unknown };
    if (type === 'entity.parse.failed') return AppError.badRequest('Malformed JSON body');
    if (type === 'entity.too.large') return new AppError(413, 'BAD_REQUEST', 'Payload too large');
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return AppError.badRequest('Bad request');
    }
  }

  return null;
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = String(req.id);
  const known = toAppError(error);

  if (known) {
    if (known.statusCode >= 500) {
      logger.error({ ...logPayload(error), requestId }, known.message);
    }
    const body: ErrorBody = {
      // Users never see provider / model names (utils/engineName.ts).
      error: { code: known.code, message: hideEngine(known.message), requestId },
    };
    if (known.details !== undefined) body.error.details = known.details;
    // Locks and limits say when to come back (RFC 9110 Retry-After, seconds).
    const retry = (known.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    if ((known.statusCode === 423 || known.statusCode === 429) && typeof retry === 'number') res.setHeader('Retry-After', String(retry));
    res.status(known.statusCode).json(body);
    return;
  }

  logger.error({ ...logPayload(error), requestId, method: req.method, path: req.path }, 'unhandled error');

  const body: ErrorBody = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side', requestId },
  };
  if (!isProduction && error instanceof Error && error.stack) {
    body.error.stack = error.stack;
  }
  res.status(500).json(body);
}
