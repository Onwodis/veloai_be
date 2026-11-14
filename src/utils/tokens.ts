/**
 * JWT issuance and verification.
 *
 * Two token kinds, each with its own secret so one can never be accepted in
 * place of the other:
 *
 *  - Access token  (15 min): stateless, sent as `Authorization: Bearer`.
 *  - Refresh token (7 days): carries a `jti` (row id in `refresh_tokens`) and
 *    `fam` (the rotation family). It is single-use; the server rotates it on
 *    every refresh and revokes the whole family if a used one comes back.
 *
 * The algorithm is pinned to HS256 on both sign and verify, which closes the
 * `alg: none` / algorithm-confusion class of attacks.
 */
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';
import { ROLES, type Role } from '../models/user.model.js';
import { newId } from './crypto.js';

const ALGORITHM = 'HS256' as const;

const accessClaimsSchema = z.object({
  sub: z.uuid(),
  role: z.enum(ROLES),
  sid: z.uuid(),
  typ: z.literal('access'),
});

const refreshClaimsSchema = z.object({
  sub: z.uuid(),
  jti: z.uuid(),
  fam: z.uuid(),
  typ: z.literal('refresh'),
  exp: z.number().int(),
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;
export type RefreshClaims = z.infer<typeof refreshClaimsSchema>;

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export function signAccessToken(input: {
  userId: string;
  role: Role;
  sessionId: string;
}): IssuedAccessToken {
  const claims = { role: input.role, sid: input.sessionId, typ: 'access' } as const;
  const token = jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: ALGORITHM,
    subject: input.userId,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
  return {
    token,
    expiresAt: new Date(Date.now() + env.ACCESS_TOKEN_TTL_SECONDS * 1000),
  };
}

export function signRefreshToken(input: {
  userId: string;
  tokenId: string;
  familyId: string;
}): string {
  return jwt.sign({ fam: input.familyId, typ: 'refresh' }, env.JWT_REFRESH_SECRET, {
    algorithm: ALGORITHM,
    subject: input.userId,
    jwtid: input.tokenId,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.REFRESH_TOKEN_TTL_SECONDS,
  });
}

function verifyWith<T>(token: string, secret: string, schema: z.ZodType<T>): T {
  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Token has expired');
    }
    throw new AppError(401, 'TOKEN_INVALID', 'Token is invalid');
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new AppError(401, 'TOKEN_INVALID', 'Token is invalid');
  }
  return parsed.data;
}

export function verifyAccessToken(token: string): AccessClaims {
  return verifyWith(token, env.JWT_ACCESS_SECRET, accessClaimsSchema);
}

export function verifyRefreshToken(token: string): RefreshClaims {
  return verifyWith(token, env.JWT_REFRESH_SECRET, refreshClaimsSchema);
}

/* ------------------------------------------------------------------ 2FA challenge */

/**
 * Proof that the password step passed, exchanged for a session only after a
 * valid TOTP (or recovery) code. `stage` says what the client must do next.
 * Its own `typ` and audience suffix mean it can never pass as an access token.
 */
const MFA_CHALLENGE_TTL_SECONDS = 10 * 60;

const challengeClaimsSchema = z.object({
  sub: z.uuid(),
  jti: z.uuid(),
  stage: z.enum(['setup', 'verify']),
  typ: z.literal('mfa_challenge'),
  exp: z.number().int(),
});

export type ChallengeClaims = z.infer<typeof challengeClaimsSchema>;

export function signChallengeToken(userId: string, stage: 'setup' | 'verify'): { token: string; expiresAt: Date } {
  const token = jwt.sign({ stage, typ: 'mfa_challenge' }, env.JWT_ACCESS_SECRET, {
    algorithm: ALGORITHM,
    subject: userId,
    jwtid: newId(),
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:mfa`,
    expiresIn: MFA_CHALLENGE_TTL_SECONDS,
  });
  return { token, expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000) };
}

export function verifyChallengeToken(token: string): ChallengeClaims {
  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: `${env.JWT_AUDIENCE}:mfa`,
    });
  } catch {
    throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'Your sign-in attempt expired. Enter your password again.');
  }
  const parsed = challengeClaimsSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'Your sign-in attempt expired. Enter your password again.');
  }
  return parsed.data;
}
