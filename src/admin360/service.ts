/**
 * Super admin: one user, everything about them (the user profile page).
 *
 *   overview   identity, security (2FA, lockout, suspension), last seen,
 *              workspaces + wallets, lifetime numbers
 *   assets     studio / music-video projects, reels, creations, likeness,
 *              stored files (with signed links)
 *   billing    wallets, ledger, payments (receipts), open holds, storage packs
 *   activity   requests, security events, sessions, devices / visits
 *   tickets    support tickets (support/service.ts)
 *
 * Actions: credit / debit tokens (audited ledger), suspend / reinstate, revoke
 * every session, set a storage quota override.
 */
import { prisma } from '../config/database.js';
import { revokeAllSessions } from '../services/auth.service.js';
import { readUrl } from '../services/storage.service.js';
import { getWallet, grant } from '../services/token.service.js';
import type { RequestMeta } from '../services/securityEvent.service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { sql } from '../studio/sql.js';
import { listAll } from '../support/service.js';

const DAY = 86_400_000;

async function loadUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      gender: true,
      dateOfBirth: true,
      avatarKey: true,
      totpEnabledAt: true,
      lockedUntil: true,
      failedLoginCount: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      memberships: { select: { role: true, workspace: { select: { id: true, name: true, slug: true, createdAt: true } } } },
    },
  });
  if (!user) throw AppError.notFound('User');
  return user;
}

const workspaceIdsOf = (user: Awaited<ReturnType<typeof loadUser>>): string[] => user.memberships.map((member) => member.workspace.id);

/** Newest moment the user was seen anywhere: a request, a page view, a token refresh, a sign-in. */
async function lastSeen(userId: string): Promise<{ at: string | null; source: string | null; ip: string | null; userAgent: string | null }> {
  const rows = await sql<{ at: Date | null; source: string; ip: string | null; userAgent: string | null }[]>`
    SELECT * FROM (
      (SELECT created_at AS at, 'request' AS source, ip_address AS ip, user_agent FROM activity_logs WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1)
      UNION ALL (SELECT updated_at, 'page view', ip_address, user_agent FROM site_visits WHERE user_id = ${userId} ORDER BY updated_at DESC LIMIT 1)
      UNION ALL (SELECT created_at, 'session refresh', ip_address, user_agent FROM refresh_tokens WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1)
    ) seen WHERE at IS NOT NULL ORDER BY at DESC LIMIT 1`;
  const row = rows[0];
  return { at: row?.at?.toISOString() ?? null, source: row?.source ?? null, ip: row?.ip ?? null, userAgent: row?.userAgent ?? null };
}

export async function overview(userId: string) {
  const user = await loadUser(userId);
  const workspaceIds = workspaceIdsOf(user);
  const [seen, suspension, wallets, numbers, storage, sessions, tickets] = await Promise.all([
    lastSeen(userId),
    sql<{ suspendedAt: Date | null; suspendedReason: string | null }[]>`SELECT suspended_at, suspended_reason FROM users WHERE id = ${userId}`,
    Promise.all(user.memberships.map(async (member) => ({ ...member.workspace, createdAt: member.workspace.createdAt.toISOString(), role: member.role, wallet: await getWallet(member.workspace.id) }))),
    sql<{ studioProjects: number; musicVideos: number; reelProjects: number; reels: number; creations: number; takes: number; tokensUsed: number; tokensBought: number; revenue: number; payments: number }[]>`
      SELECT
        (SELECT count(*)::int FROM studio_projects WHERE created_by_id = ${userId} AND kind = 'AI_VIDEO') AS studio_projects,
        (SELECT count(*)::int FROM studio_projects WHERE created_by_id = ${userId} AND kind = 'MUSIC_VIDEO') AS music_videos,
        (SELECT count(*)::int FROM media_projects WHERE created_by_id = ${userId}) AS reel_projects,
        (SELECT count(*)::int FROM reels r JOIN media_projects p ON p.id = r.project_id WHERE p.created_by_id = ${userId} AND r.status = 'READY') AS reels,
        (SELECT count(*)::int FROM creations WHERE user_id = ${userId}) AS creations,
        (SELECT count(*)::int FROM studio_takes t JOIN studio_projects p ON p.id = t.project_id WHERE p.created_by_id = ${userId} AND t.status = 'READY') AS takes,
        (SELECT COALESCE(sum(-amount), 0)::int FROM token_ledger WHERE workspace_id = ANY(${workspaceIds}::uuid[]) AND type = 'USAGE') AS tokens_used,
        (SELECT COALESCE(sum(amount), 0)::int FROM token_ledger WHERE workspace_id = ANY(${workspaceIds}::uuid[]) AND type = 'PURCHASE') AS tokens_bought,
        (SELECT COALESCE(sum(amount), 0)::bigint FROM payments WHERE user_id = ${userId} AND status = 'SUCCESS' AND mode = 'LIVE')::float AS revenue,
        (SELECT count(*)::int FROM payments WHERE user_id = ${userId} AND status = 'SUCCESS') AS payments`,
    sql<{ usedBytes: number; files: number; quotaOverrideBytes: number | null }[]>`SELECT used_bytes::float AS used_bytes, files, quota_override_bytes::float AS quota_override_bytes FROM storage_accounts WHERE user_id = ${userId}`,
    sql<{ count: number }[]>`SELECT count(DISTINCT family_id)::int AS count FROM refresh_tokens WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()`,
    sql<{ open: number; total: number }[]>`SELECT count(*) FILTER (WHERE status IN ('OPEN', 'PENDING'))::int AS open, count(*)::int AS total FROM support_tickets WHERE user_id = ${userId}`,
  ]);
  const age = user.dateOfBirth ? Math.floor((Date.now() - user.dateOfBirth.getTime()) / (365.25 * DAY)) : null;
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      gender: user.gender,
      age,
      avatarUrl: user.avatarKey ? await readUrl(user.avatarKey).catch(() => null) : null,
      twoFactor: Boolean(user.totpEnabledAt),
      lockedUntil: user.lockedUntil && user.lockedUntil > new Date() ? user.lockedUntil.toISOString() : null,
      failedLoginCount: user.failedLoginCount,
      suspendedAt: suspension[0]?.suspendedAt?.toISOString() ?? null,
      suspendedReason: suspension[0]?.suspendedReason ?? null,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    },
    lastSeen: seen,
    workspaces: wallets,
    numbers: numbers[0]!,
    storage: storage[0] ?? { usedBytes: 0, files: 0, quotaOverrideBytes: null },
    activeSessions: sessions[0]?.count ?? 0,
    tickets: tickets[0] ?? { open: 0, total: 0 },
  };
}

/* ------------------------------------------------------------------ assets */

export type AssetKind = 'studio' | 'reels' | 'creations' | 'likeness' | 'files';

export async function assets(userId: string, kind: AssetKind, page: number, pageSize: number) {
  await loadUser(userId);
  const offset = (page - 1) * pageSize;
  if (kind === 'studio') {
    const rows = await sql<{ id: string; workspaceId: string; kind: string; title: string; status: string; aspect: string; tokensCharged: number; outputKey: string | null; deletedAt: Date | null; createdAt: Date; takes: number; scenes: number }[]>`
      SELECT p.id, p.workspace_id, p.kind, p.title, p.status, p.aspect, p.tokens_charged, p.output_key, p.deleted_at, p.created_at,
        (SELECT count(*)::int FROM studio_takes t WHERE t.project_id = p.id AND t.status = 'READY') AS takes,
        (SELECT count(*)::int FROM studio_scenes s WHERE s.project_id = p.id) AS scenes
      FROM studio_projects p WHERE p.created_by_id = ${userId} ORDER BY p.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    return Promise.all(rows.map(async (row) => ({ ...row, createdAt: row.createdAt.toISOString(), deletedAt: row.deletedAt?.toISOString() ?? null, outputUrl: row.outputKey ? await readUrl(row.outputKey).catch(() => null) : null })));
  }
  if (kind === 'reels') {
    const rows = await sql<{ id: string; projectId: string; title: string | null; status: string; videoKey: string | null; thumbKey: string | null; durationSec: number | null; createdAt: Date; sourceName: string }[]>`
      SELECT r.id, r.project_id, r.title, r.status, r.video_key, r.thumb_key, (r.end_sec - r.start_sec)::float AS duration_sec, r.created_at, p.source_name
      FROM reels r JOIN media_projects p ON p.id = r.project_id WHERE p.created_by_id = ${userId} ORDER BY r.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        url: row.videoKey ? await readUrl(row.videoKey).catch(() => null) : null,
        thumbUrl: row.thumbKey ? await readUrl(row.thumbKey).catch(() => null) : null,
      })),
    );
  }
  if (kind === 'creations') {
    const rows = await sql<{ id: string; mode: string; prompt: string; status: string; outputKey: string | null; cost: number | null; createdAt: Date }[]>`
      SELECT id, mode, prompt, status, output_key, cost, created_at FROM creations WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    return Promise.all(rows.map(async (row) => ({ ...row, createdAt: row.createdAt.toISOString(), url: row.outputKey ? await readUrl(row.outputKey).catch(() => null) : null })));
  }
  if (kind === 'likeness') {
    const rows = await sql<{ id: string; key: string; kind: string; createdAt: Date }[]>`
      SELECT id, key, kind, created_at FROM likeness_assets WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    return Promise.all(rows.map(async (row) => ({ ...row, createdAt: row.createdAt.toISOString(), url: await readUrl(row.key).catch(() => null) })));
  }
  const rows = await sql<{ key: string; bytes: number; kind: string; createdAt: Date }[]>`
    SELECT key, bytes::float AS bytes, kind, created_at FROM storage_objects WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
  return Promise.all(rows.map(async (row) => ({ ...row, createdAt: row.createdAt.toISOString(), url: await readUrl(row.key).catch(() => null) })));
}

/* ------------------------------------------------------------------ billing */

export async function billing(userId: string, page: number, pageSize: number) {
  const user = await loadUser(userId);
  const workspaceIds = workspaceIdsOf(user);
  const [ledger, [ledgerTotal], payments, holds, storagePacks] = await Promise.all([
    sql<{ id: string; workspaceId: string; type: string; amount: number; balanceAfter: number; taskType: string | null; reference: string | null; note: string | null; actorId: string | null; createdAt: Date }[]>`
      SELECT id::text, workspace_id, type, amount, balance_after, task_type, reference, note, actor_id, created_at FROM token_ledger
      WHERE workspace_id = ANY(${workspaceIds}::uuid[]) ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM token_ledger WHERE workspace_id = ANY(${workspaceIds}::uuid[])`,
    sql<{ id: string; reference: string; mode: string; packageId: string; tokens: number; amount: number; currency: string; status: string; channel: string | null; failureReason: string | null; paidAt: Date | null; createdAt: Date }[]>`
      SELECT id, reference, mode, package_id, tokens, amount::float AS amount, currency, status, channel, failure_reason, paid_at, created_at FROM payments
      WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100`,
    sql<{ id: string; taskType: string; estimated: number; createdAt: Date; expiresAt: Date }[]>`
      SELECT id, task_type, estimated, created_at, expires_at FROM token_reservations WHERE workspace_id = ANY(${workspaceIds}::uuid[]) AND status = 'HELD' ORDER BY created_at DESC`,
    sql<{ id: string; bytes: number; amount: number; status: string; createdAt: Date }[]>`
      SELECT id, bytes::float AS bytes, amount::float AS amount, status, created_at FROM storage_purchases WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 50`.catch(() => []),
  ]);
  const iso = <T extends { createdAt: Date }>(row: T) => ({ ...row, createdAt: row.createdAt.toISOString() });
  return {
    ledger: { items: ledger.map(iso), total: ledgerTotal?.count ?? 0, page, pageSize },
    payments: payments.map((row) => ({ ...iso(row), paidAt: row.paidAt?.toISOString() ?? null })),
    holds: holds.map((row) => ({ ...iso(row), expiresAt: row.expiresAt.toISOString() })),
    storagePacks: storagePacks.map(iso),
  };
}

/* ------------------------------------------------------------------ activity */

export async function activity(userId: string, page: number, pageSize: number) {
  await loadUser(userId);
  const [requests, [requestTotal], security, sessions, visits] = await Promise.all([
    sql<{ id: string; action: string; method: string; path: string; statusCode: number; ipAddress: string | null; createdAt: Date }[]>`
      SELECT id::text, action::text, method, path, status_code, ip_address, created_at FROM activity_logs WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`.catch(() => []),
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM activity_logs WHERE user_id = ${userId}`.catch(() => [{ count: 0 }]),
    sql<{ id: string; type: string; ipAddress: string | null; userAgent: string | null; createdAt: Date }[]>`
      SELECT id::text, type::text, ip_address, user_agent, created_at FROM security_events WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 60`,
    sql<{ familyId: string; ipAddress: string | null; userAgent: string | null; startedAt: Date; lastUsedAt: Date; expiresAt: Date; revoked: boolean }[]>`
      SELECT family_id, max(ip_address) AS ip_address, max(user_agent) AS user_agent, min(created_at) AS started_at, max(created_at) AS last_used_at,
        max(expires_at) AS expires_at, bool_and(revoked_at IS NOT NULL) AS revoked
      FROM refresh_tokens WHERE user_id = ${userId} GROUP BY family_id ORDER BY max(created_at) DESC LIMIT 30`,
    sql<{ day: Date; pageViews: number; ipAddress: string | null; userAgent: string | null }[]>`
      SELECT created_at AS day, page_views, ip_address, user_agent FROM site_visits WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 60`.catch(() => []),
  ]);
  return {
    requests: { items: requests.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })), total: requestTotal?.count ?? 0, page, pageSize },
    security: security.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    sessions: sessions.map((row) => ({ ...row, startedAt: row.startedAt.toISOString(), lastUsedAt: row.lastUsedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), active: !row.revoked && row.expiresAt > new Date() })),
    visits: visits.map((row) => ({ ...row, day: row.day.toISOString() })),
  };
}

export const tickets = (userId: string) => listAll({ userId, page: 1, pageSize: 100 });

/* ------------------------------------------------------------------ actions */

/** Credits (positive) or debits (negative) a workspace of this user; always ledgered with the admin as actor. */
export async function credit(actorId: string, userId: string, input: { workspaceId?: string | undefined; amount: number; note: string }) {
  const user = await loadUser(userId);
  const owned = user.memberships.find((member) => member.role === 'OWNER')?.workspace.id;
  const workspaceId = input.workspaceId ?? owned ?? user.memberships[0]?.workspace.id;
  if (!workspaceId || !workspaceIdsOf(user).includes(workspaceId)) throw AppError.badRequest('Pick one of this user’s workspaces.');
  const wallet = await grant(actorId, workspaceId, input.amount, `${input.amount >= 0 ? 'Credit' : 'Debit'} by super admin: ${input.note}`.slice(0, 255));
  logger.info({ actorId, userId, workspaceId, amount: input.amount }, 'super admin adjusted user tokens');
  return { workspaceId, wallet };
}

export async function setSuspended(actorId: string, userId: string, suspended: boolean, reason: string | undefined, meta: RequestMeta) {
  const user = await loadUser(userId);
  if (user.role === 'SUPER_ADMIN') throw AppError.badRequest('The super admin cannot be suspended.');
  if (actorId === userId) throw AppError.badRequest('You cannot suspend yourself.');
  await sql`UPDATE users SET suspended_at = ${suspended ? new Date() : null}, suspended_reason = ${suspended ? (reason ?? null) : null} WHERE id = ${userId}`;
  // Out now, not at the next refresh.
  if (suspended) await revokeAllSessions(userId, meta);
  logger.info({ actorId, userId, suspended }, 'user suspension changed');
  return overview(userId);
}

export async function revokeSessions(userId: string, meta: RequestMeta) {
  await loadUser(userId);
  const count = await revokeAllSessions(userId, meta);
  return { revoked: count };
}

export async function setStorageQuota(userId: string, quotaBytes: number | null) {
  await loadUser(userId);
  await sql`
    INSERT INTO storage_accounts (user_id, quota_override_bytes) VALUES (${userId}, ${quotaBytes})
    ON CONFLICT (user_id) DO UPDATE SET quota_override_bytes = EXCLUDED.quota_override_bytes, updated_at = now()`;
  return overview(userId);
}
