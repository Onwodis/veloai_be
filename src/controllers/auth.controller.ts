/**
 * Auth HTTP handlers. Validation has already run; these translate between
 * HTTP and the auth service and own the refresh-cookie lifecycle.
 *
 * The access token is returned in the JSON body (the client keeps it in
 * memory only). The refresh token is only ever set as an HttpOnly cookie.
 */
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate.js';
import { validBody, validParams } from '../middleware/validate.js';
import {
  emailTokenSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaChallengeSchema,
  mfaCodeSchema,
  mfaRecoverySchema,
  regenerateCodesSchema,
  registerSchema,
  resetPasswordSchema,
  sessionParamsSchema,
} from '../models/auth.schemas.js';
import type { PublicUser } from '../models/user.model.js';
import * as authService from '../services/auth.service.js';
import * as mfa from '../services/mfa.service.js';
import type { AuthResult } from '../services/auth.service.js';
import { AppError } from '../utils/AppError.js';
import { clearRefreshCookie, readRefreshCookie, setAccessCookie, setRefreshCookie } from '../utils/cookies.js';
import { requestMeta } from '../utils/request.js';

interface SessionResponse {
  user: PublicUser;
  accessToken: string;
  accessTokenExpiresAt: string;
  sessionId: string;
}

function sendSession(res: Response, result: AuthResult, status = 200, extra: Record<string, unknown> = {}): void {
  setRefreshCookie(res, result.tokens.refreshToken, result.tokens.refreshTokenExpiresAt);
  // The Next.js server loads pages with it (same origin, over the docker network).
  setAccessCookie(res, result.tokens.accessToken, result.tokens.accessTokenExpiresAt);
  res.setHeader('Cache-Control', 'no-store');
  const body: SessionResponse = {
    user: result.user,
    accessToken: result.tokens.accessToken,
    accessTokenExpiresAt: result.tokens.accessTokenExpiresAt.toISOString(),
    sessionId: result.tokens.sessionId,
  };
  res.status(status).json({ ...body, ...extra });
}

/** Password step: always answers with a 2FA challenge, never a session. */
export async function register(req: Request, res: Response): Promise<void> {
  const input = validBody(req, registerSchema);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(await authService.register(input, requestMeta(req)));
}

export async function login(req: Request, res: Response): Promise<void> {
  const input = validBody(req, loginSchema);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await authService.login(input, requestMeta(req)));
}

/* ------------------------------------------------------------------ 2FA */

export async function mfaSetup(req: Request, res: Response): Promise<void> {
  const { challengeToken } = validBody(req, mfaChallengeSchema);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await mfa.startSetup(challengeToken));
}

export async function mfaEnroll(req: Request, res: Response): Promise<void> {
  const { challengeToken, code } = validBody(req, mfaCodeSchema);
  const result = await mfa.completeSetup(challengeToken, code, requestMeta(req));
  sendSession(res, result, 200, { recoveryCodes: result.recoveryCodes });
}

export async function mfaVerify(req: Request, res: Response): Promise<void> {
  const { challengeToken, code } = validBody(req, mfaCodeSchema);
  sendSession(res, await mfa.verifyCode(challengeToken, code, requestMeta(req)));
}

export async function mfaRecover(req: Request, res: Response): Promise<void> {
  const { challengeToken, recoveryCode } = validBody(req, mfaRecoverySchema);
  const result = await mfa.useRecoveryCode(challengeToken, recoveryCode, requestMeta(req));
  sendSession(res, result, 200, { remainingRecoveryCodes: result.remainingRecoveryCodes });
}

export async function mfaResetRequest(req: Request, res: Response): Promise<void> {
  const { challengeToken } = validBody(req, mfaChallengeSchema);
  res.json(await mfa.requestMfaReset(challengeToken, requestMeta(req)));
}

export async function mfaResetConfirm(req: Request, res: Response): Promise<void> {
  const { token } = validBody(req, emailTokenSchema);
  await mfa.confirmMfaReset(token, requestMeta(req));
  res.status(204).end();
}

export async function recoveryCodes(req: Request, res: Response): Promise<void> {
  res.json(await mfa.recoveryCodeStatus(requireAuth(req).userId));
}

export async function regenerateRecoveryCodes(req: Request, res: Response): Promise<void> {
  const { code } = validBody(req, regenerateCodesSchema);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ recoveryCodes: await mfa.regenerateRecoveryCodes(requireAuth(req).userId, code, requestMeta(req)) });
}

/* ------------------------------------------------------------------ password reset */

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = validBody(req, forgotPasswordSchema);
  await mfa.requestPasswordReset(email, requestMeta(req));
  // Same answer whether or not the account exists.
  res.status(202).json({ ok: true });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { token, password } = validBody(req, resetPasswordSchema);
  await mfa.resetPassword(token, password, requestMeta(req));
  res.status(204).end();
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = readRefreshCookie(req);
  if (!token) {
    throw AppError.unauthenticated('No active session');
  }
  try {
    sendSession(res, await authService.refresh(token, requestMeta(req)));
  } catch (error) {
    // Any refresh failure means the cookie is useless; drop it.
    clearRefreshCookie(res);
    throw error;
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(
    readRefreshCookie(req),
    req.auth ? { userId: req.auth.userId, sessionId: req.auth.sessionId } : undefined,
    requestMeta(req),
  );
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  res.json({ user: await authService.getPublicUserOrThrow(auth.userId) });
}

export async function listSessions(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  res.json({ sessions: await authService.listSessions(auth.userId, auth.sessionId) });
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { sessionId } = validParams(res, sessionParamsSchema);
  await authService.revokeSession(auth.userId, sessionId, requestMeta(req));
  if (sessionId === auth.sessionId) {
    clearRefreshCookie(res);
  }
  res.status(204).end();
}

export async function revokeOtherSessions(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const revoked = await authService.revokeAllSessions(auth.userId, requestMeta(req), auth.sessionId);
  res.json({ revoked });
}
