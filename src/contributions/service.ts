/**
 * Contributions, GitHub-style but plain:
 *
 *   push      save the project's editable state as a checkpoint, with an
 *             auto-written summary of what changed since the last one
 *   inbox     a push by anyone but the project's creator waits for the
 *             creator: accept it (pull) or revert it
 *   revert    bring back the state from before a push (recorded as its own push)
 *   restore   bring back any checkpoint (recorded as its own push)
 *   diff      side by side, field by field, between a push and the one before
 *
 * Every push is recorded with its author (audit trail).
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { workspaceAccess } from '../commercials/companies.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { diffSnapshots, restoreSnapshot, summarise, takeSnapshot, type Snapshot } from './snapshot.js';

type PushKind = 'PUSH' | 'AUTO' | 'REVERT' | 'RESTORE';
type PushStatus = 'OPEN' | 'ACCEPTED' | 'REVERTED';

interface PushRow {
  id: string;
  projectId: string;
  authorId: string;
  authorName: string | null;
  parentId: string | null;
  kind: PushKind;
  message: string;
  summary: string;
  changes: { count: number; areas: string[] };
  status: PushStatus;
  reviewedById: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

interface ProjectRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  createdById: string | null;
}

const present = (row: PushRow, viewerId: string) => ({
  id: row.id,
  parentId: row.parentId,
  kind: row.kind,
  message: row.message,
  summary: row.summary,
  changes: row.changes,
  status: row.status,
  author: { id: row.authorId, name: row.authorName ?? 'A teammate', you: row.authorId === viewerId },
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});
export type PushView = ReturnType<typeof present>;

async function project(auth: AuthContext, workspaceId: string, projectId: string, write: boolean): Promise<ProjectRow> {
  await workspaceAccess(auth, workspaceId, write);
  const [row] = await sql<ProjectRow[]>`SELECT id, title, kind, status, created_by_id FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!row) throw AppError.notFound('Project');
  return row;
}

/** The creator decides on others' pushes (the super admin can too). */
const isCreator = (auth: AuthContext, row: ProjectRow): boolean => auth.role === 'SUPER_ADMIN' || row.createdById === auth.userId;

async function latest(projectId: string): Promise<{ id: string; snapshot: Snapshot } | null> {
  const [row] = await sql<{ id: string; snapshot: Snapshot }[]>`SELECT id, snapshot FROM project_pushes WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 1`;
  return row ?? null;
}

async function load(projectId: string, pushId: string): Promise<PushRow & { snapshot: Snapshot }> {
  const [row] = await sql<(PushRow & { snapshot: Snapshot })[]>`
    SELECT p.*, u.display_name AS author_name FROM project_pushes p JOIN users u ON u.id = p.author_id
    WHERE p.id = ${pushId} AND p.project_id = ${projectId}`;
  if (!row) throw AppError.notFound('Push');
  return row;
}

async function record(auth: AuthContext, row: ProjectRow, kind: PushKind, message: string, summaryOverride?: string) {
  const snapshot = await takeSnapshot(row.id);
  const previous = await latest(row.id);
  const changes = diffSnapshots(previous?.snapshot ?? null, snapshot);
  if (previous && changes.length === 0 && (kind === 'PUSH' || kind === 'AUTO')) return null;
  const summary = summaryOverride ?? summarise(changes, !previous);
  // Others' work waits for the creator; the creator's own pushes are accepted as they land.
  const status: PushStatus = (kind === 'PUSH' || kind === 'AUTO') && !isCreator(auth, row) ? 'OPEN' : 'ACCEPTED';
  const [created] = await sql<PushRow[]>`
    INSERT INTO project_pushes (project_id, author_id, parent_id, kind, message, summary, changes, snapshot, status)
    VALUES (${row.id}, ${auth.userId}, ${previous?.id ?? null}, ${kind}, ${message.slice(0, 300)}, ${summary.slice(0, 600)},
      ${json({ count: changes.length, areas: [...new Set(changes.map((change) => change.area))] })}, ${json(snapshot)}, ${status})
    RETURNING *, (SELECT display_name FROM users WHERE id = ${auth.userId}) AS author_name`;
  return created!;
}

export async function listPushes(auth: AuthContext, workspaceId: string, projectId: string) {
  const row = await project(auth, workspaceId, projectId, false);
  const pushes = await sql<PushRow[]>`
    SELECT p.id, p.project_id, p.author_id, u.display_name AS author_name, p.parent_id, p.kind, p.message, p.summary, p.changes, p.status,
      p.reviewed_by_id, p.reviewed_at, p.created_at
    FROM project_pushes p JOIN users u ON u.id = p.author_id WHERE p.project_id = ${projectId} ORDER BY p.created_at DESC LIMIT 100`;
  // What changed since the last checkpoint (drives "N unpushed changes" and the reminder).
  const previous = await latest(projectId);
  const pending = previous ? diffSnapshots(previous.snapshot, await takeSnapshot(projectId)) : null;
  const [prefs] = await sql<{ autoPush: boolean }[]>`SELECT auto_push FROM push_prefs WHERE user_id = ${auth.userId}`;
  return {
    pushes: pushes.map((push) => present(push, auth.userId)),
    unpushed: pending ? pending.length : null,
    unpushedSummary: pending?.length ? summarise(pending, false) : null,
    canReview: isCreator(auth, row),
    autoPush: prefs?.autoPush ?? false,
  };
}

export async function push(auth: AuthContext, workspaceId: string, projectId: string, message: string, auto: boolean) {
  const row = await project(auth, workspaceId, projectId, true);
  const created = await record(auth, row, auto ? 'AUTO' : 'PUSH', message);
  if (!created) {
    if (auto) return { push: null };
    throw AppError.badRequest('Nothing new to push: no changes since the last checkpoint.');
  }
  return { push: present(created, auth.userId) };
}

/** Side by side: the push against the checkpoint before it. */
export async function diffPush(auth: AuthContext, workspaceId: string, projectId: string, pushId: string) {
  await project(auth, workspaceId, projectId, false);
  const target = await load(projectId, pushId);
  const parent = target.parentId ? await load(projectId, target.parentId).catch(() => null) : null;
  return { push: present(target, auth.userId), changes: diffSnapshots(parent?.snapshot ?? null, target.snapshot) };
}

/** The creator pulls a teammate's push (keeps it). */
export async function acceptPush(auth: AuthContext, workspaceId: string, projectId: string, pushId: string) {
  const row = await project(auth, workspaceId, projectId, true);
  if (!isCreator(auth, row)) throw new AppError(403, 'FORBIDDEN', 'Only the project creator reviews pushes.');
  await load(projectId, pushId);
  await sql`UPDATE project_pushes SET status = 'ACCEPTED', reviewed_by_id = ${auth.userId}, reviewed_at = now() WHERE id = ${pushId} AND status = 'OPEN'`;
  return listPushes(auth, workspaceId, projectId);
}

function assertIdle(row: ProjectRow): void {
  if (row.status === 'ASSEMBLING') throw AppError.conflict('Wait for the master to finish (or pause it) first.');
}

/** Brings back the state from before a push. */
export async function revertPush(auth: AuthContext, workspaceId: string, projectId: string, pushId: string) {
  const row = await project(auth, workspaceId, projectId, true);
  assertIdle(row);
  const target = await load(projectId, pushId);
  if (target.authorId !== auth.userId && !isCreator(auth, row)) throw new AppError(403, 'FORBIDDEN', 'Only the creator can revert someone else’s push.');
  if (!target.parentId) throw AppError.badRequest('This is the first checkpoint: there is nothing before it to go back to.');
  const parent = await load(projectId, target.parentId);
  const report = await restoreSnapshot(projectId, parent.snapshot);
  await sql`UPDATE project_pushes SET status = 'REVERTED', reviewed_by_id = ${auth.userId}, reviewed_at = now() WHERE id = ${pushId}`;
  const created = await record(auth, row, 'REVERT', '', `Reverted “${target.summary}” by ${target.authorName ?? 'a teammate'}`);
  return { push: created ? present(created, auth.userId) : null, report };
}

/** Brings back any checkpoint. */
export async function restorePush(auth: AuthContext, workspaceId: string, projectId: string, pushId: string) {
  const row = await project(auth, workspaceId, projectId, true);
  assertIdle(row);
  const target = await load(projectId, pushId);
  // Keep the current work first, so the restore itself can be undone.
  await record(auth, row, 'AUTO', 'Saved before a restore');
  const report = await restoreSnapshot(projectId, target.snapshot);
  const created = await record(auth, row, 'RESTORE', '', `Restored the checkpoint from ${target.createdAt.toISOString().slice(0, 16).replace('T', ' ')} (“${target.summary}”)`);
  return { push: created ? present(created, auth.userId) : null, report };
}

/** The creator's inbox across the workspace: pushes waiting for review. */
export async function inbox(auth: AuthContext, workspaceId: string) {
  await workspaceAccess(auth, workspaceId, false);
  const rows = await sql<(PushRow & { projectTitle: string; projectKind: string })[]>`
    SELECT p.id, p.project_id, p.author_id, u.display_name AS author_name, p.parent_id, p.kind, p.message, p.summary, p.changes, p.status,
      p.reviewed_by_id, p.reviewed_at, p.created_at, sp.title AS project_title, sp.kind AS project_kind
    FROM project_pushes p JOIN studio_projects sp ON sp.id = p.project_id JOIN users u ON u.id = p.author_id
    WHERE sp.workspace_id = ${workspaceId} AND sp.deleted_at IS NULL AND p.status = 'OPEN'
      AND (sp.created_by_id = ${auth.userId} OR ${auth.role === 'SUPER_ADMIN'})
    ORDER BY p.created_at DESC LIMIT 100`;
  return { items: rows.map((row) => ({ ...present(row, auth.userId), projectId: row.projectId, projectTitle: row.projectTitle, projectKind: row.projectKind })) };
}

export async function setAutoPush(auth: AuthContext, on: boolean) {
  await sql`
    INSERT INTO push_prefs (user_id, auto_push, updated_at) VALUES (${auth.userId}, ${on}, now())
    ON CONFLICT (user_id) DO UPDATE SET auto_push = EXCLUDED.auto_push, updated_at = now()`;
  return { autoPush: on };
}
