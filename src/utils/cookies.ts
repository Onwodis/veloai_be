/**
 * Session cookies.
 *
 *   refresh  HttpOnly, Secure, SameSite=Strict, scoped to the auth routes so
 *            the token is not sent with any other API call.
 *   access   the short-lived access token (same lifetime as the JWT), HttpOnly,
 *            Secure, SameSite=Strict, for the whole site: only the Next.js
 *            server reads it, to load pages server-side over the docker network
 *            (it sends it on as a Bearer header). The API itself never reads it
 *            (Bearer header only), so it adds no CSRF surface.
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

/** Clears the whole session: the refresh cookie and the server-side access cookie. */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
  res.clearCookie(ACCESS_COOKIE, accessOptions());
}

export const ACCESS_COOKIE = `${env.APP_SLUG.replace(/-/g, '_')}_at`;

function accessOptions(): CookieOptions {
  return { ...baseOptions(), path: '/' };
}

export function setAccessCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(ACCESS_COOKIE, token, { ...accessOptions(), expires: expiresAt });
}

export function readRefreshCookie(req: Request): string | undefined {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value = (cookies as Record<string, unknown>)[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 && value.length < 4096 ? value : undefined;
}
