/**
 * Authentication business logic.
 *
 * Session model
 * -------------
 * A "session" is a refresh-token *family*: every login starts a new family,
 * and every refresh replaces the family's current token with a successor
 * (rotation). A token that has already been rotated must never be presented
 * again; if it is, someone holds a copy they should not have, so the whole
 * family is revoked and both the attacker and the victim are signed out of
 * that session (OAuth 2.0 Security BCP Â§4.14 reuse detection).
 */
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import type { Prisma } from '@prisma/client';
import type { LoginInput, RegisterInput } from '../models/auth.schemas.js';
import { publicUserSelect, toPublicUser, type PublicUser, type Role } from '../models/user.model.js';
import { AppError } from '../utils/AppError.js';
import { newId, safeEqual, sha256 } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { getDummyHash, hashPassword, passwordNeedsRehash, verifyPassword } from '../utils/password.js';
import { signAccessToken, signChallengeToken, signRefreshToken, verifyRefreshToken } from '../utils/tokens.js';
import { recordSecurityEvent, type RequestMeta } from './securityEvent.service.js';
import { recordSignupConsents } from '../privacy/service.js';
import { consumeSignupCode, markVerifiedAtSignup } from './emailVerification.service.js';
import { notifyNewUser } from './newUserAlert.js';
import { sql } from '../studio/sql.js';
import { clearBackoff, failedPasswordDelay, lockAccount, secondsUntil } from './authBackoff.js';

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: SessionTokens;
}

export interface SessionSummary {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastActiveAt: string;
  expiresAt: string;
  current: boolean;
}

type Tx = Prisma.TransactionClient;

/** Creates the refresh row and signs both tokens for a session family. */
async function issueTokens(
  db: Tx,
  user: { id: string; role: Role },
  familyId: string,
  meta: RequestMeta,
): Promise<SessionTokens & { refreshTokenId: string }> {
  const tokenId = newId();
  const refreshToken = signRefreshToken({ userId: user.id, tokenId, familyId });
  const refreshTokenExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

  await db.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: refreshTokenExpiresAt,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ipAddress: meta.ipAddress,
    },
  });

  const access = signAccessToken({ userId: user.id, role: user.role, sessionId: familyId });
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    sessionId: familyId,
    refreshTokenId: tokenId,
  };
}

function stripInternal(issued: SessionTokens & { refreshTokenId: string }): SessionTokens {
  const { refreshTokenId: _omit, ...tokens } = issued;
  return tokens;
}

async function revokeFamily(familyId: string, reason: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

function workspaceSlug(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base.length > 0 ? base : 'studio'}-${newId().slice(0, 8)}`;
}

/**
 * Result of the password step. Two-factor is mandatory, so a correct
 * password never yields a session directly: the client gets a short-lived
 * challenge to complete with TOTP enrolment (`MFA_SETUP_REQUIRED`) or a
 * TOTP / recovery code (`MFA_REQUIRED`).
 */
export interface MfaChallenge {
  status: 'MFA_SETUP_REQUIRED' | 'MFA_REQUIRED';
  challengeToken: string;
  challengeExpiresAt: string;
  email: string;
}

function challengeFor(user: { id: string; email: string; totpEnabledAt: Date | null }): MfaChallenge {
  const stage = user.totpEnabledAt ? 'verify' : 'setup';
  const challenge = signChallengeToken(user.id, stage);
  return {
    status: stage === 'setup' ? 'MFA_SETUP_REQUIRED' : 'MFA_REQUIRED',
    challengeToken: challenge.token,
    challengeExpiresAt: challenge.expiresAt.toISOString(),
    email: user.email,
  };
}

/** Starts a session after the second factor has been verified. */
export async function issueSession(userId: string, meta: RequestMeta): Promise<AuthResult> {
  const tokens = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
      select: { id: true, role: true },
    });
    return stripInternal(await issueTokens(tx, user, newId(), meta));
  });
  await recordSecurityEvent('LOGIN_SUCCEEDED', meta, userId, { sessionId: tokens.sessionId, mfa: true });
  return { user: await getPublicUserOrThrow(userId), tokens };
}

export async function register(input: RegisterInput, meta: RequestMeta): Promise<MfaChallenge> {
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) {
    throw AppError.conflict('An account with this email already exists');
  }
  // The emailed code proves the address before anything is created.
  await consumeSignupCode(input.email, input.emailCode);

  const passwordHash = await hashPassword(input.password);
  const displayName = `${input.firstName} ${input.lastName}`.slice(0, 80);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      displayName,
      role: input.role,
      gender: input.gender,
      dateOfBirth: input.dateOfBirth,
      memberships: {
        create: {
          role: 'OWNER',
          workspace: {
            create: { name: `${input.firstName}'s Studio`, slug: workspaceSlug(displayName) },
          },
        },
      },
    },
    select: { id: true, email: true, totpEnabledAt: true },
  });

  // Consent is part of creating the account: if it cannot be recorded, the
  // account is removed again rather than left without a lawful record.
  try {
    await recordSignupConsents(user.id, input.consents, meta);
  } catch (error) {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    throw error;
  }
  await sql`UPDATE users SET first_name = ${input.firstName}, last_name = ${input.lastName} WHERE id = ${user.id}`.catch((error: unknown) => logger.warn({ err: error, userId: user.id }, 'first/last name not saved'));
  await recordSecurityEvent('REGISTERED', meta, user.id);
  // The address was proven by the code: verified now (no free tokens); the super admins hear about it.
  await markVerifiedAtSignup(user.id);
  void notifyNewUser({ id: user.id, name: displayName, email: input.email, role: input.role });
  return challengeFor(user);
}

export async function login(input: LoginInput, meta: RequestMeta): Promise<MfaChallenge> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, email: true, role: true, passwordHash: true, lockedUntil: true, totpEnabledAt: true },
  });

  if (!user) {
    // Burn the same argon2 cost as a real check so timing reveals nothing, then the same backoff.
    await verifyPassword(await getDummyHash(), input.password);
    await recordSecurityEvent('LOGIN_FAILED', meta, null, { reason: 'unknown_email' });
    await failedPasswordDelay(input.email);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(
      423,
      'ACCOUNT_LOCKED',
      'Too many failed sign-in attempts. Try again later.',
      { retryAfter: user.lockedUntil.toISOString(), retryAfterSeconds: secondsUntil(user.lockedUntil) },
    );
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    await recordSecurityEvent('LOGIN_FAILED', meta, user.id, { reason: 'bad_password' });

    // Escalating lock: each lock in the same 24 h lasts twice as long as the last.
    if (updated.failedLoginCount >= env.LOGIN_MAX_FAILED_ATTEMPTS) {
      await lockAccount(user.id);
      await recordSecurityEvent('ACCOUNT_LOCKED', meta, user.id);
    }
    await failedPasswordDelay(input.email);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  await clearBackoff(input.email);

  await assertNotSuspended(user.id);
  const rehash = passwordNeedsRehash(user.passwordHash) ? await hashPassword(input.password) : null;

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, ...(rehash ? { passwordHash: rehash } : {}) },
  });

  // Session is issued by the MFA step (mfa.service) once the second factor passes.
  return challengeFor(user);
}

/**
 * Super-admin suspension (users.suspended_at, migration studio/014): blocks
 * sign-in and session refresh, so a suspended account is out within one
 * access-token lifetime (15 min) even without its sessions being revoked.
 */
export async function assertNotSuspended(userId: string): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ suspended_at: Date | null; suspended_reason: string | null; deleted_at: Date | null }>>`
    SELECT suspended_at, suspended_reason, deleted_at FROM users WHERE id = ${userId}::uuid`;
  const row = rows[0];
  if (row?.deleted_at) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account was deleted. Contact support if you think this is a mistake.');
  if (row?.suspended_at) {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', `This account is suspended${row.suspended_reason ? `: ${row.suspended_reason}` : ''}. Contact support.`);
  }
}

/** Thrown inside the rotation transaction when another request rotated first. */
class RotationRaceLost extends Error {}

/** How long a rotated token may still be honoured from the device that held it. */
const SAME_DEVICE_GRACE_MS = 2 * 60_000;

/**
 * Device fingerprint for a session: the browser's user agent plus the
 * network (/24 for IPv4, /48 for IPv6), so a phone hopping between towers
 * on the same carrier range still matches.
 */
function deviceFingerprint(userAgent: string | null | undefined, ip: string | null | undefined): string {
  const ua = (userAgent ?? '').slice(0, 512);
  const address = (ip ?? '').replace(/^::ffff:/, '');
  const network = address.includes(':') ? address.split(':').slice(0, 3).join(':') : address.split('.').slice(0, 3).join('.');
  return sha256(`${ua}|${network}`);
}

/**
 * Same-device continuation of a session whose latest rotation never reached
 * the browser. Only when: the successor was issued within the grace window,
 * the family's head is still live, and the request comes from the same
 * device fingerprint that the original token was issued to.
 */
async function resumeOnSameDevice(
  row: { id: string; familyId: string; userId: string; replacedById: string | null; userAgent?: string | null; ipAddress?: string | null; user: { id: string; role: Role } },
  meta: RequestMeta,
): Promise<AuthResult | null> {
  const original = await prisma.refreshToken.findUnique({ where: { id: row.id }, select: { userAgent: true, ipAddress: true } });
  if (!original || deviceFingerprint(original.userAgent, original.ipAddress) !== deviceFingerprint(meta.userAgent, meta.ipAddress)) return null;
  const successor = row.replacedById ? await prisma.refreshToken.findUnique({ where: { id: row.replacedById }, select: { createdAt: true } }) : null;
  if (!successor || Date.now() - successor.createdAt.getTime() > SAME_DEVICE_GRACE_MS) return null;
  const head = await prisma.refreshToken.findFirst({
    where: { familyId: row.familyId, replacedById: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!head) return null;
  try {
    const tokens = await prisma.$transaction(async (tx) => {
      const next = await issueTokens(tx, row.user, row.familyId, meta);
      const claimed = await tx.refreshToken.updateMany({ where: { id: head.id, replacedById: null, revokedAt: null }, data: { replacedById: next.refreshTokenId } });
      if (claimed.count !== 1) throw new RotationRaceLost();
      return stripInternal(next);
    });
    await recordSecurityEvent('TOKEN_REFRESHED', meta, row.userId, { familyId: row.familyId, resumedSameDevice: true });
    return { user: await getPublicUserOrThrow(row.userId), tokens };
  } catch (error) {
    if (error instanceof RotationRaceLost) return null;
    throw error;
  }
}

export async function refresh(rawToken: string, meta: RequestMeta): Promise<AuthResult> {
  const claims = verifyRefreshToken(rawToken);

  const row = await prisma.refreshToken.findUnique({
    where: { id: claims.jti },
    select: {
      id: true,
      userId: true,
      familyId: true,
      tokenHash: true,
      replacedById: true,
      revokedAt: true,
      expiresAt: true,
      user: { select: { id: true, role: true, totpEnabledAt: true } },
    },
  });

  if (
    !row ||
    row.userId !== claims.sub ||
    row.familyId !== claims.fam ||
    !safeEqual(row.tokenHash, sha256(rawToken))
  ) {
    throw new AppError(401, 'TOKEN_INVALID', 'Session is invalid');
  }
  await assertNotSuspended(row.userId);

  const onReuse = async (): Promise<never> => {
    const revoked = await revokeFamily(row.familyId, 'reuse_detected');
    logger.warn(
      { userId: row.userId, familyId: row.familyId, revoked, ip: meta.ipAddress },
      'refresh token reuse detected; session family revoked',
    );
    await recordSecurityEvent('TOKEN_REUSE_DETECTED', meta, row.userId, {
      familyId: row.familyId,
      tokenId: row.id,
    });
    throw new AppError(401, 'TOKEN_REUSE_DETECTED', 'Session was revoked for your security. Please sign in again.');
  };

  if (row.replacedById !== null) {
    // A just-rotated token presented again by the SAME device is almost always
    // a lost response (tab closed / network dropped mid-refresh), not theft:
    // continue the session from the family's current token instead of
    // signing the user out. Anything else is treated as reuse.
    const resumed = await resumeOnSameDevice(row, meta);
    if (resumed) return resumed;
    return onReuse();
  }
  if (row.revokedAt !== null) {
    throw new AppError(401, 'TOKEN_INVALID', 'Session has ended');
  }
  if (row.expiresAt <= new Date()) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Session has expired');
  }
  if (!row.user.totpEnabledAt) {
    // Sessions from before 2FA became mandatory (or after a 2FA reset) end
    // here, sending the user through enrolment at their next sign-in.
    await revokeFamily(row.familyId, 'mfa_required');
    throw new AppError(401, 'TOKEN_INVALID', 'Two-factor authentication is now required. Please sign in again.');
  }

  let tokens: SessionTokens;
  try {
    tokens = await prisma.$transaction(async (tx) => {
      const next = await issueTokens(tx, row.user, row.familyId, meta);
      // Conditional update: only one concurrent request can claim this token.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: row.id, replacedById: null, revokedAt: null },
        data: { replacedById: next.refreshTokenId },
      });
      if (claimed.count !== 1) {
        throw new RotationRaceLost();
      }
      return stripInternal(next);
    });
  } catch (error) {
    if (error instanceof RotationRaceLost) {
      return onReuse();
    }
    throw error;
  }

  await recordSecurityEvent('TOKEN_REFRESHED', meta, row.userId, { familyId: row.familyId });
  return { user: await getPublicUserOrThrow(row.userId), tokens };
}

/**
 * Ends the session. The session is identified by the refresh cookie, or, if
 * that is missing or expired, by the access token's session id, so a
 * sign-out always revokes the server-side session. Every sign-out by an
 * identifiable user is recorded as LOGGED_OUT, including one for a session
 * that had already ended. Idempotent.
 */
export async function logout(
  rawToken: string | undefined,
  access: { userId: string; sessionId: string } | undefined,
  meta: RequestMeta,
): Promise<void> {
  let familyId: string | undefined;
  let userId: string | undefined;
  if (rawToken) {
    try {
      const claims = verifyRefreshToken(rawToken);
      familyId = claims.fam;
      userId = claims.sub;
    } catch {
      // Fall through to the access token.
    }
  }
  if (!familyId && access) {
    familyId = access.sessionId;
    userId = access.userId;
  }
  if (!familyId || !userId) return;

  // Only revoke a family that belongs to this user.
  const owned = await prisma.refreshToken.findFirst({ where: { familyId, userId }, select: { id: true } });
  const revoked = owned ? await revokeFamily(familyId, 'logout') : 0;
  await recordSecurityEvent('LOGGED_OUT', meta, userId, { familyId, revokedTokens: revoked, alreadyEnded: revoked === 0 });
}

export async function listSessions(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
  const heads = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, replacedById: null, expiresAt: { gt: new Date() } },
    select: { familyId: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return heads.map((head) => ({
    id: head.familyId,
    userAgent: head.userAgent,
    ipAddress: head.ipAddress,
    lastActiveAt: head.createdAt.toISOString(),
    expiresAt: head.expiresAt.toISOString(),
    current: head.familyId === currentSessionId,
  }));
}

export async function revokeSession(userId: string, sessionId: string, meta: RequestMeta): Promise<void> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, familyId: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'user_revoked' },
  });
  if (result.count === 0) {
    throw AppError.notFound('Session');
  }
  await recordSecurityEvent('SESSION_REVOKED', meta, userId, { familyId: sessionId });
}

/** Signs the user out everywhere except, optionally, the calling session. */
export async function revokeAllSessions(
  userId: string,
  meta: RequestMeta,
  keepSessionId?: string,
): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepSessionId ? { familyId: { not: keepSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: 'user_revoked_all' },
  });
  await recordSecurityEvent('ALL_SESSIONS_REVOKED', meta, userId, { count: result.count });
  return result.count;
}

export async function getPublicUserOrThrow(userId: string): Promise<PublicUser> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
  if (!row) {
    throw AppError.notFound('User');
  }
  return toPublicUser(row);
}

/** Deletes refresh rows that expired more than a day ago. Run on an interval. */
export async function purgeExpiredRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return result.count;
}
