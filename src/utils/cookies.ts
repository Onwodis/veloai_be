/**
 * Refresh-token cookie handling.
 *
 * HttpOnly (no JS access), Secure, SameSite=Strict, and scoped to the auth
 * routes so the token is not sent with any other API call.
 */
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env.js';

export const REFRESH_COOKIE = `${env.APP_SLUG.replace(/-/g, '_')}_rt`;
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
}

export function readRefreshCookie(req: Request): string | undefined {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value = (cookies as Record<string, unknown>)[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 && value.length < 4096 ? value : undefined;
}
