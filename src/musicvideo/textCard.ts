/**
 * Text cards: a scene that is a blank screen with text on it ("Lagos, 2019", a dedication, the
 * publishing rights, a chapter title), placed anywhere in the storyboard.
 *
 * The card's picture is a plain background (a colour, a two-colour gradient or a vignette, with
 * optional film grain) rendered here with ffmpeg as an ordinary finished take: free, no AI. The
 * words are the scene's own text overlays (studio/clipEdits.ts texts, drawn by the text engine), so
 * they are edited, previewed and mastered exactly like text over any other scene, and the card is
 * moved, copied, timed, cross-faded and synced like any other scene. A card is recognised by its
 * take's engine ('text card'); changing the background renders a new take and drops the old one.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ffmpeg } from '../media/ffmpeg.js';
import { TEXT_TEMPLATE_IDS, templateStyle, textStyleSchema } from '../media/textfx.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { keys, uploadFile } from '../services/storage.service.js';
import { ASPECTS, type Aspect } from '../studio/cinema.js';
import { clipEditsSchema, parseEdits } from '../studio/clipEdits.js';
import { dropTakeFiles } from '../studio/service.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { TakeSpec } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { access, assertStage, load, normalizeOrder, SCENE_STAGES, touch, view } from './service.js';

export const CARD_ENGINE = 'text card';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Use a colour like #101820' });

export const cardBackgroundSchema = z.strictObject({
  kind: z.enum(['solid', 'gradient', 'vignette']),
  color: hex,
  /** The gradient's second colour. */
  color2: hex.optional(),
  /** Gradient direction. */
  direction: z.enum(['down', 'right', 'diagonal']).optional(),
  /** A light film grain over the card. */
  grain: z.boolean().optional(),
});
export type CardBackground = z.infer<typeof cardBackgroundSchema>;

export const newTextCardSchema = z.strictObject({
  text: z.string().trim().min(1).max(300),
  seconds: z.number().min(1).max(20),
  template: z.enum(TEXT_TEMPLATE_IDS).optional(),
  look: textStyleSchema.optional(),
  background: cardBackgroundSchema,
  title: z.string().trim().max(80).optional(),
  afterSceneId: z.uuid().optional(),
});

const ffColor = (color: string): string => `0x${color.slice(1).toUpperCase()}`;
const rgb = (color: string): [number, number, number] => [0, 2, 4].map((at) => parseInt(color.slice(1 + at, 3 + at), 16)) as [number, number, number];

/** The background as a short silent clip (a little longer than the card: the master trims it). */
async function renderBackground(dir: string, background: CardBackground, aspect: Aspect, seconds: number): Promise<{ video: string; thumb: string }> {
  const { width, height } = ASPECTS[aspect];
  const length = (seconds + 1).toFixed(2);
  const size = `${width}x${height}`;
  const filters: string[] = [];
  let input: string[];
  if (background.kind === 'gradient') {
    // One exact frame (a per-pixel blend between the two colours), then held for the length.
    const [r0, g0, b0] = rgb(background.color);
    const [r1, g1, b1] = rgb(background.color2 ?? '#000000');
    const t = background.direction === 'right' ? 'X/W' : background.direction === 'diagonal' ? '(X/W+Y/H)/2' : 'Y/H';
    const still = join(dir, 'gradient.png');
    await ffmpeg([
      '-f', 'lavfi', '-i', `color=c=black:s=${size}:d=0.1`, '-frames:v', '1',
      '-vf', `format=rgb24,geq=r='${r0}+(${r1 - r0})*${t}':g='${g0}+(${g1 - g0})*${t}':b='${b0}+(${b1 - b0})*${t}'`,
      still,
    ]);
    input = ['-loop', '1', '-framerate', '24', '-t', length, '-i', still];
  } else {
    input = ['-f', 'lavfi', '-i', `color=c=${ffColor(background.color)}:s=${size}:r=24:d=${length}`];
    if (background.kind === 'vignette') filters.push('vignette=angle=PI/3.2');
  }
  if (background.grain) filters.push('noise=alls=7:allf=t+u');
  filters.push('format=yuv420p');
  const video = join(dir, 'card.mp4');
  await ffmpeg([...input, '-vf', filters.join(','), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '24', '-movflags', '+faststart', video]);
  const thumb = join(dir, 'card.jpg');
  await ffmpeg(['-ss', '0.2', '-i', video, '-frames:v', '1', '-q:v', '3', thumb]);
  return { video, thumb };
}

/** Renders the background as a READY take on the scene, selects it, drops any earlier card take. */
async function placeBackground(workspaceId: string, projectId: string, sceneId: string, aspect: Aspect, background: CardBackground, seconds: number, description: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'card-'));
  try {
    const { video, thumb } = await renderBackground(dir, background, aspect, seconds);
    const spec: TakeSpec & { card: CardBackground } = {
      kind: 'MUSIC_VIDEO',
      aspect,
      description,
      prompt: '',
      shot: 'wide',
      durationSec: seconds,
      featuresSubject: false,
      lipSync: false,
      identityKeys: [],
      musicVideo: true,
      card: background,
    };
    const [take] = await sql<{ id: string }[]>`
      INSERT INTO studio_takes (scene_id, project_id, workspace_id, status, spec, cost, settled, engine, finished_at, duration_sec)
      VALUES (${sceneId}, ${projectId}, ${workspaceId}, 'READY', ${json(spec)}, 0, true, ${CARD_ENGINE}, now(), ${seconds + 1})
      RETURNING id`;
    const base = `${keys.studio(workspaceId, projectId)}/takes/${take!.id}`;
    await uploadFile(`${base}/video.mp4`, video, 'video/mp4');
    await uploadFile(`${base}/thumb.jpg`, thumb, 'image/jpeg');
    await sql`UPDATE studio_takes SET video_key = ${`${base}/video.mp4`}, thumb_key = ${`${base}/thumb.jpg`} WHERE id = ${take!.id}`;
    // Earlier card backgrounds go (their files too); AI takes on the scene, if any, stay.
    const old = (await sql<{ id: string }[]>`SELECT id FROM studio_takes WHERE scene_id = ${sceneId} AND engine = ${CARD_ENGINE} AND id <> ${take!.id}`).map((row) => row.id);
    // A card costs nothing to make, so it is locked in straight away (it goes into the master).
    await sql`UPDATE studio_scenes SET selected_take_id = ${take!.id}, shot_approved_at = COALESCE(shot_approved_at, now()), updated_at = now() WHERE id = ${sceneId}`;
    if (old.length) {
      await sql`DELETE FROM studio_takes WHERE id = ANY(${old}::uuid[])`;
      await dropTakeFiles(workspaceId, projectId, old);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A new text card scene (after the scene in focus, else at the end). */
export async function addTextCard(auth: AuthContext, workspaceId: string, projectId: string, input: z.infer<typeof newTextCardSchema>) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const { limits } = await getStudioSettings();
  const order = (await sql<{ id: string }[]>`SELECT id FROM studio_scenes WHERE project_id = ${projectId} ORDER BY position`).map((row) => row.id);
  if (order.length >= limits.maxScenes) throw AppError.badRequest(`Up to ${limits.maxScenes} scenes.`);
  const look = input.look ?? templateStyle(input.template ?? 'write-up');
  const edits = clipEditsSchema.parse({
    texts: [{ id: randomUUID().slice(0, 8), text: input.text, start: 0.2, end: input.seconds, template: input.template ?? 'write-up', look: { ...look, position: look.position === 'bottom' ? 'bottom' : 'middle' } }],
  });
  const description = `Text card: ${input.text.replace(/\s+/g, ' ').slice(0, 200)}`;
  const [scene] = await sql<{ id: string }[]>`
    INSERT INTO studio_scenes (project_id, position, kind, title, subtitle, description, prompt, shot, transition, duration_sec, features_subject, lip_sync, character_ids, mode, edits, approved_at)
    VALUES (${projectId}, 100000, 'STORY', ${(input.title ?? 'Text card').slice(0, 80)}, ${input.text.replace(/\s+/g, ' ').slice(0, 120)}, ${description}, ${null}, 'wide', 'crossfade', ${input.seconds},
      false, false, ${[]}::uuid[], 'BROLL', ${json(edits)}, now())
    RETURNING id`;
  const at = input.afterSceneId ? order.indexOf(input.afterSceneId) : -1;
  order.splice(at < 0 ? order.length : at + 1, 0, scene!.id);
  await normalizeOrder(projectId, order);
  await placeBackground(workspaceId, projectId, scene!.id, project.aspect as Aspect, input.background, input.seconds, description);
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

/** Turns any scene into a card or changes a card's background (renders a new background take). */
export async function setCardBackground(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, background: CardBackground) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const [scene] = await sql<{ id: string; durationSec: number; description: string; edits: unknown }[]>`
    SELECT id, duration_sec, description, edits FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  if (parseEdits(scene.edits).texts.length === 0) throw AppError.badRequest('Add the card’s text first (Text on this clip), then pick its background.');
  await placeBackground(workspaceId, projectId, sceneId, project.aspect as Aspect, background, Math.max(1, Math.min(60, scene.durationSec)), scene.description);
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}
