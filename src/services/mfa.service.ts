/**
 * Mandatory TOTP two-factor authentication and account recovery.
 *
 * Sign-in = password (auth.service) → challenge token → one of:
 *   - setup:    scan QR, confirm first code → 10 recovery codes + session
 *   - verify:   6-digit TOTP code → session
 *   - recover:  single-use recovery code → session
 *
 * Login difficulty:
 *   - Forgot password → emailed single-use link → new password (2FA still applies).
 *   - Lost authenticator AND recovery codes → after the password step, an
 *     emailed link removes 2FA and ends every session; the user enrols a new
 *     authenticator at the next sign-in. Password + inbox are both required.
 *
 * Hardening: challenges are single-use and allow 5 wrong codes; an accepted
 * TOTP step is remembered so the same code can't be replayed; recovery codes
 * and email tokens are stored only as SHA-256 hashes.
 */
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { AppError } from '../utils/AppError.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { hashPassword } from '../utils/password.js';
import { verifyChallengeToken, type ChallengeClaims } from '../utils/tokens.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../utils/totp.js';
import { issueSession, type AuthResult } from './auth.service.js';
import { sendMail } from './mail/mail.service.js';
import { mfaResetMail, passwordResetMail } from './mail/templates.js';
import { recordSecurityEvent, type RequestMeta } from './securityEvent.service.js';

const MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_SECONDS = 10 * 60;
const EMAIL_TOKEN_TTL_MS = 30 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const key = (...parts: string[]): string => `${env.APP_SLUG}:mfa:${parts.join(':')}`;

/* ------------------------------------------------------------------ challenge */

async function openChallenge(token: string, stage: ChallengeClaims['stage']): Promise<ChallengeClaims> {
  const claims = verifyChallengeToken(token);
  if (claims.stage !== stage) {
    throw new AppError(400, 'MFA_CHALLENGE_INVALID', 'This sign-in step is not available. Enter your password again.');
  }
  if (await redis.exists(key('used', claims.jti))) {
    throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'This sign-in attempt was already used. Enter your password again.');
  }
  return claims;
}

/** Counts a wrong code; burns the challenge after MAX_ATTEMPTS. */
async function failAttempt(claims: ChallengeClaims, meta: RequestMeta, message: string): Promise<never> {
  const attempts = await redis.incr(key('attempts', claims.jti));
  await redis.expire(key('attempts', claims.jti), CHALLENGE_TTL_SECONDS);
  await recordSecurityEvent('MFA_FAILED', meta, claims.sub, { attempts });
  if (attempts >= MAX_ATTEMPTS) {
    await redis.set(key('used', claims.jti), '1', 'EX', CHALLENGE_TTL_SECONDS);
    throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'Too many wrong codes. Enter your password again.');
  }
  throw new AppError(401, 'MFA_CODE_INVALID', `${message} ${MAX_ATTEMPTS - attempts} attempt(s) left.`);
}

/** Marks a challenge used. SET NX makes concurrent completions lose cleanly. */
async function consumeChallenge(claims: ChallengeClaims): Promise<void> {
  const claimed = await redis.set(key('used', claims.jti), '1', 'EX', CHALLENGE_TTL_SECONDS, 'NX');
  if (claimed !== 'OK') {
    throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'This sign-in attempt was already used. Enter your password again.');
  }
}

/* ------------------------------------------------------------------ recovery codes */

/** 10 symbols from a 32-symbol alphabet (50 bits); byte % 32 is unbiased. */
function newRecoveryCode(): string {
  const out = Array.from(randomBytes(10), (byte) => RECOVERY_ALPHABET[byte % 32]).join('');
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

const normaliseCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: sha256(`${env.APP_SLUG}:${normaliseCode(code)}`) })),
    }),
  ]);
  return codes;
}

/* ------------------------------------------------------------------ enrolment */

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
  account: string;
  issuer: string;
}

export async function startSetup(challengeToken: string): Promise<MfaSetup> {
  const claims = await openChallenge(challengeToken, 'setup');
  const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { email: true, totpEnabledAt: true } });
  if (!user) throw AppError.notFound('User');
  if (user.totpEnabledAt) throw AppError.conflict('Two-factor authentication is already set up');

  // Reuse the pending secret so reloading the page shows the same QR code.
  const pendingKey = key('pending', claims.jti);
  const stored = await redis.get(pendingKey);
  const secret = stored ? decryptSecret(stored) : generateTotpSecret();
  if (!stored) await redis.set(pendingKey, encryptSecret(secret), 'EX', CHALLENGE_TTL_SECONDS);

  const url = otpauthUrl({ secret, account: user.email, issuer: env.APP_NAME });
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
  return { secret, otpauthUrl: url, qrDataUrl, account: user.email, issuer: env.APP_NAME };
}

export async function completeSetup(
  challengeToken: string,
  code: string,
  meta: RequestMeta,
): Promise<AuthResult & { recoveryCodes: string[] }> {
  const claims = await openChallenge(challengeToken, 'setup');
  const stored = await redis.get(key('pending', claims.jti));
  if (!stored) {
    throw new AppError(400, 'MFA_CHALLENGE_INVALID', 'Setup expired. Reload the page to get a new QR code.');
  }
  const secret = decryptSecret(stored);
  const step = verifyTotp(secret, code);
  if (step === null) return failAttempt(claims, meta, 'That code did not match.');

  await consumeChallenge(claims);
  await prisma.user.update({
    where: { id: claims.sub },
    data: { totpSecretEnc: encryptSecret(secret), totpEnabledAt: new Date(), totpLastStep: BigInt(step) },
  });
  await redis.del(key('pending', claims.jti));
  const recoveryCodes = await replaceRecoveryCodes(claims.sub);
  await recordSecurityEvent('MFA_ENROLLED', meta, claims.sub);

  return { ...(await issueSession(claims.sub, meta)), recoveryCodes };
}

/* ------------------------------------------------------------------ verification */

async function checkUserCode(userId: string, code: string): Promise<{ ok: boolean; step: number | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!user?.totpSecretEnc || !user.totpEnabledAt) {
    throw new AppError(400, 'MFA_CHALLENGE_INVALID', 'Two-factor authentication is not set up. Enter your password again.');
  }
  const step = verifyTotp(decryptSecret(user.totpSecretEnc), code);
  // Reject a code from a step already used (replay of an observed code).
  if (step === null || (user.totpLastStep !== null && BigInt(step) <= user.totpLastStep)) {
    return { ok: false, step: null };
  }
  const advanced = await prisma.user.updateMany({
    where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }] },
    data: { totpLastStep: BigInt(step) },
  });
  return { ok: advanced.count === 1, step };
}

export async function verifyCode(challengeToken: string, code: string, meta: RequestMeta): Promise<AuthResult> {
  const claims = await openChallenge(challengeToken, 'verify');
  const { ok } = await checkUserCode(claims.sub, code);
  if (!ok) return failAttempt(claims, meta, 'That code is wrong or was already used.');
  await consumeChallenge(claims);
  return issueSession(claims.sub, meta);
}

export async function useRecoveryCode(
  challengeToken: string,
  recoveryCode: string,
  meta: RequestMeta,
): Promise<AuthResult & { remainingRecoveryCodes: number }> {
  const claims = await openChallenge(challengeToken, 'verify');
  const codeHash = sha256(`${env.APP_SLUG}:${normaliseCode(recoveryCode)}`);
  const used = await prisma.recoveryCode.updateMany({
    where: { userId: claims.sub, codeHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (used.count !== 1) return failAttempt(claims, meta, 'That recovery code is not valid or was already used.');

  await consumeChallenge(claims);
  const remainingRecoveryCodes = await prisma.recoveryCode.count({ where: { userId: claims.sub, usedAt: null } });
  await recordSecurityEvent('MFA_RECOVERY_USED', meta, claims.sub, { remaining: remainingRecoveryCodes });
  return { ...(await issueSession(claims.sub, meta)), remainingRecoveryCodes };
}

/** Signed-in: replaces all recovery codes after a fresh TOTP check. */
export async function regenerateRecoveryCodes(userId: string, code: string, meta: RequestMeta): Promise<string[]> {
  const { ok } = await checkUserCode(userId, code);
  if (!ok) throw new AppError(400, 'MFA_CODE_INVALID', 'That code is wrong or was already used.');
  const codes = await replaceRecoveryCodes(userId);
  await recordSecurityEvent('RECOVERY_CODES_REGENERATED', meta, userId);
  return codes;
}

export async function recoveryCodeStatus(userId: string): Promise<{ remaining: number; total: number }> {
  const [remaining, total] = await Promise.all([
    prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
    prisma.recoveryCode.count({ where: { userId } }),
  ]);
  return { remaining, total };
}

/* ------------------------------------------------------------------ email links */

async function issueEmailToken(userId: string, purpose: 'PASSWORD_RESET' | 'MFA_RESET'): Promise<string> {
  const raw = randomToken(32);
  await prisma.$transaction([
    // Only the newest link of each kind works.
    prisma.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.authToken.create({
      data: { userId, purpose, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS) },
    }),
  ]);
  return raw;
}

async function consumeEmailToken(raw: string, purpose: 'PASSWORD_RESET' | 'MFA_RESET'): Promise<string> {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= new Date()) {
    throw AppError.badRequest('This link is invalid or has expired. Request a new one.');
  }
  const claimed = await prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) throw AppError.badRequest('This link was already used. Request a new one.');
  return row.userId;
}

async function endAllSessions(userId: string, reason: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Always resolves the same way, so it can't be used to discover accounts. */
export async function requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return;
  const token = await issueEmailToken(user.id, 'PASSWORD_RESET');
  await recordSecurityEvent('PASSWORD_RESET_REQUESTED', meta, user.id);
  try {
    await sendMail(email, passwordResetMail(`${env.WEB_APP_URL}/reset-password?token=${encodeURIComponent(token)}`));
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'password reset email could not be sent');
  }
}

export async function resetPassword(token: string, password: string, meta: RequestMeta): Promise<void> {
  const userId = await consumeEmailToken(token, 'PASSWORD_RESET');
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null },
  });
  await endAllSessions(userId, 'password_reset');
  await recordSecurityEvent('PASSWORD_RESET', meta, userId);
}

/** After the password step only: emails a link that removes 2FA. */
export async function requestMfaReset(challengeToken: string, meta: RequestMeta): Promise<{ sentTo: string }> {
  const claims = await openChallenge(challengeToken, 'verify');
  const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { email: true } });
  if (!user) throw AppError.notFound('User');
  const token = await issueEmailToken(claims.sub, 'MFA_RESET');
  await sendMail(user.email, mfaResetMail(`${env.WEB_APP_URL}/reset-2fa?token=${encodeURIComponent(token)}`));
  await recordSecurityEvent('MFA_RESET_REQUESTED', meta, claims.sub);
  const [name = '', domain = ''] = user.email.split('@');
  return { sentTo: `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}` };
}

export async function confirmMfaReset(token: string, meta: RequestMeta): Promise<void> {
  const userId = await consumeEmailToken(token, 'MFA_RESET');
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
  ]);
  await endAllSessions(userId, 'mfa_reset');
  await recordSecurityEvent('MFA_RESET', meta, userId);
}
