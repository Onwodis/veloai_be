/**
 * Undo / redo for every studio project (music videos, ads, AI Studio), per user.
 *
 * The page records a checkpoint when it opens and after every change it makes (the project's
 * editable state, contributions/snapshot.ts: scripts, scenes, timing, cast, text, titles, options,
 * brief…; never media). Undo restores the checkpoint before the current one; redo brings the undone
 * one back; a new change after an undo drops the undone ones (like any editor). Restoring uses the
 * same non-destructive restore as checkpoints: generated takes are never deleted, scenes made since
 * are kept but left out of the video, shot-locked scenes are not touched.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { workspaceAccess } from '../commercials/companies.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { diffSnapshots, restoreSnapshot, summarise, takeSnapshot, type Snapshot } from './snapshot.js';

const KEEP = 60;

interface Entry {
  id: string;
  snapshot: Snapshot;
  label: string;
  undone: boolean;
}

async function guard(auth: AuthContext, workspaceId: string, projectId: string, write: boolean): Promise<void> {
  await workspaceAccess(auth, workspaceId, write);
  const [row] = await sql<{ status: string }[]>`SELECT status FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!row) throw AppError.notFound('Project');
  if (write && row.status === 'ASSEMBLING') throw AppError.conflict('The video is being stitched: undo and redo wait until it finishes.');
}

async function stack(projectId: string, userId: string): Promise<Entry[]> {
  return sql<Entry[]>`SELECT id::text, snapshot, label, undone FROM project_undo WHERE project_id = ${projectId} AND user_id = ${userId} ORDER BY id`;
}

/** What the Undo / Redo buttons show. */
function state(entries: Entry[]) {
  const live = entries.filter((entry) => !entry.undone);
  const redo = entries.find((entry) => entry.undone);
  const current = live.at(-1);
  return {
    canUndo: live.length > 1,
    canRedo: Boolean(redo),
    undoLabel: live.length > 1 ? current!.label : null,
    redoLabel: redo?.label ?? null,
  };
}
export type UndoState = ReturnType<typeof state>;

export async function undoState(auth: AuthContext, workspaceId: string, projectId: string): Promise<UndoState> {
  await guard(auth, workspaceId, projectId, false);
  return state(await stack(projectId, auth.userId));
}

/** Records the project as it is now (skipped when nothing changed since the current checkpoint). */
export async function checkpoint(auth: AuthContext, workspaceId: string, projectId: string): Promise<UndoState> {
  await guard(auth, workspaceId, projectId, false);
  const entries = await stack(projectId, auth.userId);
  const current = entries.filter((entry) => !entry.undone).at(-1);
  const snapshot = await takeSnapshot(projectId);
  const changes = current ? diffSnapshots(current.snapshot, snapshot) : [];
  if (current && changes.length === 0) return state(entries);
  // A new change after an undo: the undone branch goes (it can't be redone any more).
  await sql`DELETE FROM project_undo WHERE project_id = ${projectId} AND user_id = ${auth.userId} AND undone = true`;
  const label = current ? summarise(changes, false).slice(0, 200) : 'Opened';
  await sql`INSERT INTO project_undo (project_id, user_id, snapshot, label) VALUES (${projectId}, ${auth.userId}, ${json(snapshot)}, ${label})`;
  await sql`
    DELETE FROM project_undo WHERE project_id = ${projectId} AND user_id = ${auth.userId}
      AND id NOT IN (SELECT id FROM project_undo WHERE project_id = ${projectId} AND user_id = ${auth.userId} ORDER BY id DESC LIMIT ${KEEP})`;
  return state(await stack(projectId, auth.userId));
}

export async function undo(auth: AuthContext, workspaceId: string, projectId: string) {
  await guard(auth, workspaceId, projectId, true);
  // Changes made since the last checkpoint (e.g. by a teammate or a running job) are recorded first.
  await checkpoint(auth, workspaceId, projectId);
  const live = (await stack(projectId, auth.userId)).filter((entry) => !entry.undone);
  if (live.length < 2) throw AppError.badRequest('Nothing to undo.');
  const current = live.at(-1)!;
  const target = live.at(-2)!;
  const report = await restoreSnapshot(projectId, target.snapshot);
  await sql`UPDATE project_undo SET undone = true WHERE id = ${current.id}::bigint`;
  return { undone: current.label, report, state: state(await stack(projectId, auth.userId)) };
}

export async function redo(auth: AuthContext, workspaceId: string, projectId: string) {
  await guard(auth, workspaceId, projectId, true);
  const next = (await stack(projectId, auth.userId)).find((entry) => entry.undone);
  if (!next) throw AppError.badRequest('Nothing to redo.');
  const report = await restoreSnapshot(projectId, next.snapshot);
  await sql`UPDATE project_undo SET undone = false WHERE id = ${next.id}::bigint`;
  return { redone: next.label, report, state: state(await stack(projectId, auth.userId)) };
}
