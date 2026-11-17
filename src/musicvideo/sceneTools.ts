/**
 * Storyboard scene tools beyond add / edit / delete:
 *
 *   duplicate   a full copy of a scene (script, cast, look, edits, timing),
 *               placed right after it, or after any scene (paste). With
 *               `withVideo`, its chosen finished take comes too, with its own
 *               copies of the files (never shared keys: deleting one copy
 *               must not break the other).
 *   tweak       a NEW scene made from a generated one: a frame of its video
 *               becomes the new scene's reference photo (same person, place,
 *               light and framing), and the artist's instruction says what
 *               changes ("she smiles, then laughs", "he turns to the camera
 *               and points"). Lip sync can be switched on so the new shot
 *               sings this scene's part of the song. It is shot like any
 *               scene (price shown first).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, probe } from '../media/ffmpeg.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { copyObject, deleteObject, downloadToFile, keys, listObjects, uploadFile } from '../services/storage.service.js';
import * as studio from '../studio/service.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { access, assertStage, load, normalizeOrder, SCENE_STAGES, stopSequence, touch, view } from './service.js';

/** Columns a copy must not carry over (identity, order, approvals, the chosen take, timestamps). */
const SKIP_SCENE = new Set(['id', 'position', 'selected_take_id', 'approved_at', 'shot_approved_at', 'created_at', 'updated_at']);
const SKIP_TAKE = new Set(['id', 'scene_id', 'created_at', 'updated_at', 'reservation_id']);
const columnCache = new Map<string, string[]>();

async function columns(table: 'studio_scenes' | 'studio_takes', skip: Set<string>): Promise<string[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const rows = await sql<{ name: string }[]>`SELECT column_name AS name FROM information_schema.columns WHERE table_name = ${table} ORDER BY ordinal_position`;
  const list = rows.map((row) => row.name).filter((name) => !skip.has(name));
  columnCache.set(table, list);
  return list;
}

async function sceneOf(projectId: string, sceneId: string) {
  const [scene] = await sql<{ id: string; kind: string; selectedTakeId: string | null; description: string; characterIds: string[] }[]>`
    SELECT id, kind, selected_take_id, description, character_ids FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  return scene;
}

/** Copies the scene row; returns the new id. `overrides` set columns on the copy. */
async function copySceneRow(sceneId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const list = await columns('studio_scenes', SKIP_SCENE);
  const kept = list.filter((name) => !(name in overrides));
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studio_scenes (position, ${sql(kept)})
    SELECT 100000, ${sql(kept)} FROM studio_scenes WHERE id = ${sceneId} RETURNING id`;
  const id = row!.id;
  if (Object.keys(overrides).length) await sql`UPDATE studio_scenes SET ${sql(overrides as Record<string, never>)} WHERE id = ${id}`;
  return id;
}

/** Copies a finished take (row + every file under its folder) onto another scene. */
async function copyTake(workspaceId: string, projectId: string, takeId: string, sceneId: string): Promise<string> {
  const list = await columns('studio_takes', SKIP_TAKE);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studio_takes (scene_id, ${sql(list)})
    SELECT ${sceneId}, ${sql(list)} FROM studio_takes WHERE id = ${takeId} RETURNING id`;
  const newId = row!.id;
  const from = `${keys.studio(workspaceId, projectId)}/takes/${takeId}/`;
  const to = `${keys.studio(workspaceId, projectId)}/takes/${newId}/`;
  for (const object of await listObjects(from)) await copyObject(object.key, object.key.replace(from, to));
  // Every key that pointed into the old folder now points into the new one.
  await sql`
    UPDATE studio_takes SET
      video_key = replace(video_key, ${from}, ${to}),
      thumb_key = replace(thumb_key, ${from}, ${to}),
      keyframe_key = replace(keyframe_key, ${from}, ${to}),
      spec = replace(spec::text, ${from}, ${to})::jsonb,
      outputs = replace(outputs::text, ${from}, ${to})::jsonb
    WHERE id = ${newId}`;
  return newId;
}

async function placeAfter(projectId: string, newId: string, afterId: string): Promise<void> {
  const order = (await sql<{ id: string }[]>`SELECT id FROM studio_scenes WHERE project_id = ${projectId} AND id <> ${newId} ORDER BY position`).map((row) => row.id);
  const at = order.indexOf(afterId);
  order.splice(at < 0 ? order.length : at + 1, 0, newId);
  await normalizeOrder(projectId, order);
}

export async function duplicateScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, options: { withVideo: boolean; afterSceneId?: string | undefined }) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const source = await sceneOf(projectId, sceneId);
  const after = options.afterSceneId ? await sceneOf(projectId, options.afterSceneId) : source;
  const newId = await copySceneRow(sceneId, {});
  if (options.withVideo && source.selectedTakeId) {
    const [take] = await sql<{ status: string }[]>`SELECT status FROM studio_takes WHERE id = ${source.selectedTakeId}`;
    if (take?.status === 'READY') {
      const takeId = await copyTake(workspaceId, projectId, source.selectedTakeId, newId);
      await sql`UPDATE studio_scenes SET selected_take_id = ${takeId} WHERE id = ${newId}`;
    }
  }
  // An OUTRO stays last: pasting "after" it lands just before it.
  await placeAfter(projectId, newId, after.id);
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

export async function tweakScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, input: { instruction: string; lipSync: boolean; frameAt?: number | undefined }) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const source = await sceneOf(projectId, sceneId);
  if (!source.selectedTakeId) throw AppError.badRequest('Generate (and pick) a video for this scene first: the new scene starts from a frame of it.');
  const [take] = await sql<{ videoKey: string | null; status: string }[]>`SELECT video_key, status FROM studio_takes WHERE id = ${source.selectedTakeId}`;
  if (take?.status !== 'READY' || !take.videoKey) throw AppError.badRequest('This scene has no finished video yet.');

  const dir = await mkdtemp(join(tmpdir(), 'tweak-'));
  try {
    const video = join(dir, 'take.mp4');
    await downloadToFile(take.videoKey, video);
    const { durationSec } = await probe(video);
    const at = Math.max(0, Math.min(durationSec - 0.05, input.frameAt ?? durationSec / 2));
    const frame = join(dir, 'frame.png');
    await ffmpeg(['-ss', at.toFixed(3), '-i', video, '-frames:v', '1', frame]);
    const [asset] = await sql<{ id: string }[]>`
      INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta, status)
      VALUES (${projectId}, ${workspaceId}, 'PHOTO', '', ${`frame-of-scene-${at.toFixed(1)}s.png`}, 'image/png', 0, ${json({ subject: true, fromScene: sceneId, frameAt: at })}, 'PENDING') RETURNING id`;
    const key = keys.studioAsset(workspaceId, projectId, asset!.id, `frame-${randomUUID().slice(0, 8)}.png`);
    await uploadFile(key, frame, 'image/png');
    await sql`UPDATE studio_assets SET key = ${key}, status = 'READY' WHERE id = ${asset!.id}`;

    const instruction = input.instruction.trim();
    const newId = await copySceneRow(sceneId, {
      kind: 'STORY',
      description: `${source.description.slice(0, 300)} → ${instruction.slice(0, 300)}`,
      prompt:
        `Continue the exact shot in the reference frame: the same person (identical face, hair, skin, build and wardrobe), the same place, lighting and camera framing. ` +
        `${instruction}. Natural, real movement; keep the camera subtle.`,
      lip_sync: input.lipSync && source.characterIds.length > 0,
    });
    // uuid[] needs an explicit cast (a plain array binds as text[]).
    await sql`UPDATE studio_scenes SET photo_asset_ids = ARRAY[${asset!.id}::uuid] WHERE id = ${newId}`;
    await placeAfter(projectId, newId, sceneId);
    await touch(projectId);
    return view(auth, workspaceId, projectId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Deletes every generated video of the project, files included, to start the
 * shoot over or free storage. Scenes, scripts, cast, song, mix and settings
 * stay. Running takes are cancelled (their unused tokens go back), "Generate
 * all" is stopped, scene locks are lifted, and a project past the storyboard
 * goes back to it. Optionally the finished master, the quick clips and the
 * cold-open film go too. A master being stitched must be stopped first.
 */
export async function deleteAllVideos(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  options: { master: boolean; clips: boolean; coldOpen: boolean },
) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  if (project.status === 'ASSEMBLING') throw AppError.conflict('The master is being stitched: stop it first, then delete the videos.');
  if (mv.sequence?.active) await stopSequence(auth, workspaceId, projectId, true);

  const scenes = (await sql<{ id: string }[]>`SELECT id FROM studio_scenes WHERE project_id = ${projectId}`).map((row) => row.id);
  await studio.cancelScenes(projectId, scenes);
  const finished = await studio.finishedTakeIds(projectId);
  await sql`UPDATE studio_scenes SET selected_take_id = NULL, shot_approved_at = NULL, updated_at = now() WHERE project_id = ${projectId}`;
  // Cancelled takes still clean up after themselves in their workers; the rest go now (rows and files).
  if (finished.length) await sql`DELETE FROM studio_takes WHERE id = ANY(${finished}::uuid[])`;
  await studio.dropTakeFiles(workspaceId, projectId, finished);

  let masters = 0;
  if (options.master && (project.outputKey || project.thumbKey)) {
    for (const key of [project.outputKey, project.thumbKey]) if (key) await deleteObject(key).catch(() => undefined);
    await sql`UPDATE studio_projects SET output_key = NULL, thumb_key = NULL, status = 'DRAFT', progress = 0, updated_at = now() WHERE id = ${projectId}`;
    masters = 1;
  }
  let clips = 0;
  if (options.clips) {
    const rows = await sql<{ id: string; outputKey: string | null; thumbKey: string | null; status: string }[]>`
      SELECT id, output_key, thumb_key, status FROM mv_clips WHERE project_id = ${projectId}`;
    for (const clip of rows.filter((row) => row.status !== 'RENDERING' && row.status !== 'QUEUED')) {
      for (const key of [clip.outputKey, clip.thumbKey]) if (key) await deleteObject(key).catch(() => undefined);
      await sql`DELETE FROM mv_clips WHERE id = ${clip.id}`;
      clips += 1;
    }
  }
  let coldOpen = false;
  if (options.coldOpen) {
    const [prologue] = await sql<{ outputKey: string | null; thumbKey: string | null; status: string }[]>`
      SELECT output_key, thumb_key, status FROM mv_prologues WHERE project_id = ${projectId}`;
    if (prologue && prologue.status !== 'FILMING' && (prologue.outputKey || prologue.thumbKey)) {
      for (const key of [prologue.outputKey, prologue.thumbKey]) if (key) await deleteObject(key).catch(() => undefined);
      // The plan (shots, voice-over) stays: it can be filmed again.
      await sql`UPDATE mv_prologues SET output_key = NULL, thumb_key = NULL, duration_sec = NULL, status = 'DRAFT', progress = 0, step = '', updated_at = now() WHERE project_id = ${projectId}`;
      coldOpen = true;
    }
  }

  // Past the storyboard there is nothing left to shoot or master from: back to the storyboard.
  if (mv.stage === 'SHOOT' || mv.stage === 'MASTER') {
    const approvals = Object.fromEntries(Object.entries(mv.approvals).filter(([stage]) => !['STORYBOARD', 'SHOOT', 'MASTER'].includes(stage)));
    await sql`UPDATE mv_projects SET stage = 'STORYBOARD', approvals = ${json(approvals)}, auto_mode = false, updated_at = now() WHERE project_id = ${projectId}`;
  }
  await touch(projectId);
  return { project: await view(auth, workspaceId, projectId), deleted: { takes: finished.length, masters, clips, coldOpen } };
}
