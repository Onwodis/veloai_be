/**
 * A scene's reference video: the creator uploads a clip of what they want (a phone video of the
 * move, a rough take, a scene from somewhere else). The director watches frames from it and writes a
 * reference brief (the action, who is where, the camera move, framing, pacing and mood). Every take
 * of the scene then re-makes it clean and professional: the scene's own cast, place and look, the
 * reference's action and camera. Charged like one director call; the clip itself is never copied.
 */
import { z } from 'zod';
import type { AuthContext } from '../middleware/authenticate.js';
import { videoFrames } from '../musicvideo/audio.js';
import { keys, readUrl } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { parse, photoBlock } from './director.js';
import { getStudioSettings } from './settings.js';
import { json, sql } from './sql.js';

export interface SceneReference {
  assetId: string;
  status: 'ANALYSING' | 'READY' | 'FAILED';
  brief: string | null;
  error: string | null;
  at: string;
}

const BriefSchema = z.object({
  action: z.string().describe('What happens, beat by beat, in plain words: who does what, in what order'),
  blocking: z.string().describe('Where each person is and faces, how they move through the frame'),
  camera: z.string().describe('The camera move, framing and lens feel (e.g. slow push-in from a medium to a close-up, handheld, low angle)'),
  pacing: z.string().describe('Speed and rhythm of the movement and the cut'),
  mood: z.string().describe('The feel: light, energy, attitude'),
});

const SYSTEM =
  'You are a director preparing a professional re-shoot. The creator sent a rough reference clip (often a phone video) of what they want in one scene. ' +
  'From the frames (start to end) describe what to recreate: the action beat by beat, the blocking, the camera move and framing, the pacing and the mood. ' +
  'Describe it so a crew can shoot a clean, professional version: ignore the reference’s poor quality, shaky phone work, bad light, mess and watermarks, and never name or identify real people. ' +
  'Be concrete and short (each field 1-2 sentences).';

/** The scene prompt with the reference brief added (the brief goes last: video models weigh the end most). */
export function withReference(prompt: string, reference: SceneReference | null | undefined): string {
  const line = referenceLine(reference);
  if (!line) return prompt;
  const base = prompt.trim().slice(0, Math.max(300, 2000 - line.length - 2)).trim();
  return `${base}${/[.!?]$/.test(base) ? '' : '.'} ${line}`;
}

/** What the editor shows: the state, the brief and the clip (to replay it). */
export async function referenceView(reference: SceneReference, key: string | undefined) {
  return { ...reference, url: key ? await readUrl(key).catch(() => null) : null };
}

/** The text added to every shot prompt of the scene. */
export function referenceLine(reference: SceneReference | null | undefined): string {
  if (!reference || reference.status !== 'READY' || !reference.brief) return '';
  return `Recreate the creator's reference clip as a clean, professional shot (keep this scene's people, place and look): ${reference.brief}`;
}

async function sceneOf(workspaceId: string, projectId: string, sceneId: string) {
  const [row] = await sql<{ id: string; reference: SceneReference | null }[]>`
    SELECT s.id, s.reference FROM studio_scenes s JOIN studio_projects p ON p.id = s.project_id
    WHERE s.id = ${sceneId} AND s.project_id = ${projectId} AND p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL`;
  if (!row) throw AppError.notFound('Scene');
  return row;
}

/** Attaches an uploaded video (a READY VIDEO asset of the project) as the scene's reference and analyses it. */
export async function setReference(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, assetId: string): Promise<void> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  await sceneOf(workspaceId, projectId, sceneId);
  const [asset] = await sql<{ key: string; role: string; status: string }[]>`SELECT key, role, status FROM studio_assets WHERE id = ${assetId} AND project_id = ${projectId}`;
  if (!asset || asset.role !== 'VIDEO' || asset.status !== 'READY') throw AppError.badRequest('Upload the reference video first (MP4, MOV or WebM).');
  const { costs } = await getStudioSettings();
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_DIRECTOR', costs.director, { projectId, sceneId, reference: true });
  const state: SceneReference = { assetId, status: 'ANALYSING', brief: null, error: null, at: new Date().toISOString() };
  await sql`UPDATE studio_scenes SET reference = ${json(state)}, updated_at = now() WHERE id = ${sceneId}`;

  void (async () => {
    try {
      const frameKeys = await videoFrames(asset.key, (index) => `${keys.studio(workspaceId, projectId)}/references/${sceneId}-${index}.jpg`, 5);
      const frames = await Promise.all(frameKeys.map((key) => photoBlock(key)));
      const { data } = await parse('director', BriefSchema, SYSTEM, [{ type: 'text', text: 'Frames from the reference clip, start to end:' }, ...frames]);
      const brief = [data.action, `Blocking: ${data.blocking}`, `Camera: ${data.camera}`, `Pacing: ${data.pacing}`, `Mood: ${data.mood}`].join(' ').slice(0, 900);
      await settleSystem(reservation.id, workspaceId, costs.director, 'Scene reference video: analysed');
      await sql`UPDATE studio_scenes SET reference = ${json({ ...state, status: 'READY', brief })}, updated_at = now() WHERE id = ${sceneId} AND reference ->> 'assetId' = ${assetId}`;
    } catch (error) {
      await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
      logger.warn({ err: error, sceneId }, 'scene reference analysis failed');
      await sql`UPDATE studio_scenes SET reference = ${json({ ...state, status: 'FAILED', error: 'The reference could not be read. Try a shorter, clearer clip.' })} WHERE id = ${sceneId} AND reference ->> 'assetId' = ${assetId}`.catch(() => undefined);
    }
  })();
}

/** Edits the brief by hand (free). */
export async function editReference(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, brief: string): Promise<void> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  const scene = await sceneOf(workspaceId, projectId, sceneId);
  if (!scene.reference) throw AppError.badRequest('Add a reference video first.');
  await sql`UPDATE studio_scenes SET reference = ${json({ ...scene.reference, status: 'READY', brief: brief.trim().slice(0, 900), error: null })}, updated_at = now() WHERE id = ${sceneId}`;
}

export async function removeReference(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string): Promise<void> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  await sceneOf(workspaceId, projectId, sceneId);
  await sql`UPDATE studio_scenes SET reference = NULL, updated_at = now() WHERE id = ${sceneId}`;
}
