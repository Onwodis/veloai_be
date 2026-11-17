/**
 * HTTP hardening: security headers, CORS, and CSRF defence for cookie routes.
 */
import cors from 'cors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/**
 * This service only ever returns JSON, so the CSP forbids everything: no
 * scripts, frames, or embedding of API responses anywhere.
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-site' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
});

const allowedOrigins = new Set(env.CORS_ORIGINS);

/** Custom header the web client sends on cookie-authenticated requests. */
export const CSRF_HEADER = 'X-App-Client';

/** Credentialed CORS for an exact allow-list. Unknown origins get no CORS headers. */
export const corsPolicy: RequestHandler = cors({
  origin: (origin, callback) => {
    // Same-origin and server-to-server requests send no Origin header.
    callback(null, origin === undefined || allowedOrigins.has(origin));
  },
  credentials: true,
  // PUT was missing: the browser's preflight blocked every PUT (avatar upload,
  // credential saves, upload relay).
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
  // ETag: multipart uploads through the relay read each part's ETag.
  exposedHeaders: ['RateLimit', 'RateLimit-Policy', 'Retry-After', 'ETag'],
  // Preflights are cached for 2 h (the most Chromium honours) so cross-origin
  // callers (api.<domain>) pay one OPTIONS round trip, not one per request.
  maxAge: 7200,
});

/**
 * Cookie-authenticated endpoints (refresh, logout) require a custom header and
 * an allow-listed Origin. A cross-site form or `<img>` can't set custom
 * headers, and a cross-site `fetch` that does is stopped by the CORS
 * preflight; this layers on top of `SameSite=Strict`.
 */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (req.get(CSRF_HEADER) !== 'web' || (origin !== undefined && !allowedOrigins.has(origin))) {
    throw new AppError(403, 'CSRF_REJECTED', 'Request rejected');
  }
  next();
}
