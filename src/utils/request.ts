/**
 * Extracts client metadata recorded with sessions and audit events.
 */
import type { Request } from 'express';
import type { RequestMeta } from '../services/securityEvent.service.js';

export function requestMeta(req: Request): RequestMeta {
  const userAgent = req.get('user-agent');
  return {
    // `req.ip` honours the `trust proxy` hop count configured in app.ts.
    ipAddress: req.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
  };
}
