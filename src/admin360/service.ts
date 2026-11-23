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
import { deletePrefix, readUrl } from '../services/storage.service.js';
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
    sql<{ suspendedAt: Date | null; suspendedReason: string | null; deletedAt: Date | null; purgeAfter: Date | null }[]>`SELECT suspended_at, suspended_reason, deleted_at, purge_after FROM users WHERE id = ${userId}`,
    Promise.all(user.memberships.map(async (member) => ({ ...member.workspace, createdAt: member.workspace.createdAt.toISOString(), role: member.role, wallet: await getWallet(member.workspace.id) }))),
    sql<{ studioProjects: number; musicVideos: number; reelProjects: number; reels: number; creations: number; takes: number; tokensUsed: number; tokensBought: number; tokensFree: number; revenue: number; payments: number }[]>`
      SELECT
        (SELECT count(*)::int FROM studio_projects WHERE created_by_id = ${userId} AND kind = 'AI_VIDEO') AS studio_projects,
        (SELECT count(*)::int FROM studio_projects WHERE created_by_id = ${userId} AND kind = 'MUSIC_VIDEO') AS music_videos,
        (SELECT count(*)::int FROM media_projects WHERE created_by_id = ${userId}) AS reel_projects,
        (SELECT count(*)::int FROM reels r JOIN media_projects p ON p.id = r.project_id WHERE p.created_by_id = ${userId} AND r.status = 'READY') AS reels,
        (SELECT count(*)::int FROM creations WHERE user_id = ${userId}) AS creations,
        (SELECT count(*)::int FROM studio_takes t JOIN studio_projects p ON p.id = t.project_id WHERE p.created_by_id = ${userId} AND t.status = 'READY') AS takes,
        (SELECT COALESCE(sum(-amount), 0)::int FROM token_ledger WHERE workspace_id = ANY(${workspaceIds}::uuid[]) AND type = 'USAGE') AS tokens_used,
        (SELECT COALESCE(sum(amount), 0)::int FROM token_ledger WHERE workspace_id = ANY(${workspaceIds}::uuid[]) AND type = 'PURCHASE') AS tokens_bought,
        (SELECT COALESCE(sum(amount), 0)::int FROM token_ledger WHERE workspace_id = ANY(${workspaceIds}::uuid[]) AND type = 'GRANT') AS tokens_free,
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
      deletedAt: suspension[0]?.deletedAt?.toISOString() ?? null,
      purgeAfter: suspension[0]?.purgeAfter?.toISOString() ?? null,
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
  // Added tokens are free tokens (GRANT in the ledger), labelled so on the user's billing history.
  const note = input.amount > 0 ? `Free tokens${input.note ? `: ${input.note}` : ''}` : `Removed by super admin: ${input.note}`;
  const wallet = await grant(actorId, workspaceId, input.amount, note.slice(0, 255));
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

/* ------------------------------------------------------------------ deleting a user */

/** Days between "delete" and the permanent purge (restorable until then). */
export const DELETE_GRACE_DAYS = 14;

interface Membership {
  workspaceId: string;
  name: string;
  role: string;
  others: number;
}

async function membershipsOf(userId: string): Promise<Membership[]> {
  return sql<Membership[]>`
    SELECT m.workspace_id, w.name, m.role, (SELECT count(*)::int FROM workspace_members o WHERE o.workspace_id = m.workspace_id AND o.user_id <> ${userId}) AS others
    FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ${userId}`;
}

async function deletionState(userId: string): Promise<{ deletedAt: Date | null; purgeAfter: Date | null }> {
  const [row] = await sql<{ deletedAt: Date | null; purgeAfter: Date | null }[]>`SELECT deleted_at, purge_after FROM users WHERE id = ${userId}`;
  return row ?? { deletedAt: null, purgeAfter: null };
}

/**
 * What deleting this user takes with it, for the warning page: the workspaces that go (only they
 * belong to them), the shared ones that stay (their own projects in them go; ownership passes on),
 * the work, files, tokens and YouTube shows involved, and whether anything is running.
 */
export async function deletionPreview(userId: string) {
  const user = await loadUser(userId);
  const memberships = await membershipsOf(userId);
  const solo = memberships.filter((row) => row.others === 0);
  const shared = memberships.filter((row) => row.others > 0);
  const soloIds = solo.map((row) => row.workspaceId);
  const [counts] = await sql<{ projects: number; reelProjects: number; creations: number; shows: number; channels: number; tokens: number; payments: number; running: number }[]>`
    SELECT
      (SELECT count(*)::int FROM studio_projects WHERE created_by_id = ${userId} OR workspace_id = ANY(${soloIds}::uuid[])) AS projects,
      (SELECT count(*)::int FROM media_projects WHERE created_by_id = ${userId} OR workspace_id = ANY(${soloIds}::uuid[])) AS reel_projects,
      (SELECT count(*)::int FROM creations WHERE user_id = ${userId}) AS creations,
      (SELECT count(*)::int FROM yt_shows WHERE workspace_id = ANY(${soloIds}::uuid[]) AND deleted_at IS NULL) AS shows,
      (SELECT count(*)::int FROM yt_channels WHERE workspace_id = ANY(${soloIds}::uuid[])) AS channels,
      (SELECT COALESCE(sum(balance), 0)::int FROM token_wallets WHERE workspace_id = ANY(${soloIds}::uuid[])) AS tokens,
      (SELECT count(*)::int FROM payments WHERE workspace_id = ANY(${soloIds}::uuid[])) AS payments,
      (SELECT count(*)::int FROM token_reservations WHERE workspace_id = ANY(${soloIds}::uuid[]) AND status = 'HELD') AS running`;
  const [storage] = await sql<{ usedBytes: number; files: number }[]>`SELECT used_bytes::float AS used_bytes, files FROM storage_accounts WHERE user_id = ${userId}`;
  const state = await deletionState(userId);
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, createdAt: user.createdAt.toISOString() },
    graceDays: DELETE_GRACE_DAYS,
    deletedAt: state.deletedAt?.toISOString() ?? null,
    purgeAfter: state.purgeAfter?.toISOString() ?? null,
    canDelete: user.role !== 'SUPER_ADMIN',
    workspacesDeleted: solo.map((row) => ({ id: row.workspaceId, name: row.name })),
    workspacesKept: shared.map((row) => ({ id: row.workspaceId, name: row.name, members: row.others, owner: row.role === 'OWNER' })),
    counts: { ...counts!, storageBytes: storage?.usedBytes ?? 0, storageFiles: storage?.files ?? 0 },
  };
}

/**
 * Step one (super admin): marks the user deleted. At once they are signed out everywhere, can't
 * sign in, and their scheduled YouTube shows are paused; nothing is removed yet. The
 * "purge-deleted-users" job removes everything for good after DELETE_GRACE_DAYS; until then
 * restoreUser undoes it. `confirmEmail` must match, so the wrong account can't be deleted by a slip.
 */
export async function scheduleDeletion(actorId: string, userId: string, confirmEmail: string, meta: RequestMeta) {
  const user = await loadUser(userId);
  if (user.role === 'SUPER_ADMIN') throw AppError.badRequest('A super admin cannot be deleted.');
  if (actorId === userId) throw AppError.badRequest('You cannot delete yourself.');
  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) throw AppError.badRequest('Type the user’s email address exactly to confirm.');
  const state = await deletionState(userId);
  if (state.deletedAt) throw AppError.conflict('This user is already deleted and waiting for the permanent purge.');
  const purgeAfter = new Date(Date.now() + DELETE_GRACE_DAYS * DAY);
  await sql`
    UPDATE users SET deleted_at = now(), deleted_by = ${actorId}, purge_after = ${purgeAfter},
      pre_delete_suspension = jsonb_build_object('at', suspended_at, 'reason', suspended_reason),
      suspended_at = coalesce(suspended_at, now()), suspended_reason = 'This account was deleted'
    WHERE id = ${userId}`;
  const solo = (await membershipsOf(userId)).filter((row) => row.others === 0).map((row) => row.workspaceId);
  if (solo.length) await sql`UPDATE yt_shows SET status = 'PAUSED', updated_at = now() WHERE workspace_id IN ${sql(solo)} AND status = 'ACTIVE'`;
  await revokeAllSessions(userId, meta).catch(() => undefined);
  logger.warn({ actorId, userId, email: user.email, purgeAfter }, 'user marked deleted (purge scheduled)');
  return deletionPreview(userId);
}

/** Undoes a pending deletion: the account and its previous suspension state come back (shows stay paused). */
export async function restoreUser(actorId: string, userId: string) {
  await loadUser(userId);
  const [row] = await sql<{ deletedAt: Date | null; pre: { at: string | null; reason: string | null } | null }[]>`
    SELECT deleted_at, pre_delete_suspension AS pre FROM users WHERE id = ${userId}`;
  if (!row?.deletedAt) throw AppError.conflict('This user is not deleted.');
  await sql`
    UPDATE users SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, pre_delete_suspension = NULL,
      suspended_at = ${row.pre?.at ? new Date(row.pre.at) : null}, suspended_reason = ${row.pre?.reason ?? null}
    WHERE id = ${userId}`;
  logger.warn({ actorId, userId }, 'user deletion undone');
  return deletionPreview(userId);
}

/**
 * Step two (the job): removes everything for good. Workspaces only they belong to go whole
 * (projects, reels, videos, YouTube shows and channels, wallet and billing history); in shared
 * workspaces their own projects go and ownership passes to the longest-standing other member;
 * then the account (everything tied to it cascades) and every stored file of theirs.
 * Skipped (retried next run) while one of their jobs is still running.
 */
async function purgeUser(userId: string): Promise<boolean> {
  const memberships = await membershipsOf(userId);
  const solo = memberships.filter((row) => row.others === 0).map((row) => row.workspaceId);
  const handOver = memberships.filter((row) => row.others > 0 && row.role === 'OWNER').map((row) => row.workspaceId);
  if (solo.length) {
    const [running] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM token_reservations WHERE workspace_id IN ${sql(solo)} AND status = 'HELD'`;
    if (running && running.n > 0) return false;
  }
  const intakeLinks = solo.length ? await sql<{ id: string }[]>`SELECT id FROM mv_intake_links WHERE workspace_id IN ${sql(solo)}` : [];
  // Their own projects in shared workspaces go too (with their files).
  const ownStudio = await sql<{ id: string; workspaceId: string }[]>`SELECT id, workspace_id FROM studio_projects WHERE created_by_id = ${userId} AND NOT (workspace_id = ANY(${solo}::uuid[]))`;
  const ownMedia = await sql<{ id: string; workspaceId: string }[]>`SELECT id, workspace_id FROM media_projects WHERE created_by_id = ${userId} AND NOT (workspace_id = ANY(${solo}::uuid[]))`;

  await sql.begin(async (tx) => {
    for (const workspaceId of handOver) {
      await tx`
        UPDATE workspace_members SET role = 'OWNER' WHERE workspace_id = ${workspaceId} AND user_id = (
          SELECT user_id FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id <> ${userId} ORDER BY (role = 'OWNER') DESC, created_at LIMIT 1)`;
    }
    if (ownStudio.length) await tx`DELETE FROM studio_projects WHERE id IN ${tx(ownStudio.map((row) => row.id))}`;
    if (ownMedia.length) await tx`DELETE FROM media_projects WHERE id IN ${tx(ownMedia.map((row) => row.id))}`;
    if (solo.length) {
      // Tables keyed by workspace without a foreign key (direct-SQL features) go first.
      await tx`DELETE FROM yt_films WHERE workspace_id IN ${tx(solo)}`;
      await tx`DELETE FROM yt_shows WHERE workspace_id IN ${tx(solo)}`;
      await tx`DELETE FROM yt_channels WHERE workspace_id IN ${tx(solo)}`;
      await tx`DELETE FROM mv_intake_links WHERE workspace_id IN ${tx(solo)}`;
      await tx`DELETE FROM share_links WHERE workspace_id IN ${tx(solo)}`;
      await tx`DELETE FROM storage_objects WHERE workspace_id IN ${tx(solo)}`;
      await tx`DELETE FROM likeness_profiles WHERE workspace_id IN ${tx(solo)}`;
      await tx`DELETE FROM workspaces WHERE id IN ${tx(solo)}`;
    }
    await tx`DELETE FROM project_undo WHERE user_id = ${userId}`;
    await tx`DELETE FROM users WHERE id = ${userId}`;
  });

  // Stored files, after the rows are gone (best effort; the storage report shows anything left).
  const prefixes = [
    ...solo.flatMap((workspaceId) => [`workspaces/${workspaceId}/`, `youtube/${workspaceId}/`]),
    ...ownStudio.map((row) => `workspaces/${row.workspaceId}/studio/${row.id}/`),
    ...ownMedia.map((row) => `workspaces/${row.workspaceId}/projects/${row.id}/`),
    ...intakeLinks.map((link) => `intake/${link.id}/`),
    `users/${userId}/`,
    `portraits/${userId}/`,
    `system/likeness/${userId}/`,
  ];
  let removed = 0;
  for (const prefix of prefixes) removed += await deletePrefix(prefix).catch(() => 0);
  logger.warn({ userId, workspaces: solo.length, handedOver: handOver.length, ownProjects: ownStudio.length + ownMedia.length, files: removed }, 'deleted user purged for good');
  return true;
}

/** The scheduled job: purges every user whose grace period is over. */
export async function purgeDeletedUsers(): Promise<string> {
  const due = await sql<{ id: string }[]>`SELECT id FROM users WHERE deleted_at IS NOT NULL AND purge_after <= now() ORDER BY purge_after LIMIT 20`;
  let purged = 0;
  let waiting = 0;
  for (const row of due) {
    try {
      if (await purgeUser(row.id)) purged += 1;
      else waiting += 1;
    } catch (error) {
      logger.error({ err: error, userId: row.id }, 'user purge failed (retried next run)');
    }
  }
  return `${purged} purged${waiting ? `, ${waiting} waiting for running work` : ''}`;
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
