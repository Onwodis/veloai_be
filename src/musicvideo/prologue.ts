/**
 * The cold open: a short film VeloBot directs to play BEFORE the song, the
 * way big music videos open on a scene (a phone call, a memory, a street at
 * night) before the beat drops. It does not act out the scenes: it sets the
 * story up.
 *
 *   plan     VeloBot writes 2-5 shots (3-8 s each, 10-45 s in all): what the
 *            camera sees, the voice-over line, an on-screen text (place /
 *            year / a quote) and a film effect per shot, a narrator voice and
 *            a sound bed. The artist edits anything.
 *   film     each shot: an identity-locked first frame of the cast in it
 *            (same keyframe model as the takes), animated by the image-to-
 *            video model (text-to-video when nobody is in it); the voice-over
 *            by text to speech.
 *   render   shots cut to length, framed, effects applied, the on-screen text
 *            typed in, the voice-over placed on each shot with a bed under it
 *            (the song's intro muffled "through a wall", room tone, or
 *            silence), faded in and out, watermarked like every video.
 *   master   the clip plays first, before any titles on black and the song.
 * Tokens: the plan like a storyboard; the film is held up front (keyframes +
 * video seconds + voice) and only what was made is charged.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ffmpeg, filterPath, probe, canBurnSubtitles } from '../media/ffmpeg.js';
import { projectWatermarked, WATERMARK_FILE, watermarkFilters } from '../media/watermark.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { deleteObject, downloadToFile, keys, readUrl, uploadFile } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { ASPECTS, keyframePrompt, motionPrompt, negativePrompt, SHOT_IDS, type PromptInput, type Shot } from '../studio/cinema.js';
import { parse } from '../studio/director.js';
import * as fal from '../studio/fal.js';
import { conformImage, downloadUrl, thumbnail } from '../studio/files.js';
import { getStudioSettings, pickDuration } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { AssetRow } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { ENGINE_NAME } from '../utils/engineName.js';
import { logger } from '../utils/logger.js';
import type { CharacterRow } from './cast.js';
import { contextText } from './director.js';
import { access, charged, directorContext, load } from './service.js';
import { header, revealWords } from './titles.js';

/* ------------------------------------------------------------------ the plan */

export const EFFECTS = {
  none: 'Clean, no effect',
  'film-burn': 'Old film: warm flicker, grain, a burn-in from white',
  'slow-push': 'A slow push-in on the frame',
  'flash-cut': 'Flash cut: in and out through white',
  glitch: 'Digital glitch: colour split and noise',
  'light-leak': 'Warm light leak across the frame',
  'black-white': 'Black and white, a touch of contrast',
  vhs: 'VHS home video: noise, colour bleed',
  'dream-blur': 'Dreamy soft focus (a memory)',
  letterbox: 'Wide letterbox bars',
} as const;
export type Effect = keyof typeof EFFECTS;
const EFFECT_IDS = Object.keys(EFFECTS) as [Effect, ...Effect[]];

export const NARRATORS = {
  'deep-male': { label: 'Deep male narrator', voice: 'Brian' },
  'warm-female': { label: 'Warm female narrator', voice: 'Charlotte' },
  'young-male': { label: 'Young man', voice: 'Liam' },
  'young-female': { label: 'Young woman', voice: 'Jessica' },
  elder: { label: 'Older voice', voice: 'Bill' },
  soft: { label: 'Soft, close whisper', voice: 'Lily' },
} as const;
export type Narrator = keyof typeof NARRATORS;
const NARRATOR_IDS = Object.keys(NARRATORS) as [Narrator, ...Narrator[]];

export const BEDS = { 'song-muffled': 'The song’s opening, muffled as if through a wall', 'room-tone': 'Quiet room tone', silence: 'Silence (voice only)' } as const;
export type Bed = keyof typeof BEDS;

export const shotSchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  seconds: z.number().min(3).max(8),
  narration: z.string().trim().max(240),
  prompt: z.string().trim().min(10).max(1200),
  shot: z.enum(SHOT_IDS),
  characterIds: z.array(z.uuid()).max(4),
  effect: z.enum(EFFECT_IDS),
  text: z.string().trim().max(80),
});
export const planSchema = z.strictObject({
  logline: z.string().trim().max(400),
  narrator: z.enum(NARRATOR_IDS),
  bed: z.enum(['song-muffled', 'room-tone', 'silence']),
  shots: z.array(shotSchema).min(1).max(5),
});
export type ProloguePlan = z.infer<typeof planSchema>;

export const PlanSchema = z.object({
  logline: z.string().describe('One sentence: the story the cold open sets up'),
  narrator: z.enum(NARRATOR_IDS).describe('The voice that suits the story and the artist'),
  bed: z.enum(['song-muffled', 'room-tone', 'silence']).describe('Sound under the voice'),
  shots: z
    .array(
      z.object({
        seconds: z.number().describe('3-8 s on screen'),
        narration: z.string().describe('The voice-over line on this shot (spoken), at most about 2.3 words per second of the shot; empty for a silent beat'),
        prompt: z.string().describe("What the camera sees, written like a DP: one clear action, the place, real light, wardrobe, subtle camera. 40-90 words. Nobody sings; describe faces only by expression (identity comes from the cast's photos)."),
        shot: z.enum(SHOT_IDS),
        characterIndexes: z.array(z.number().int()).describe('Indexes (C0, C1…) of the cast in the shot; empty for places and details'),
        effect: z.enum(EFFECT_IDS).describe(`One per shot, used with taste: ${Object.entries(EFFECTS).map(([id, text]) => `${id} (${text})`).join('; ')}`),
        text: z.string().describe('Short on-screen text typed in on this shot (a place and year like "LAGOS, 2009", a time, a quote), or empty. Use on 1-2 shots at most.'),
      }),
    )
    .describe('2-5 shots'),
});

const SYSTEM = (seconds: number): string =>
  'You are a music-video director writing the COLD OPEN: a short film that plays before the song starts, the way great music videos open on a scene before the beat. ' +
  'It does not act out the video; it sets up the story or the world (a phone call, a memory, a street at night, a letter being read, the moment before everything changes) and hands over to the song with a question or a feeling. ' +
  `Aim for about ${seconds} seconds over 2-5 shots. A voice-over tells it (text to speech): short, spoken, specific, in the artist's language and slang when the song uses them, never cheesy; leave a shot silent when the picture says enough. ` +
  'Pick one film effect per shot with taste (most shots clean or one consistent look; a flash or glitch only on a turn). Real places, real light, the cast from their photos. ' +
  'Never sexual, never minors in danger, no real people named.';

/** The director call itself (no charge, no save): exported so it can be checked on a real project. */
export function draftPrologue(context: Awaited<ReturnType<typeof directorContext>>, idea: string | undefined, seconds: number) {
  return parse('music-video', PlanSchema, SYSTEM(seconds), [
    { type: 'text', text: `${contextText(context)}\n\n<cold_open_idea>${idea?.trim() || 'Your call: what opening would make this video unforgettable?'}</cold_open_idea>` },
  ]);
}

/** VeloBot writes the cold open. */
export async function planPrologue(auth: AuthContext, workspaceId: string, projectId: string, input: { idea?: string | undefined; seconds: number }) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  const context = await directorContext(project, mv);
  const seconds = Math.max(10, Math.min(45, input.seconds));
  const { costs } = await getStudioSettings();
  const { data } = await charged(auth, workspaceId, projectId, 'MV_STORYBOARD', costs.mvStoryboard, `Music video · ${project.title.slice(0, 50)}: cold open plan`, () =>
    draftPrologue(context, input.idea, seconds),
  );
  const plan: ProloguePlan = {
    logline: data.logline.slice(0, 400),
    narrator: data.narrator,
    bed: data.bed,
    shots: data.shots.slice(0, 5).map((shot) => ({
      id: randomUUID().slice(0, 8),
      seconds: Math.max(3, Math.min(8, Math.round(shot.seconds * 2) / 2)),
      narration: shot.narration.slice(0, 240),
      prompt: shot.prompt.slice(0, 1200),
      shot: shot.shot,
      characterIds: [...new Set(shot.characterIndexes)].flatMap((index) => (context.characters[index] ? [context.characters[index]!.id] : [])).slice(0, 4),
      effect: shot.effect,
      text: shot.text.slice(0, 80),
    })),
  };
  await sql`
    INSERT INTO mv_prologues (project_id, workspace_id, plan, status, step, progress, error)
    VALUES (${projectId}, ${workspaceId}, ${json(plan)}, 'DRAFT', '', 0, NULL)
    ON CONFLICT (project_id) DO UPDATE SET plan = EXCLUDED.plan, status = CASE WHEN mv_prologues.status = 'FILMING' THEN mv_prologues.status ELSE 'DRAFT' END, error = NULL, updated_at = now()`;
  return prologueView(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ view + edits */

interface PrologueRow {
  projectId: string;
  plan: Partial<ProloguePlan>;
  enabled: boolean;
  status: 'DRAFT' | 'FILMING' | 'READY' | 'FAILED';
  step: string;
  progress: number;
  error: string | null;
  outputKey: string | null;
  thumbKey: string | null;
  durationSec: number | null;
  tokens: number;
  updatedAt: Date;
}

/** Tokens to film the plan (held up front; only what is made is charged). */
async function filmCost(plan: ProloguePlan): Promise<number> {
  const { costs } = await getStudioSettings();
  const words = plan.shots.reduce((sum, shot) => sum + (shot.narration.trim() ? shot.narration.trim().split(/\s+/).length : 0), 0);
  const speech = Math.ceil(words / 2.5);
  return plan.shots.reduce((sum, shot) => sum + (shot.characterIds.length ? costs.keyframe : 0) + Math.ceil(Math.max(5, shot.seconds)) * costs.videoPerSecond, 0) + Math.max(words ? 1 : 0, speech) * costs.ttsPerSecond;
}

export async function prologueView(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, false);
  await load(workspaceId, projectId);
  const [row] = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE project_id = ${projectId}`;
  const { costs } = await getStudioSettings();
  if (!row) return { prologue: null, costs: { plan: costs.mvStoryboard } };
  const plan = planSchema.safeParse(row.plan);
  return {
    prologue: {
      plan: plan.success ? plan.data : null,
      enabled: row.enabled,
      status: row.status,
      step: row.step,
      progress: row.progress,
      error: row.error,
      videoUrl: row.outputKey ? await readUrl(row.outputKey) : null,
      thumbUrl: row.thumbKey ? await readUrl(row.thumbKey) : null,
      durationSec: row.durationSec,
      tokens: row.tokens,
      filmTokens: plan.success ? await filmCost(plan.data) : null,
      updatedAt: row.updatedAt.toISOString(),
    },
    costs: { plan: costs.mvStoryboard },
  };
}

export async function savePrologue(auth: AuthContext, workspaceId: string, projectId: string, input: { plan?: ProloguePlan | undefined; enabled?: boolean | undefined }) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [row] = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE project_id = ${projectId}`;
  if (!row) throw AppError.badRequest('Ask VeloBot for a cold open first (or write one).');
  if (row.status === 'FILMING' && input.plan) throw AppError.conflict('The cold open is being filmed: wait for it to finish.');
  if (input.plan) {
    const cast = new Set((await sql<{ id: string }[]>`SELECT id FROM mv_characters WHERE project_id = ${projectId}`).map((item) => item.id));
    const plan = { ...input.plan, shots: input.plan.shots.map((shot) => ({ ...shot, characterIds: shot.characterIds.filter((id) => cast.has(id)) })) };
    await sql`UPDATE mv_prologues SET plan = ${json(plan)}, updated_at = now() WHERE project_id = ${projectId}`;
  }
  if (input.enabled !== undefined) await sql`UPDATE mv_prologues SET enabled = ${input.enabled}, updated_at = now() WHERE project_id = ${projectId}`;
  return prologueView(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ film + render */

const setProgress = (projectId: string, step: string, progress: number): Promise<unknown> =>
  sql`UPDATE mv_prologues SET step = ${step.slice(0, 80)}, progress = ${progress}, updated_at = now() WHERE project_id = ${projectId}`;

export async function filmPrologue(auth: AuthContext, workspaceId: string, projectId: string, dryRun: boolean) {
  await access(auth, workspaceId, true);
  const { project } = await load(workspaceId, projectId);
  const [row] = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE project_id = ${projectId}`;
  const parsed = planSchema.safeParse(row?.plan);
  if (!row || !parsed.success) throw AppError.badRequest('Ask VeloBot for a cold open first.');
  const tokens = await filmCost(parsed.data);
  if (dryRun) return { estimate: { tokens } };
  if (row.status === 'FILMING') throw AppError.conflict('The cold open is already being filmed.');
  if (!fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', `Video generation is not switched on yet (the ${ENGINE_NAME} is not connected).`);
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_TAKES', tokens, { projectId, prologue: true });
  await sql`UPDATE mv_prologues SET status = 'FILMING', step = 'Starting', progress = 0, error = NULL, updated_at = now() WHERE project_id = ${projectId}`;
  void (async () => {
    let spent = 0;
    try {
      spent = await runPrologue(workspaceId, projectId, project.aspect as keyof typeof ASPECTS, project.brief.style ?? '', parsed.data, (amount) => {
        spent += amount;
      });
      await settleSystem(reservation.id, workspaceId, spent, `Music video · ${project.title.slice(0, 50)}: cold open`);
      if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${spent} WHERE id = ${projectId}`;
      await sql`UPDATE mv_prologues SET tokens = tokens + ${spent} WHERE project_id = ${projectId}`;
    } catch (error) {
      logger.error({ err: error, projectId }, 'cold open failed');
      // What was already made (paid model calls) is charged; the rest of the hold goes back.
      if (spent > 0) await settleSystem(reservation.id, workspaceId, spent, `Music video · ${project.title.slice(0, 50)}: cold open (stopped)`).catch(() => undefined);
      else await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
      await sql`UPDATE mv_prologues SET status = 'FAILED', error = ${(error instanceof Error ? error.message : String(error)).slice(0, 600)}, updated_at = now() WHERE project_id = ${projectId}`.catch(() => undefined);
    }
  })();
  return { estimate: { tokens } };
}

function effectFilters(effect: Effect, seconds: number, size: { width: number; height: number }): string[] {
  switch (effect) {
    case 'film-burn':
      return ['colorbalance=rs=0.12:gs=0.04:bs=-0.1', 'noise=c0s=14:c0f=t+u', 'vignette=angle=PI/4', "eq=brightness='0.035*sin(t*11)':eval=frame", 'fade=t=in:st=0:d=0.5:color=white'];
    case 'slow-push':
      return [`zoompan=z='min(1+0.0018*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size.width}x${size.height}:fps=24`];
    case 'flash-cut':
      return ['fade=t=in:st=0:d=0.25:color=white', `fade=t=out:st=${Math.max(0, seconds - 0.25).toFixed(2)}:d=0.25:color=white`];
    case 'glitch':
      return ['rgbashift=rh=-8:bh=8', 'noise=alls=12:allf=t'];
    case 'light-leak':
      return ['colorbalance=rs=0.18:gs=0.06:bs=-0.12', 'curves=preset=lighter', 'vignette=angle=PI/5'];
    case 'black-white':
      return ['hue=s=0', 'eq=contrast=1.15:brightness=-0.02'];
    case 'vhs':
      return ['noise=alls=18:allf=t', 'eq=saturation=1.35:contrast=1.1', 'rgbashift=rh=3:bh=-3', 'boxblur=1:1'];
    case 'dream-blur':
      return ['gblur=sigma=2.2', 'eq=brightness=0.04:saturation=0.8'];
    case 'letterbox':
      return ['drawbox=x=0:y=0:w=iw:h=ih*0.12:color=black:t=fill', 'drawbox=x=0:y=ih*0.88:w=iw:h=ih*0.12:color=black:t=fill'];
    default:
      return [];
  }
}

function audioUrl(result: unknown): string {
  const body = result as { audio?: { url?: string }; audio_url?: string | { url?: string }; url?: string };
  const url = body.audio?.url ?? (typeof body.audio_url === 'string' ? body.audio_url : body.audio_url?.url) ?? body.url;
  if (!url) throw new Error('The voice engine returned no audio.');
  return url;
}

/** Makes every shot, records the voice, renders the clip. Returns the tokens spent. */
async function runPrologue(
  workspaceId: string,
  projectId: string,
  aspect: keyof typeof ASPECTS,
  style: string,
  plan: ProloguePlan,
  onSpend: (amount: number) => void,
): Promise<number> {
  const settings = await getStudioSettings();
  const { models, costs } = settings;
  const size = ASPECTS[aspect];
  const cast = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId}`;
  const [mv] = await sql<{ direction: unknown; voice: unknown }[]>`SELECT direction, lyrics -> 'voice' AS voice FROM mv_projects WHERE project_id = ${projectId}`;
  const { parseDirection, placeText } = await import('./songmap.js');
  const place = mv ? placeText(parseDirection(mv.direction), (mv.voice ?? null) as Parameters<typeof placeText>[1]) : '';
  const dir = await mkdtemp(join(tmpdir(), 'mv-prologue-'));
  let spent = 0;
  const spend = (amount: number): void => {
    spent += amount;
  };
  try {
    const run = async (endpoint: string, input: Record<string, unknown>): Promise<unknown> => fal.wait(await fal.submit(endpoint, input), { timeoutMs: 15 * 60_000 });
    const clips: string[] = [];
    for (const [index, shot] of plan.shots.entries()) {
      await setProgress(projectId, `Filming shot ${index + 1} of ${plan.shots.length}`, 0.05 + (index / plan.shots.length) * 0.65);
      const people = cast.filter((character) => shot.characterIds.includes(character.id) && character.referenceKeys.length);
      const input: PromptInput = {
        scene: shot.prompt,
        shot: shot.shot as Shot,
        style,
        identity: people.map((person) => `${person.name}: ${person.prompt}`).join(' ').slice(0, 900) || undefined,
        featuresSubject: people.length > 0,
        aspect,
        place: place || undefined,
        musicVideo: false,
      };
      let frameUrl: string | null = null;
      if (people.length && models.keyframe.enabled) {
        const references = people.flatMap((person) => person.referenceKeys.slice(0, people.length > 1 ? 2 : 4)).slice(0, 5);
        const result = await run(models.keyframe.endpoint, { ...models.keyframe.extra, prompt: keyframePrompt(input), image_urls: await Promise.all(references.map((key) => readUrl(key))) });
        spend(costs.keyframe);
        const raw = join(dir, `frame-${index}-raw`);
        await downloadUrl(fal.outputUrl(result, 'image'), raw);
        const framed = join(dir, `frame-${index}.png`);
        await conformImage(raw, framed, size.width, size.height);
        const key = `${keys.studio(workspaceId, projectId)}/prologue/frame-${index}-${randomUUID().slice(0, 6)}.png`;
        await uploadFile(key, framed, 'image/png');
        frameUrl = await readUrl(key);
      }
      const model = frameUrl ? models.imageToVideo : models.textToVideo;
      if (!model.enabled) throw new Error(`The ${frameUrl ? 'image' : 'text'}-to-video model is switched off in the console.`);
      const duration = pickDuration(model, shot.seconds);
      const result = await run(model.endpoint, {
        ...model.extra,
        prompt: motionPrompt(input),
        negative_prompt: negativePrompt(false),
        ...(duration.param ? { duration: duration.param } : {}),
        ...(frameUrl ? { image_url: frameUrl } : { aspect_ratio: size.model }),
      });
      spend(Math.ceil(duration.seconds) * costs.videoPerSecond);
      const file = join(dir, `shot-${index}.mp4`);
      await downloadUrl(fal.outputUrl(result, 'video'), file);
      clips.push(file);
    }

    // The voice-over: one line per shot, in the narrator's voice.
    await setProgress(projectId, 'Recording the voice-over', 0.75);
    const tts = models.tts;
    const { voices: rawMapping, ...ttsExtra } = tts.extra as Record<string, unknown>;
    const mapping = Object.fromEntries(Object.entries((rawMapping ?? {}) as Record<string, string>).map(([key, value]) => [key.trim().toLowerCase(), value]));
    const voice = mapping[plan.narrator] ?? mapping['narrator'] ?? NARRATORS[plan.narrator].voice;
    const lines: { file: string; at: number }[] = [];
    let at = 0;
    for (const [index, shot] of plan.shots.entries()) {
      if (shot.narration.trim() && tts.enabled) {
        const result = await run(tts.endpoint, { ...ttsExtra, text: shot.narration.trim(), voice });
        const file = join(dir, `line-${index}.mp3`);
        await downloadUrl(audioUrl(result), file);
        const { durationSec } = await probe(file);
        spend(Math.max(1, Math.ceil(durationSec)) * costs.ttsPerSecond);
        lines.push({ file, at: at + 0.35 });
      }
      at += shot.seconds;
    }
    const total = at;

    // Each shot: cut to length, framed, its effect.
    await setProgress(projectId, 'Cutting and grading', 0.85);
    const parts: string[] = [];
    for (const [index, shot] of plan.shots.entries()) {
      const part = join(dir, `part-${index}.mp4`);
      const fx = effectFilters(shot.effect, shot.seconds, size);
      await ffmpeg([
        '-i', clips[index]!,
        '-t', shot.seconds.toFixed(3),
        '-vf', [`scale=${size.width}:${size.height}:force_original_aspect_ratio=increase`, `crop=${size.width}:${size.height}`, 'fps=24', 'setsar=1', ...fx, 'format=yuv420p'].join(','),
        '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', part,
      ]);
      // Freeze the last frame when the model's clip ran short of the planned length.
      const length = (await probe(part)).durationSec;
      if (length < shot.seconds - 0.1) {
        const padded = join(dir, `part-${index}-pad.mp4`);
        await ffmpeg(['-i', part, '-vf', `tpad=stop_mode=clone:stop_duration=${(shot.seconds - length).toFixed(3)}`, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', padded]);
        parts.push(padded);
      } else {
        parts.push(part);
      }
    }
    const list = join(dir, 'list.txt');
    await writeFile(list, parts.map((part) => `file '${part.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const joined = join(dir, 'joined.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

    // On-screen text, typed in on its shot.
    const ass = join(dir, 'text.ass');
    let start = 0;
    const events: string[] = [];
    for (const shot of plan.shots) {
      if (shot.text.trim()) events.push(revealWords(shot.text.trim().toUpperCase(), start + 0.4, Math.max(1.5, shot.seconds - 0.6)));
      start += shot.seconds;
    }
    const withText = events.length > 0 && (await writeFile(ass, [...header(size, 'typewriter'), ...events, ''].join('\n'), 'utf8').then(() => canBurnSubtitles(ass).catch(() => false)));

    // Sound: the bed, the voice-over on top (the bed dips under the voice).
    await setProgress(projectId, 'Mixing the voice-over', 0.92);
    const inputs: string[] = ['-i', joined];
    const graph: string[] = [];
    const audioLabels: string[] = [];
    if (plan.bed === 'song-muffled') {
      const [music] = await sql<AssetRow[]>`SELECT a.* FROM studio_assets a JOIN studio_projects p ON p.music_asset_id = a.id WHERE p.id = ${projectId}`;
      if (music) {
        const song = join(dir, 'song');
        await downloadToFile(music.key, song);
        inputs.push('-i', song);
        graph.push(`[${inputs.length / 2 - 1}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,lowpass=f=650,volume=-17dB,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[bed]`);
        audioLabels.push('[bed]');
      }
    } else if (plan.bed === 'room-tone') {
      inputs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anoisesrc=color=brown:amplitude=0.02:sample_rate=48000');
      graph.push(`[${inputs.filter((value) => value === '-i').length - 1}:a]aformat=channel_layouts=stereo,lowpass=f=900,volume=-6dB,afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 1).toFixed(2)}:d=1[bed]`);
      audioLabels.push('[bed]');
    }
    for (const [index, line] of lines.entries()) {
      inputs.push('-i', line.file);
      const input = inputs.filter((value) => value === '-i').length - 1;
      const delay = Math.round(line.at * 1000);
      graph.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,acompressor=threshold=-18dB:ratio=2.5:attack=5:release=120,adelay=${delay}|${delay}[vo${index}]`);
      audioLabels.push(`[vo${index}]`);
    }
    if (audioLabels.length) graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
    else graph.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${total.toFixed(3)}[aout]`);

    // Picture: text, a fade in from black and out to black, the watermark when the project has one.
    const watermark = await projectWatermarked(projectId);
    const picture = [...(withText ? [`subtitles=${filterPath(ass)}`] : []), 'fade=t=in:st=0:d=0.6', `fade=t=out:st=${Math.max(0, total - 0.6).toFixed(2)}:d=0.6`, 'format=yuv420p'];
    graph.push(`[0:v]${picture.join(',')}[pic]`);
    let videoLabel = '[pic]';
    if (watermark) {
      inputs.push('-loop', '1', '-i', WATERMARK_FILE);
      const mark = watermarkFilters('[pic]', inputs.filter((value) => value === '-i').length - 1, size, 'wm');
      graph.push(...mark.graph);
      videoLabel = mark.label;
    }
    const output = join(dir, 'prologue.mp4');
    await ffmpeg([
      ...inputs,
      '-filter_complex', graph.join(';'),
      '-map', videoLabel, '-map', '[aout]',
      '-t', total.toFixed(3), '-r', '24',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', output,
    ]);
    const thumb = join(dir, 'thumb.jpg');
    await thumbnail(output, thumb, Math.min(1.5, total / 2));

    await setProgress(projectId, 'Saving', 0.98);
    const stamp = randomUUID().slice(0, 8);
    const outputKey = `${keys.studio(workspaceId, projectId)}/prologue/cold-open-${stamp}.mp4`;
    const thumbKey = `${keys.studio(workspaceId, projectId)}/prologue/cold-open-${stamp}.jpg`;
    await uploadFile(outputKey, output, 'video/mp4');
    await uploadFile(thumbKey, thumb, 'image/jpeg');
    const [previous] = await sql<{ outputKey: string | null; thumbKey: string | null }[]>`SELECT output_key, thumb_key FROM mv_prologues WHERE project_id = ${projectId}`;
    await sql`
      UPDATE mv_prologues SET status = 'READY', step = 'Ready', progress = 1, error = NULL, output_key = ${outputKey}, thumb_key = ${thumbKey},
        duration_sec = ${+total.toFixed(3)}, enabled = true, updated_at = now()
      WHERE project_id = ${projectId}`;
    for (const key of [previous?.outputKey, previous?.thumbKey]) if (key && key !== outputKey && key !== thumbKey) await deleteObject(key).catch(() => undefined);
    return spent;
  } catch (error) {
    // Let the caller charge what was already made.
    onSpend(spent);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The finished cold open for the master (null when there is none, or it is switched off). */
export async function readyPrologue(projectId: string): Promise<{ key: string; seconds: number } | null> {
  const [row] = await sql<{ outputKey: string | null; durationSec: number | null; enabled: boolean; status: string }[]>`
    SELECT output_key, duration_sec, enabled, status FROM mv_prologues WHERE project_id = ${projectId}`;
  if (!row?.enabled || row.status !== 'READY' || !row.outputKey || !row.durationSec) return null;
  return { key: row.outputKey, seconds: row.durationSec };
}
