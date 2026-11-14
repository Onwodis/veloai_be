/**
 * Character photo shoots (table mv_character_photos, migration studio/015).
 *
 * High-quality stills of one cast member in a scripted scene (its script,
 * place, time of day and wardrobe) or in a free brief, made from the
 * character's reference photos with the same real-life standard as the video
 * keyframes (real skin, real light, no retouching). A still can become a
 * scene's first frame, so the video starts from a picture the artist chose.
 *
 * Billing: tokens for every requested still are reserved up front; only the
 * stills that come out are charged (one settlement per shoot).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthContext } from '../middleware/authenticate.js';
import { deleteObject, keys, readUrl, uploadFile } from '../services/storage.service.js';
import { ENGINE_NAME } from '../utils/engineName.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { assertStorage } from '../storage/service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { ASPECTS, keyframePrompt, type Shot } from '../studio/cinema.js';
import * as fal from '../studio/fal.js';
import { conformImage, downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { SceneRow } from '../studio/types.js';
import { publishProgress } from '../realtime/events.js';
import { access, load, loadCharacter, view } from './service.js';

interface PhotoRow {
  id: string;
  projectId: string;
  workspaceId: string;
  characterId: string;
  sceneId: string | null;
  brief: string;
  aspect: keyof typeof ASPECTS;
  status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';
  imageKey: string | null;
  cost: number;
  reservationId: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

const PHOTO_BYTES = 3 * 1024 * 1024;

export async function listPhotos(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, false);
  await load(workspaceId, projectId);
  const rows = await sql<PhotoRow[]>`SELECT * FROM mv_character_photos WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 200`;
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      characterId: row.characterId,
      sceneId: row.sceneId,
      brief: row.brief,
      aspect: row.aspect,
      status: row.status,
      error: row.error,
      cost: row.cost,
      url: row.imageKey ? await readUrl(row.imageKey).catch(() => null) : null,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

/** The scene, written for a still camera: its script plus place, time and wardrobe. */
function sceneBrief(scene: Pick<SceneRow, 'prompt' | 'description' | 'location' | 'timeOfDay' | 'costume'>): string {
  return [
    scene.prompt || scene.description,
    scene.location ? `Location: ${scene.location}.` : '',
    scene.timeOfDay ? `Time of day: ${scene.timeOfDay}.` : '',
    scene.costume ? `Wardrobe: ${scene.costume}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function shootPhotos(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  characterId: string,
  input: { sceneId?: string | undefined; brief?: string | undefined; count: number; aspect?: keyof typeof ASPECTS | undefined; dryRun?: boolean | undefined },
) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  const character = await loadCharacter(projectId, characterId);
  if (!character.consentAt) throw AppError.badRequest(`Record ${character.isArtist ? 'your consent' : `${character.name}'s permission`} before making photos of them.`);
  if (character.referenceKeys.length === 0) throw AppError.badRequest(`Add photos of ${character.name} and build their casting sheet first.`);

  let scene: SceneRow | undefined;
  if (input.sceneId) {
    [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${input.sceneId} AND project_id = ${projectId}`;
    if (!scene) throw AppError.notFound('Scene');
  }
  const brief = (scene ? sceneBrief(scene) : (input.brief ?? '')).trim();
  if (brief.length < 5) throw AppError.badRequest('Pick a scene or describe the shot.');

  const settings = await getStudioSettings();
  const model = settings.models.characterStill;
  if (!model.enabled) throw AppError.badRequest('Character photo shoots are switched off in the console.');
  const count = Math.min(4, Math.max(1, Math.floor(input.count)));
  const total = count * settings.costs.characterStill;
  if (input.dryRun) return { estimate: { tokens: total, perPhoto: settings.costs.characterStill }, project: null };
  if (!fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', `Image generation is not switched on yet (the ${ENGINE_NAME} is not connected). Ask the platform operator.`);
  await assertStorage(auth, count * PHOTO_BYTES, 'these photos');

  const aspect = input.aspect ?? project.aspect;
  const { reservation } = await reserveTokens(auth, workspaceId, 'MV_CHARACTER_PHOTOS', total, { projectId, characterId, count });
  const ids: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO mv_character_photos (project_id, workspace_id, character_id, scene_id, brief, aspect, cost, reservation_id, created_by_id)
        VALUES (${projectId}, ${workspaceId}, ${characterId}, ${scene?.id ?? null}, ${brief.slice(0, 4000)}, ${aspect}, ${settings.costs.characterStill}, ${reservation.id}, ${auth.userId})
        RETURNING id`;
      ids.push(row!.id);
    }
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }

  const identity = [character.prompt || character.profile || '', character.attributes.notes ?? ''].filter(Boolean).join(' ').slice(0, 900);
  const prompt = `Production still from a music video shoot, photographed on set. ${keyframePrompt({
    scene: brief,
    shot: (scene?.shot ?? 'medium') as Shot,
    style: mv.vision?.slice(0, 200) || undefined,
    identity,
    featuresSubject: true,
    aspect,
  })}`;
  void runShoot({ ids, reservationId: reservation.id, workspaceId, projectId, title: project.title, characterName: character.name, referenceKeys: character.referenceKeys.slice(0, 4), prompt, aspect });
  return { estimate: { tokens: total, perPhoto: settings.costs.characterStill }, project: await view(auth, workspaceId, projectId) };
}

/** Renders every still of one shoot (in parallel), then settles the reservation once. */
async function runShoot(job: { ids: string[]; reservationId: string; workspaceId: string; projectId: string; title: string; characterName: string; referenceKeys: string[]; prompt: string; aspect: keyof typeof ASPECTS }) {
  const settings = await getStudioSettings();
  const model = settings.models.characterStill;
  const size = ASPECTS[job.aspect];
  const urls = await Promise.all(job.referenceKeys.map((key) => readUrl(key)));
  const workDir = await mkdtemp(join(tmpdir(), 'mvphoto-'));
  let ready = 0;
  await Promise.all(
    job.ids.map(async (id, index) => {
      try {
        await sql`UPDATE mv_character_photos SET status = 'RUNNING' WHERE id = ${id}`;
        // A different seed per still, so a shoot gives real options.
        const handle = await fal.submit(model.endpoint, { ...model.extra, prompt: job.prompt, image_urls: urls, seed: Math.floor(Math.random() * 2 ** 31) + index });
        const result = await fal.wait(handle);
        await sql`UPDATE mv_character_photos SET fal_result = ${json(result)} WHERE id = ${id}`;
        const raw = join(workDir, `${id}-raw`);
        const framed = join(workDir, `${id}.png`);
        await downloadUrl(fal.outputUrl(result, 'image'), raw);
        await conformImage(raw, framed, size.width, size.height);
        const key = `${keys.studio(job.workspaceId, job.projectId)}/characters/photos/${id}-${randomUUID().slice(0, 8)}.png`;
        await uploadFile(key, framed, 'image/png');
        await sql`UPDATE mv_character_photos SET status = 'READY', image_key = ${key}, finished_at = now() WHERE id = ${id}`;
        ready += 1;
        logger.info({ photoId: id, bytes: (await stat(framed)).size }, 'character photo ready');
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 900);
        logger.error({ err: error, photoId: id }, 'character photo failed');
        await sql`UPDATE mv_character_photos SET status = 'FAILED', error = ${message}, finished_at = now() WHERE id = ${id}`.catch(() => undefined);
      }
      publishProgress({ kind: 'studio', workspaceId: job.workspaceId, projectId: job.projectId, stage: 'PHOTOS', status: 'UPDATE', detail: job.characterName });
    }),
  );
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  const perPhoto = settings.costs.characterStill;
  try {
    if (ready === 0) await releaseSystem(job.reservationId, job.workspaceId);
    else {
      const settled = await settleSystem(job.reservationId, job.workspaceId, ready * perPhoto, `Music video · ${job.title.slice(0, 50)}: ${ready} photo(s) of ${job.characterName}`);
      await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${settled.actual ?? ready * perPhoto} WHERE id = ${job.projectId}`;
    }
  } catch (error) {
    logger.error({ err: error, reservationId: job.reservationId }, 'character photo settlement failed');
  }
}

export async function deletePhoto(auth: AuthContext, workspaceId: string, projectId: string, photoId: string) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [row] = await sql<PhotoRow[]>`SELECT * FROM mv_character_photos WHERE id = ${photoId} AND project_id = ${projectId}`;
  if (!row) throw AppError.notFound('Photo');
  if (row.status === 'QUEUED' || row.status === 'RUNNING') throw AppError.conflict('This photo is still being made.');
  // Keep the file if a scene uses it as its first frame.
  const [used] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_assets WHERE project_id = ${projectId} AND key = ${row.imageKey ?? ''}`;
  if (row.imageKey && !used?.count) await deleteObject(row.imageKey).catch(() => undefined);
  await sql`DELETE FROM mv_character_photos WHERE id = ${photoId}`;
  return view(auth, workspaceId, projectId);
}

/** Makes a still the first frame of a scene: the next take animates from it (with identity lock). */
export async function useAsFirstFrame(auth: AuthContext, workspaceId: string, projectId: string, photoId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [row] = await sql<PhotoRow[]>`SELECT * FROM mv_character_photos WHERE id = ${photoId} AND project_id = ${projectId} AND status = 'READY'`;
  if (!row?.imageKey) throw AppError.notFound('Photo');
  const [scene] = await sql<{ id: string }[]>`SELECT id FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  const [asset] = await sql<{ id: string }[]>`
    INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta, status)
    VALUES (${projectId}, ${workspaceId}, 'PHOTO', ${row.imageKey}, ${`photo-${row.id.slice(0, 8)}.png`}, 'image/png', ${PHOTO_BYTES}, ${json({ subject: true, fromPhotoShoot: row.id })}, 'READY')
    RETURNING id`;
  await sql`UPDATE studio_scenes SET photo_asset_ids = ARRAY[${asset!.id}::uuid], updated_at = now() WHERE id = ${sceneId}`;
  return view(auth, workspaceId, projectId);
}
