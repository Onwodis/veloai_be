/**
 * Bearer access-token authentication.
 *
 * On success `req.auth` holds the verified identity. Handlers behind this
 * middleware can read `req.auth` through `requireAuth(req)` without a null
 * check.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../models/user.model.js';
import { AppError } from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/tokens.js';

export interface AuthContext {
  userId: string;
  role: Role;
  /** The refresh-token family (session) this access token was minted for. */
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/;

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get('authorization');
  if (!header) {
    throw AppError.unauthenticated();
  }
  const match = BEARER.exec(header);
  if (!match?.[1]) {
    throw new AppError(401, 'TOKEN_INVALID', 'Malformed Authorization header');
  }
  const claims = verifyAccessToken(match[1]);
  req.auth = { userId: claims.sub, role: claims.role, sessionId: claims.sid };
  next();
}

/** Like `authenticate`, but anonymous requests (or bad tokens) pass through. */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const match = BEARER.exec(req.get('authorization') ?? '');
  if (match?.[1]) {
    try {
      const claims = verifyAccessToken(match[1]);
      req.auth = { userId: claims.sub, role: claims.role, sessionId: claims.sid };
    } catch {
      // Treat as anonymous.
    }
  }
  next();
}

/** Narrowing accessor for handlers mounted behind `authenticate`. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw AppError.unauthenticated();
  }
  return req.auth;
}
