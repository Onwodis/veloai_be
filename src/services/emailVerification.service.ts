/**
 * Email verification, and the free tokens behind it.
 *
 *   sign-up    a link is emailed (valid 48 h; only its SHA-256 hash is stored)
 *   verify     the link marks the address verified and grants the welcome tokens to the user's own
 *              workspace, once (bonus_granted_at is the lock)
 *   gates      the welcome bonus and the free trial wait for a verified address, so free tokens
 *              can't be farmed with throwaway accounts; everything else works before verifying
 *   resend     at most once a minute
 * Accounts from before this feature are verified (migration 042).
 */
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { sendMail } from './mail/mail.service.js';
import { verifyEmailMail } from './mail/templates.js';
import { getTokenSettings } from './settings.service.js';
import { applyEntry } from './token.service.js';

const LINK_TTL_MS = 48 * 3_600_000;
const RESEND_GAP_MS = 60_000;

interface Row {
  userId: string;
  sentAt: Date | null;
  verifiedAt: Date | null;
  bonusGrantedAt: Date | null;
}

/** Emails a fresh link (the previous one stops working). */
export async function sendVerification(userId: string, force = false): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const [row] = await sql<Row[]>`SELECT * FROM email_verifications WHERE user_id = ${userId}`;
  if (row?.verifiedAt) return;
  if (!force && row?.sentAt && Date.now() - row.sentAt.getTime() < RESEND_GAP_MS) {
    throw new AppError(429, 'RATE_LIMITED', 'A link was just sent: check your inbox (and spam), or try again in a minute.');
  }
  const raw = randomToken(32);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await sql`
    INSERT INTO email_verifications (user_id, token_hash, expires_at, sent_at) VALUES (${userId}, ${sha256(raw)}, ${expiresAt}, now())
    ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, sent_at = now()`;
  const { signupBonus } = await getTokenSettings();
  await sendMail(user.email, verifyEmailMail(`${env.WEB_APP_URL}/verify-email?token=${encodeURIComponent(raw)}`, signupBonus));
}

/** After sign-up: send the link; a mail outage never blocks the sign-up itself. */
export async function startVerification(userId: string): Promise<void> {
  await sendVerification(userId, true).catch((error: unknown) => logger.warn({ err: error, userId }, 'verification email not sent at sign-up'));
}

/** Grants the welcome tokens once, into the user's own (first) workspace. */
async function grantWelcome(userId: string): Promise<number> {
  const { signupBonus } = await getTokenSettings();
  const [claimed] = await sql<{ userId: string }[]>`
    UPDATE email_verifications SET bonus_granted_at = now() WHERE user_id = ${userId} AND bonus_granted_at IS NULL RETURNING user_id`;
  if (!claimed || signupBonus <= 0) return 0;
  const [owned] = await sql<{ workspaceId: string }[]>`
    SELECT workspace_id FROM workspace_members WHERE user_id = ${userId} AND role = 'OWNER' ORDER BY created_at LIMIT 1`.catch(() => []);
  if (!owned) return 0;
  try {
    await prisma.$transaction((tx) =>
      applyEntry(tx, { workspaceId: owned.workspaceId, type: 'GRANT', amount: signupBonus, reference: `welcome:${userId}`, note: 'Welcome tokens (email verified)', actorId: userId }),
    );
  } catch (error) {
    // Undo the lock so the next verification attempt can grant it.
    await sql`UPDATE email_verifications SET bonus_granted_at = NULL WHERE user_id = ${userId}`.catch(() => undefined);
    throw error;
  }
  logger.info({ userId, workspaceId: owned.workspaceId, tokens: signupBonus }, 'welcome tokens granted on email verification');
  return signupBonus;
}

/** The link from the email: verifies the address and grants the welcome tokens. */
export async function verifyEmail(raw: string): Promise<{ verified: true; bonus: number }> {
  const [row] = await sql<(Row & { expiresAt: Date | null })[]>`SELECT * FROM email_verifications WHERE token_hash = ${sha256(raw)}`;
  if (!row) throw AppError.badRequest('This link is invalid or was replaced by a newer one. Send a new link from your dashboard.');
  if (!row.verifiedAt) {
    if (!row.expiresAt || row.expiresAt <= new Date()) throw AppError.badRequest('This link has expired. Send a new one from your dashboard.');
    await sql`UPDATE email_verifications SET verified_at = now(), token_hash = NULL WHERE user_id = ${row.userId} AND verified_at IS NULL`;
  }
  return { verified: true, bonus: await grantWelcome(row.userId) };
}

export async function verificationStatus(userId: string): Promise<{ verified: boolean; sentAt: string | null; bonus: number; bonusGranted: boolean }> {
  const [[row], { signupBonus }] = await Promise.all([sql<Row[]>`SELECT * FROM email_verifications WHERE user_id = ${userId}`, getTokenSettings()]);
  return { verified: Boolean(row?.verifiedAt), sentAt: row?.sentAt?.toISOString() ?? null, bonus: signupBonus, bonusGranted: Boolean(row?.bonusGrantedAt) };
}

/** Free tokens wait for a verified address. */
export async function requireVerifiedEmail(userId: string, what: string): Promise<void> {
  const [row] = await sql<Row[]>`SELECT verified_at FROM email_verifications WHERE user_id = ${userId}`;
  if (!row?.verifiedAt) throw new AppError(403, 'FORBIDDEN', `Verify your email address first to ${what}: we sent you a link (you can send it again from your dashboard).`, { emailVerification: true });
}

