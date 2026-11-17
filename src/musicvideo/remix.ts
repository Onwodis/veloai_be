/**
 * Remix studio: the artist uploads a music video clip and gets a new short
 * clip of its main character, built on a normal music video project (so the
 * identity lock, lip sync, beat sync, cast and location, mixer and Quick mix &
 * master all apply). Two modes:
 *
 *   NEW      the clip's main character is cast from the clip itself (a
 *            performance video: face, build, how they sing). The song is the
 *            clip's own audio or an uploaded one, cut to the chosen window.
 *            VeloBot writes 2-4 scenes from the artist's script, timed to the
 *            window; with "shoot now" every scene is filmed straight away.
 *   REFINE   the clip's own footage, cut into shots of 3-10 s, refined with
 *            the video-edit model as the script says (cleaner light, wardrobe,
 *            background, artifacts…): motion, timing and the mouth are kept,
 *            so the lip sync stays true to the song.
 *
 * Set-up runs in the background (lyrics, casting and planning take a minute
 * or two); the page polls GET /remix. Every paid step is token-gated as in
 * the studio, and the estimate is shown before anything starts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, probe } from '../media/ffmpeg.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { downloadToFile, keys, uploadFile } from '../services/storage.service.js';
import * as studio from '../studio/service.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { AssetRow, TakeSpec } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import type { CharacterRow } from './cast.js';
import { access, buildMix, buildStoryboard, castOne, load, startSequence, transcribeLyrics, type Stage } from './service.js';

export const WINDOW_MIN = 5;
export const WINDOW_MAX = 30;

export interface RemixInput {
  mode: 'NEW' | 'REFINE';
  script: string;
  sourceAssetId: string;
  /** null / missing = the clip's own audio. */
  audioAssetId?: string | null | undefined;
  windowStart: number;
  windowLength: number;
  artistName: string;
  genre?: string | undefined;
  /** NEW: film every scene as soon as it is planned. */
  shootNow?: boolean | undefined;
  /** The artist confirmed they are the person in the clip or have their permission. */
  consent: boolean;
}

interface RemixRow {
  projectId: string;
  workspaceId: string;
  mode: 'NEW' | 'REFINE';
  script: string;
  sourceAssetId: string;
  audioAssetId: string | null;
  windowStart: number;
  windowLength: number;
  options: { shootNow?: boolean; genre?: string; artistName?: string; ip?: string | null };
  status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  step: string;
  progress: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Shots the window is cut into: each 3-10 s (the video models' range). */
export function windowShots(length: number, mode: RemixInput['mode']): number[] {
  const count = mode === 'REFINE' ? Math.max(1, Math.ceil(length / 10)) : Math.min(4, Math.max(2, Math.round(length / 8)));
  const each = length / count;
  return Array.from({ length: count }, (_, index) => +(index === count - 1 ? length - each * (count - 1) : each).toFixed(2));
}

/** Tokens the remix is expected to cost (shown before anything starts; "about" for the AI steps). */
export async function remixEstimate(input: { mode: RemixInput['mode']; windowLength: number; songSeconds: number; shootNow: boolean }) {
  const { costs, models } = await getStudioSettings();
  const length = Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, input.windowLength));
  const shots = windowShots(length, input.mode);
  const setup = {
    lyrics: costs.mvLyricsPerMinute * Math.max(1, Math.ceil(input.songSeconds / 60)),
    casting: costs.mvCasting,
    mix: costs.mvMix,
    planning: input.mode === 'NEW' ? costs.mvStoryboard : 0,
  };
  // NEW + shoot now: every scene filmed once (keyframe + video), lip sync on roughly half the time.
  const filming =
    input.mode === 'REFINE'
      ? shots.reduce((sum, seconds) => sum + Math.ceil(seconds) * costs.videoEditPerSecond, 0)
      : input.shootNow
        ? shots.length * costs.keyframe + Math.ceil(length) * costs.videoPerSecond + Math.ceil(length * 0.5) * (models.lipSync.enabled ? costs.lipSyncPerSecond : 0)
        : 0;
  const total = setup.lyrics + setup.casting + setup.mix + setup.planning + filming;
  return { shots, setup, filming, total };
}

async function setStatus(projectId: string, patch: Partial<Pick<RemixRow, 'status' | 'step' | 'progress' | 'error'>>): Promise<void> {
  await sql`
    UPDATE mv_remixes SET
      status = COALESCE(${patch.status ?? null}, status),
      step = COALESCE(${patch.step ?? null}, step),
      progress = COALESCE(${patch.progress ?? null}, progress),
      error = ${patch.error === undefined ? sql`error` : patch.error},
      updated_at = now()
    WHERE project_id = ${projectId}`;
}

const setStage = (projectId: string, stage: Stage, approved: Stage[]): Promise<unknown> => {
  const at = new Date().toISOString();
  return sql`UPDATE mv_projects SET stage = ${stage}, approvals = approvals || ${json(Object.fromEntries(approved.map((key) => [key, at])))}, updated_at = now() WHERE project_id = ${projectId}`;
};

export async function remixView(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, false);
  await load(workspaceId, projectId);
  const [row] = await sql<RemixRow[]>`SELECT * FROM mv_remixes WHERE project_id = ${projectId}`;
  if (!row) return { remix: null };
  return {
    remix: {
      mode: row.mode,
      script: row.script,
      sourceAssetId: row.sourceAssetId,
      audioAssetId: row.audioAssetId,
      windowStart: row.windowStart,
      windowLength: row.windowLength,
      shootNow: Boolean(row.options.shootNow),
      status: row.status,
      step: row.step,
      progress: row.progress,
      error: row.error,
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

/** Validates, records the remix and starts the set-up in the background. */
export async function startRemix(auth: AuthContext, workspaceId: string, projectId: string, input: RemixInput, ip: string | null) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  if (mv.stage !== 'SONG') throw AppError.badRequest('This project is already past set-up: open it in the studio instead.');
  if (!input.consent) throw AppError.badRequest('Confirm you are the person in the clip, or have their permission, before their likeness is used.');
  const script = input.script.trim();
  if (script.length < 20) throw AppError.badRequest('Write the script: what should happen in the new clip (a few sentences).');
  const [source] = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${input.sourceAssetId} AND project_id = ${projectId} AND role = 'VIDEO' AND status = 'READY'`;
  if (!source) throw AppError.badRequest('Upload the music video clip first.');
  const audio = input.audioAssetId
    ? (await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${input.audioAssetId} AND project_id = ${projectId} AND role = 'MUSIC' AND status = 'READY'`)[0]
    : undefined;
  if (input.audioAssetId && !audio) throw AppError.badRequest('That audio file is not in this project (upload it again).');
  const sourceSeconds = source.meta.durationSec ?? 0;
  const songSeconds = audio ? (audio.meta.durationSec ?? 0) : sourceSeconds;
  const length = Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, input.windowLength));
  const start = Math.max(0, input.windowStart);
  if (songSeconds && start + length > songSeconds + 0.25) throw AppError.badRequest(`The chosen part runs past the end of the ${audio ? 'song' : 'clip'} (${songSeconds.toFixed(1)} s).`);
  // Refining edits the clip's own footage: the window must sit inside the clip.
  if (input.mode === 'REFINE' && sourceSeconds && start + length > sourceSeconds + 0.25) throw AppError.badRequest(`Refining works on the clip itself: choose a part inside its ${sourceSeconds.toFixed(1)} s.`);
  if (input.mode === 'REFINE' && length < 3) throw AppError.badRequest('Refine at least 3 seconds.');

  await sql`
    INSERT INTO mv_remixes (project_id, workspace_id, created_by_id, mode, script, source_asset_id, audio_asset_id, window_start, window_length, options, status, step, progress)
    VALUES (${projectId}, ${workspaceId}, ${auth.userId}, ${input.mode}, ${script.slice(0, 4000)}, ${source.id}, ${audio?.id ?? null}, ${start}, ${length},
      ${json({ shootNow: Boolean(input.shootNow), genre: input.genre?.trim() ?? '', artistName: input.artistName.trim(), ip })}, 'RUNNING', 'Starting', 0)
    ON CONFLICT (project_id) DO UPDATE SET mode = EXCLUDED.mode, script = EXCLUDED.script, source_asset_id = EXCLUDED.source_asset_id, audio_asset_id = EXCLUDED.audio_asset_id,
      window_start = EXCLUDED.window_start, window_length = EXCLUDED.window_length, options = EXCLUDED.options, status = 'RUNNING', step = 'Starting', progress = 0, error = NULL, updated_at = now()`;
  await sql`UPDATE studio_projects SET title = ${project.title}, updated_at = now() WHERE id = ${projectId}`;
  void runRemix(auth, workspaceId, projectId).catch(async (error: unknown) => {
    logger.error({ err: error, projectId }, 'remix set-up failed');
    await setStatus(projectId, { status: 'FAILED', error: (error instanceof Error ? error.message : String(error)).slice(0, 600) }).catch(() => undefined);
  });
  return remixView(auth, workspaceId, projectId);
}

/** Extracts the clip's audio as the project's song (AAC 256k, 48 kHz stereo). */
async function songFromClip(workspaceId: string, projectId: string, source: AssetRow): Promise<AssetRow> {
  const dir = await mkdtemp(join(tmpdir(), 'remix-audio-'));
  try {
    const video = join(dir, 'clip');
    await downloadToFile(source.key, video);
    const out = join(dir, 'song.m4a');
    await ffmpeg(['-i', video, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '256k', out]);
    const { durationSec } = await probe(out);
    const [asset] = await sql<AssetRow[]>`
      INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta, status)
      VALUES (${projectId}, ${workspaceId}, 'MUSIC', '', ${`${source.name.replace(/\.[a-z0-9]+$/i, '')} (audio).m4a`.slice(0, 200)}, 'audio/mp4', 0,
        ${json({ durationSec: +durationSec.toFixed(3), fromClip: source.id })}, 'PENDING') RETURNING *`;
    const key = keys.studioAsset(workspaceId, projectId, asset!.id, 'song.m4a');
    await uploadFile(key, out, 'audio/mp4');
    await sql`UPDATE studio_assets SET key = ${key}, status = 'READY' WHERE id = ${asset!.id}`;
    return { ...asset!, key, status: 'READY' };
  } catch (error) {
    throw AppError.badRequest(`Could not read the audio from the clip (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}). Upload the song separately.`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Waits for the background lyric transcription (it is optional: a failure only means fewer lip-sync cues). */
async function waitForLyrics(projectId: string, limitMs = 6 * 60_000): Promise<boolean> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const [row] = await sql<{ status: string | null }[]>`SELECT lyrics_job ->> 'status' AS status FROM mv_projects WHERE project_id = ${projectId}`;
    if (row?.status === 'DONE') return true;
    if (row?.status === 'FAILED') return false;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

async function runRemix(auth: AuthContext, workspaceId: string, projectId: string): Promise<void> {
  const [remix] = await sql<RemixRow[]>`SELECT * FROM mv_remixes WHERE project_id = ${projectId}`;
  if (!remix) return;
  const { project } = await load(workspaceId, projectId);
  const [source] = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${remix.sourceAssetId}`;
  if (!source) throw AppError.badRequest('The clip is gone: upload it again.');
  const artistName = remix.options.artistName || 'The artist';

  /* 1. The song: the clip's own audio or the uploaded one. */
  await setStatus(projectId, { step: 'Preparing the song', progress: 0.05 });
  const song = remix.audioAssetId ? (await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${remix.audioAssetId}`)[0]! : await songFromClip(workspaceId, projectId, source);
  await sql`UPDATE studio_projects SET music_asset_id = ${song.id}, brief = ${json({ ...project.brief, style: remix.script.slice(0, 600), songStart: 0 })}, updated_at = now() WHERE id = ${projectId}`;
  await sql`
    UPDATE mv_projects SET original_song_id = ${song.id}, artist_name = ${artistName}, genre = ${remix.options.genre || 'Afrobeats'}, vision = ${remix.script.slice(0, 4000)},
      lead_act = 'SOLO', auto_approve = true, updated_at = now()
    WHERE project_id = ${projectId}`;

  /* 2. The words (lip sync needs them; runs in the background, charged per minute of song). */
  await setStatus(projectId, { step: 'Listening to the words', progress: 0.12 });
  try {
    await transcribeLyrics(auth, workspaceId, projectId);
    await waitForLyrics(projectId);
  } catch (error) {
    logger.warn({ err: error, projectId }, 'remix lyrics skipped');
  }

  /* 3. The mix: just the chosen part of the song (one event), so everything is timed to it. */
  await setStatus(projectId, { step: 'Cutting the song to your part', progress: 0.35 });
  const songSeconds = song.meta.durationSec ?? remix.windowStart + remix.windowLength;
  const length = Math.min(remix.windowLength, Math.max(1, songSeconds - remix.windowStart));
  const clip = { id: 'remix-window', src: +remix.windowStart.toFixed(3), len: +length.toFixed(3), at: 0, gainDb: 0, fadeIn: 0.02, fadeOut: Math.min(0.6, length / 6) };
  await sql`UPDATE mv_projects SET audio_edits = ${json({ regions: [], layers: [], clips: [clip] })}, mix_rendered_at = NULL WHERE project_id = ${projectId}`;
  await setStage(projectId, 'SOUND', ['SONG']);
  {
    const loaded = await load(workspaceId, projectId);
    await buildMix(auth, workspaceId, loaded.project, loaded.mv);
  }

  /* 4. The main character, cast from the clip (a performance video: face, build and how they sing). */
  await setStatus(projectId, { step: `Casting ${artistName} from the clip`, progress: 0.5 });
  await setStage(projectId, 'CHARACTERS', ['SOUND']);
  const [character] = await sql<CharacterRow[]>`
    INSERT INTO mv_characters (project_id, position, role, name, is_artist, attributes, costumes, media_asset_ids, consent_at, consent_by, consent_ip)
    VALUES (${projectId}, 0, 'LEAD', ${artistName}, true, '{}'::jsonb, '[]'::jsonb, ARRAY[${source.id}::uuid], now(), ${auth.userId}, ${remix.options.ip ?? null})
    RETURNING *`;
  logger.info({ projectId, characterId: character!.id, userId: auth.userId }, 'remix character consent recorded');
  await castOne(auth, workspaceId, projectId, character!.id);
  await sql`UPDATE mv_characters SET approved_at = now() WHERE id = ${character!.id}`;
  const [cast] = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE id = ${character!.id}`;

  /* 5. The shots. */
  if (remix.mode === 'NEW') {
    await setStatus(projectId, { step: 'VeloBot is writing the scenes', progress: 0.65 });
    await setStage(projectId, 'SCENES', ['CHARACTERS']);
    await buildStoryboard(auth, workspaceId, projectId, windowShots(length, 'NEW').length);
    await setStage(projectId, 'STORYBOARD', ['SCENES', 'DISCUSSION']);
    if (remix.options.shootNow) {
      await setStatus(projectId, { step: 'Filming the scenes', progress: 0.85 });
      await startSequence(auth, workspaceId, projectId);
    }
  } else {
    await setStatus(projectId, { step: 'Refining the footage', progress: 0.65 });
    await setStage(projectId, 'STORYBOARD', ['CHARACTERS', 'SCENES', 'DISCUSSION']);
    await refineShots(auth, workspaceId, projectId, remix, source, cast!, length);
  }
  await setStatus(projectId, { status: 'READY', step: 'Ready', progress: 1, error: null });
}

/**
 * REFINE: the window of the clip becomes 1-3 scenes, each holding its own
 * piece of the original footage as a finished take; each piece is then sent
 * to the video-edit model with the script (a new take, so before / after can
 * be compared and the original kept). Motion, timing and mouth stay.
 */
async function refineShots(auth: AuthContext, workspaceId: string, projectId: string, remix: RemixRow, source: AssetRow, cast: CharacterRow, length: number): Promise<void> {
  const { project } = await load(workspaceId, projectId);
  const shots = windowShots(length, 'REFINE');
  const dir = await mkdtemp(join(tmpdir(), 'remix-refine-'));
  try {
    const video = join(dir, 'clip');
    await downloadToFile(source.key, video);
    let at = remix.windowStart;
    for (const [index, seconds] of shots.entries()) {
      const kind = shots.length === 1 ? 'STORY' : index === 0 ? 'INTRO' : index === shots.length - 1 ? 'OUTRO' : 'STORY';
      const description = `${kind === 'INTRO' ? 'Opening' : kind === 'OUTRO' ? 'Closing' : 'Middle'} part of the original clip, refined: ${remix.script.slice(0, 300)}`;
      const [scene] = await sql<{ id: string }[]>`
        INSERT INTO studio_scenes (project_id, position, kind, description, prompt, shot, transition, duration_sec, features_subject, lip_sync, character_ids, mode, approved_at)
        VALUES (${projectId}, ${index}, ${kind}, ${description.slice(0, 1000)}, ${remix.script.slice(0, 2000)}, 'performance', 'cut', ${seconds}, true, false,
          ARRAY[${cast.id}::uuid], 'PERFORMANCE', now())
        RETURNING id`;
      // The original piece, as a finished take (no generation cost).
      const piece = join(dir, `piece-${index}.mp4`);
      await ffmpeg(['-ss', at.toFixed(3), '-i', video, '-t', seconds.toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', piece]);
      const thumb = join(dir, `piece-${index}.jpg`);
      await ffmpeg(['-ss', '0.5', '-i', piece, '-frames:v', '1', '-q:v', '3', thumb]);
      const spec: TakeSpec = {
        kind: 'MUSIC_VIDEO',
        aspect: project.aspect,
        description,
        prompt: remix.script.slice(0, 2000),
        shot: 'performance',
        durationSec: seconds,
        featuresSubject: true,
        lipSync: false,
        identityKeys: cast.referenceKeys,
        identityElements: [{ name: cast.name, keys: cast.referenceKeys }],
        musicVideo: true,
      };
      const [take] = await sql<{ id: string }[]>`
        INSERT INTO studio_takes (scene_id, project_id, workspace_id, status, spec, cost, settled, engine, finished_at, duration_sec)
        VALUES (${scene!.id}, ${projectId}, ${workspaceId}, 'READY', ${json(spec)}, 0, true, 'original clip', now(), ${seconds})
        RETURNING id`;
      const base = `${keys.studio(workspaceId, projectId)}/takes/${take!.id}`;
      await uploadFile(`${base}/video.mp4`, piece, 'video/mp4');
      await uploadFile(`${base}/thumb.jpg`, thumb, 'image/jpeg');
      await sql`UPDATE studio_takes SET video_key = ${`${base}/video.mp4`}, thumb_key = ${`${base}/thumb.jpg`} WHERE id = ${take!.id}`;
      await sql`UPDATE studio_scenes SET selected_take_id = ${take!.id} WHERE id = ${scene!.id}`;
      // The refined version: a new take on the same scene (charged only when it lands).
      if (seconds >= 3) {
        await studio.postProcessTake(auth, workspaceId, projectId, take!.id, {
          kind: 'custom',
          note: `${remix.script.slice(0, 1500)} Keep ${cast.name}'s face, body, every movement, the timing and the mouth exactly as they are (the singing must stay in sync with the song).`,
          relipSync: false,
        });
      }
      at += seconds;
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
