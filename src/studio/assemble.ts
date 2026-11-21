/**
 * Assembly: joins the chosen take of every scene into the finished film.
 *
 *   ENHANCE    (optional) upscale model over each chosen take
 *   PLAN       frame-exact scene starts (no rounding drift) + transition
 *              handles taken from real footage (never a frozen tail)
 *   CONFORM    each take → exact frame size, 24 fps, exact frame count
 *   JOIN       hard cuts concatenate (no ghost frame); blends are xfades
 *              timed in beats of the song
 *   FINISH     colour look → gentle sharpen → temporal luma grain →
 *              soft vignette → optional 2.39:1 letterbox
 *   SOUND      music video: the song from `songStart`, untouched apart from
 *              fades, when every scene is in the film. When scenes are left
 *              out (or a lip-synced take was made for another slot), each
 *              shot carries its own slice of the song so the words stay on
 *              the mouth (musicvideo/sync.ts).
 *              AI video: uploaded music at the chosen level, or silence.
 *   MASTER     x264 slow / CRF 16 / High, AAC 320k, faststart
 *
 * Billing: the assembly hold is charged per output minute plus the upscale
 * seconds actually delivered.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canBurnSubtitles, ffmpeg, filterPath, probe, subtitlesFilter } from '../media/ffmpeg.js';
import { mixPieces, mixPositions, type AudioEdits } from '../musicvideo/audio.js';
import { deleteObject, downloadToFile, headObject, keys, readUrl, uploadBuffer, uploadFile } from '../services/storage.service.js';
import { releaseSystem, settleSystem, touchReservation } from '../services/token.service.js';
import { logger } from '../utils/logger.js';
import { ASPECTS, LOOKS, TRANSITIONS, transitionSeconds } from './cinema.js';
import { clipFilters, parseEdits, writeTextOverlays } from './clipEdits.js';
import { parseTitles, writeOpeningAss, writeOverlayAss } from '../musicvideo/titles.js';
import { cutToRange, songRuns, syncPlan, type SongRun, type SyncPlan } from '../musicvideo/sync.js';
import * as fal from './fal.js';
import { downloadUrl, thumbnail } from './files.js';
import { getStudioSettings } from './settings.js';
import { json, sql, withSqlRetry } from './sql.js';
import { publishProgress } from '../realtime/events.js';
import { projectWatermarked, WATERMARK_FILE, watermarkAvailable, watermarkFilters } from '../media/watermark.js';
import { DEFAULT_FINISH, masterAudioFilters, type AssetRow, type Finish, type ProjectRow, type SceneRow } from './types.js';

class Canceled extends Error {}

const FPS = 24;
/** No progress for this long → the cut stops itself (keeping what's done). */
const STALL_MS = 12 * 60_000;
/** One fal.ai upscale / foley request may take this long, then that shot goes on without it. */
const STEP_TIMEOUT_MS = 10 * 60_000;

/** The engine request saved for a paid stage still in flight (or null). */
async function readPending(workDir: string, key: string, index: number): Promise<fal.FalHandle | null> {
  if (!(await headObject(key).catch(() => null))) return null;
  const file = join(workDir, `pending-${index}.json`);
  try {
    await downloadToFile(key, file);
    const handle = JSON.parse(await readFile(file, 'utf8')) as fal.FalHandle;
    return handle?.statusUrl && handle.responseUrl ? handle : null;
  } catch {
    return null;
  }
}

/** Runs work(0…count-1), `limit` at a time; results in order. The first error stops new work and is thrown. */
async function pool<T>(count: number, limit: number, work: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const runner = async (): Promise<void> => {
    while (!failure && next < count) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, runner));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

export interface TimelineScene {
  durationSec: number;
  transition: keyof typeof TRANSITIONS;
}

/**
 * Where each scene starts on the final timeline. Transitions overlap into the
 * *next* clip's head, so scene i always starts at Σ durations before it.
 */
export function sceneStarts(scenes: readonly TimelineScene[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const scene of scenes) {
    starts.push(at);
    at += scene.durationSec;
  }
  return starts;
}

export async function runAssembly(projectId: string): Promise<void> {
  const [project] = await withSqlRetry(() => sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${projectId}`);
  if (!project || project.status !== 'ASSEMBLING') return;
  const finish: Finish = { ...DEFAULT_FINISH, ...project.finish };
  const settings = await getStudioSettings();
  const scale = finish.resolution === '2160p' ? 2 : 1;
  const width = ASPECTS[project.aspect].width * scale;
  const height = ASPECTS[project.aspect].height * scale;
  const workDir = await mkdtemp(join(tmpdir(), `assemble-${projectId.slice(0, 8)}-`));
  const log: ProjectRow['engineLog'] = [];
  let upscaledSeconds = 0;
  let stage = 'PREPARE';

  const update = async (patch: Record<string, unknown>): Promise<void> => {
    await withSqlRetry(() => sql`UPDATE studio_projects SET ${sql(patch as Record<string, never>)}, updated_at = now() WHERE id = ${projectId}`);
  };
  const emit = (event: { status?: string; stage?: string | null; progress?: number; detail?: string }, throttleMs = 0): void =>
    publishProgress({ kind: 'studio', workspaceId: project.workspaceId, projectId, status: 'ASSEMBLING', stage, ...event }, throttleMs);
  const enter = async (next: string, progress: number, detail?: string): Promise<void> => {
    const [row] = await withSqlRetry(() => sql<{ cancelRequested: boolean }[]>`SELECT cancel_requested FROM studio_projects WHERE id = ${projectId}`);
    if (row?.cancelRequested || abort.signal.aborted) throw new Canceled('Canceled');
    lastBeat = Date.now();
    stage = next;
    emit({ stage: next, progress, ...(detail ? { detail } : {}) });
    await update({ stage: next, progress });
    if (project.assemblyReservationId) await touchReservation(project.assemblyReservationId).catch(() => undefined);
  };
  const timed = async <T>(engine: string, fn: () => Promise<T>, detail?: string): Promise<T> => {
    const started = Date.now();
    const result = await fn();
    log.push({ at: new Date().toISOString(), stage, engine, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    return result;
  };

  // "Stop & play what's done": the shots prepared so far, and how to put the song under them.
  const abort = new AbortController();
  /** By scene index (filled out of order by the parallel prepare): the preview uses the finished prefix. */
  const prepared: ({ file: string; length: number; trimIn: number; speed: number } | undefined)[] = [];
  let shotCount = 0;
  let previewSong: { key: string; start: number; plan: SyncPlan | null } | null = null;
  /**
   * Watchdog, every 3 s: a stop request aborts whatever is running (fal.ai
   * waits, ffmpeg); and if nothing has moved for STALL_MS the cut stops itself
   * (keeping what's done) so a stuck job never sits on the token hold.
   */
  let lastBeat = Date.now();
  let stalled = false;
  const beat = (): void => {
    lastBeat = Date.now();
  };
  const watchdog = setInterval(() => {
    if (abort.signal.aborted) return;
    if (Date.now() - lastBeat > STALL_MS) {
      stalled = true;
      abort.abort();
      return;
    }
    void sql<{ cancelRequested: boolean }[]>`SELECT cancel_requested FROM studio_projects WHERE id = ${projectId}`
      .then(([row]) => {
        if (row?.cancelRequested) abort.abort();
      })
      .catch(() => undefined);
  }, 3000);
  /** Real progress (a shot prepared, a shot conformed, seconds mastered): resets the watchdog. */
  const progressed = async (progress: number, detail: string): Promise<void> => {
    beat();
    emit({ progress, detail }, 400);
    await sql`UPDATE studio_projects SET progress = ${progress} WHERE id = ${projectId}`.catch(() => undefined);
    if (project.assemblyReservationId) await touchReservation(project.assemblyReservationId).catch(() => undefined);
  };

  try {
    await enter('PREPARE', 2);
    const scenes = await sql<(SceneRow & { takeVideoKey: string; takeDuration: number | null })[]>`
      SELECT s.*, t.video_key AS take_video_key, t.duration_sec AS take_duration FROM studio_scenes s
      JOIN studio_takes t ON t.id = s.selected_take_id AND t.status = 'READY' AND t.video_key IS NOT NULL
      WHERE s.project_id = ${projectId} AND (${project.kind} <> 'MUSIC_VIDEO' OR s.shot_approved_at IS NOT NULL)
      ORDER BY s.position`;
    if (scenes.length === 0) throw new Error('Pick a take for at least one scene before assembling.');
    const takeKey = (scene: (typeof scenes)[number]): string => scene.takeVideoKey;

    let music: AssetRow | undefined;
    if (project.musicAssetId) [music] = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${project.musicAssetId} AND status = 'READY'`;
    if (project.kind === 'MUSIC_VIDEO' && !music) throw new Error('Upload the song before assembling the music video.');
    const [mv] =
      project.kind === 'MUSIC_VIDEO'
        ? await sql<{ subtitles: boolean; foley: boolean; lyrics: { lines: { start: number; end: number; text: string }[] } | null; audioEdits: AudioEdits; originalSongId: string | null; titles: unknown; artistName: string; audioAnalysis: Record<string, { bpm?: number | null }> | null }[]>`
            SELECT subtitles, foley, lyrics, audio_edits, original_song_id, titles, artist_name, audio_analysis FROM mv_projects WHERE project_id = ${projectId}`
        : [];
    // Music video sync: each shot gets its own piece of the song (lip-synced shots the exact words
    // they were synced to); left-out scenes make the song jump with the picture (see musicvideo/sync.ts).
    const songStart = project.kind === 'MUSIC_VIDEO' ? Math.max(0, project.brief.songStart ?? 0) : 0;
    const plan = project.kind === 'MUSIC_VIDEO' && music ? await syncPlan(projectId, music.key, songStart).catch(() => null) : null;
    // Start / end markers: only the shots inside the range, the edge shots cut exactly at the markers.
    const range = project.kind === 'MUSIC_VIDEO' ? (finish.range ?? null) : null;
    if (range && plan && plan.shots.length === scenes.length) {
      const cuts = cutToRange(
        scenes.map((scene) => scene.durationSec),
        plan.shots.map((shot) => shot.songFrom),
        range,
      );
      if (cuts.length === 0) throw new Error('No locked shot falls inside the chosen start / end markers.');
      const kept = cuts.map((cut) => {
        const scene = scenes[cut.index]!;
        const edits = parseEdits(scene.edits);
        return { ...scene, durationSec: cut.length, edits: { ...edits, trimIn: Math.min(9, +(edits.trimIn + cut.head * edits.speed).toFixed(3)) } };
      });
      plan.shots = cuts.map((cut) => ({ ...plan.shots[cut.index]!, songFrom: cut.songFrom }));
      plan.continuous = false;
      scenes.splice(0, scenes.length, ...kept);
      log.push({ at: new Date().toISOString(), stage, engine: 'range', ms: 0, detail: `mastering ${range.start.toFixed(1)}–${range.end.toFixed(1)} s of the song: ${kept.length} shot(s)` });
    }
    shotCount = scenes.length;
    if (music) previewSong = { key: music.key, start: songStart, plan: plan && plan.shots.length === scenes.length ? plan : null };
    // Blends are timed in beats of the song (a crossfade = one beat at this tempo).
    const bpm = music ? (mv?.audioAnalysis?.[music.id]?.bpm ?? null) : null;
    const foleyOn = Boolean(mv?.foley && settings.models.foley.enabled && fal.falConfigured());
    const foleyTracks: { file: string; at: number }[] = [];
    let foleySeconds = 0;

    /* ENHANCE + CONFORM ----------------------------------------------- */
    const timeline: TimelineScene[] = scenes.map((scene) => ({ durationSec: scene.durationSec, transition: scene.transition }));
    const segments: string[] = [];
    const sources: { file: string; available: number }[] = [];
    /** fal.ai poll hook: stops the request when the cut is stopped (by the creator or the watchdog). */
    const stopTick = (handle: fal.FalHandle) => async (): Promise<void> => {
      const [row] = await sql<{ cancelRequested: boolean }[]>`SELECT cancel_requested FROM studio_projects WHERE id = ${projectId}`;
      if (row?.cancelRequested || abort.signal.aborted) {
        await fal.cancel(handle);
        throw new Canceled('Canceled');
      }
    };
    const throwIfStopped = (): void => {
      if (abort.signal.aborted) throw new Canceled('Canceled');
    };
    // Paid stages are kept next to their take, so Continue (or a re-master) never pays for them twice.
    const takeFolder = (scene: (typeof scenes)[number]): string => `${keys.studio(project.workspaceId, projectId)}/takes/${scene.selectedTakeId}`;
    const upscaleOn = finish.enhance && settings.models.upscale.enabled && fal.falConfigured();

    await enter(finish.enhance ? 'ENHANCE' : 'CONFORM', 5, `Preparing ${scenes.length} shot${scenes.length === 1 ? '' : 's'}`);
    let readyCount = 0;
    const foleyBy: ({ file: string; at: number } | null)[] = new Array(scenes.length).fill(null);
    // Up to 3 shots at once: upscale/foley wait on fal.ai, so in parallel the wait is shared.
    const preparedShots = await pool(scenes.length, upscaleOn || foleyOn ? 3 : 2, async (index) => {
      throwIfStopped();
      const scene = scenes[index]!;
      // Visible activity (never "stuck at 5%"): which shot is being worked on right now.
      emit({ detail: `${upscaleOn ? 'Enhancing' : 'Preparing'} shot ${index + 1} of ${scenes.length} (${readyCount} done)` }, 400);
      const raw = join(workDir, `take-${index}.mp4`);
      let source = raw;
      await downloadToFile(takeKey(scene), raw);

      if (upscaleOn) {
        const enhanced = join(workDir, `enhanced-${index}.mp4`);
        const cacheKey = `${takeFolder(scene)}/enhanced-${finish.resolution}.mp4`;
        try {
          if (await headObject(cacheKey)) {
            await downloadToFile(cacheKey, enhanced);
            log.push({ at: new Date().toISOString(), stage, engine: 'upscale reused (not charged again)', ms: 0, detail: `scene ${index + 1}` });
          } else {
            const pendingKey = `${cacheKey}.pending.json`;
            let reused = false;
            await timed(
              `upscale: ${settings.models.upscale.endpoint}`,
              async () => {
                // A request already sent (earlier run, paused or restarted) is waited for, never sent again.
                let handle = await readPending(workDir, pendingKey, index);
                let result: unknown = null;
                if (handle) {
                  result = await fal.wait(handle, { onTick: stopTick(handle), timeoutMs: STEP_TIMEOUT_MS }).catch((error: unknown) => {
                    if (error instanceof Canceled) throw error;
                    return null; // that request failed or was cancelled: send a new one below
                  });
                  reused = result !== null;
                }
                if (!result) {
                  handle = await fal.submit(settings.models.upscale.endpoint, { ...settings.models.upscale.extra, video_url: await readUrl(takeKey(scene)) });
                  await uploadBuffer(pendingKey, Buffer.from(JSON.stringify(handle)), 'application/json').catch(() => undefined);
                  result = await fal.wait(handle, { onTick: stopTick(handle), timeoutMs: STEP_TIMEOUT_MS });
                }
                await downloadUrl(fal.outputUrl(result, 'video'), enhanced);
              },
              `scene ${index + 1}`,
            );
            upscaledSeconds += Math.ceil(scene.takeDuration ?? scene.durationSec);
            if (reused) log.push({ at: new Date().toISOString(), stage, engine: 'upscale picked up from the earlier run (not sent twice)', ms: 0, detail: `scene ${index + 1}` });
            await uploadFile(cacheKey, enhanced, 'video/mp4').catch((error: unknown) => logger.warn({ err: error, projectId }, 'enhanced shot not cached'));
            await deleteObject(pendingKey).catch(() => undefined);
          }
          source = enhanced;
        } catch (error) {
          if (error instanceof Canceled) throw error;
          // Enhancement is a bonus: fall back to the original take (lanczos-scaled) rather than failing the film.
          logger.warn({ err: error, projectId, scene: index }, 'upscale failed, using the original take');
          log.push({ at: new Date().toISOString(), stage, engine: 'upscale skipped', ms: 0, detail: `scene ${index + 1}: ${(error as Error).message.slice(0, 160)}` });
        }
      }

      // Foley: the shot's own action sounds (steps, claps, cloth, breath, heartbeat…), synced to its picture.
      if (foleyOn) {
        const foleyFile = join(workDir, `foley-${index}.wav`);
        const cacheKey = `${takeFolder(scene)}/foley-${Math.round(scene.durationSec * 1000)}.wav`;
        try {
          if (await headObject(cacheKey)) {
            await downloadToFile(cacheKey, foleyFile);
          } else {
            const pendingKey = `${cacheKey}.pending.json`;
            await timed(
              `foley: ${settings.models.foley.endpoint}`,
              async () => {
                // A request already sent (earlier run, paused or restarted) is waited for, never sent again.
                let handle = await readPending(workDir, pendingKey, 1000 + index);
                let result: unknown = null;
                if (handle) {
                  result = await fal.wait(handle, { onTick: stopTick(handle), timeoutMs: STEP_TIMEOUT_MS }).catch((error: unknown) => {
                    if (error instanceof Canceled) throw error;
                    return null;
                  });
                }
                if (!result) {
                  handle = await fal.submit(settings.models.foley.endpoint, {
                    ...settings.models.foley.extra,
                    video_url: await readUrl(takeKey(scene)),
                    prompt: `Diegetic sound effects only for this shot: ${scene.description.slice(0, 300)}. Footsteps on the surface shown, hand claps, finger snaps, cloth movement, breathing, crowd or room ambience, wind, and a deep heartbeat when the moment is emotional.`,
                    negative_prompt: 'music, singing, vocals, speech, melody, instruments, beat',
                    duration: Math.min(30, Math.max(1, Math.ceil(scene.takeDuration ?? scene.durationSec))),
                  });
                  await uploadBuffer(pendingKey, Buffer.from(JSON.stringify(handle)), 'application/json').catch(() => undefined);
                  result = await fal.wait(handle, { onTick: stopTick(handle), timeoutMs: STEP_TIMEOUT_MS });
                }
                const withSound = join(workDir, `foley-${index}.mp4`);
                await downloadUrl(fal.outputUrl(result, 'video'), withSound);
                await ffmpeg(['-i', withSound, '-vn', '-ac', '2', '-ar', '48000', '-t', scene.durationSec.toFixed(3), foleyFile]);
              },
              `scene ${index + 1}`,
            );
            foleySeconds += Math.ceil(scene.durationSec);
            await uploadFile(cacheKey, foleyFile, 'audio/wav').catch(() => undefined);
            await deleteObject(pendingKey).catch(() => undefined);
          }
          foleyBy[index] = { file: foleyFile, at: timeline.slice(0, index).reduce((sum, item) => sum + item.durationSec, 0) };
        } catch (error) {
          if (error instanceof Canceled) throw error;
          // Foley is a bonus: the film still masters without it.
          logger.warn({ err: error, projectId, scene: index }, 'foley failed, scene keeps the song only');
          log.push({ at: new Date().toISOString(), stage, engine: 'foley skipped', ms: 0, detail: `scene ${index + 1}: ${(error as Error).message.slice(0, 160)}` });
        }
      }

      const media = await probe(source);
      const edits = parseEdits(scene.edits);
      prepared[index] = { file: source, length: scene.durationSec, trimIn: edits.trimIn, speed: edits.speed };
      readyCount += 1;
      await progressed(5 + Math.round((readyCount / scenes.length) * 30), `${readyCount} of ${scenes.length} shots prepared`);
      return { file: source, available: Math.max(0, media.durationSec - edits.trimIn) / edits.speed };
    });
    sources.push(...preparedShots);
    foleyTracks.push(...foleyBy.filter((track): track is { file: string; at: number } => track !== null));

    /* PLAN: frame-exact cuts + transition handles ------------------------
     * Every scene starts on the frame nearest its place in the song
     * (round(Σ durations × fps)), so rounding never accumulates and the
     * picture can't drift from the song over many scenes.
     * A blend needs extra footage ("handles"): normally the outgoing shot's
     * tail plays under the incoming one, so the incoming shot starts exactly
     * on its cut (lip sync intact). If the outgoing take has no footage left
     * (it would freeze), the incoming shot starts early instead, unless it is
     * lip-synced; if neither side has footage, the blend shortens to what
     * exists, or becomes a hard cut. Never a frozen frame dissolving. */
    const startFrames: number[] = [];
    {
      let at = 0;
      for (const scene of timeline) {
        startFrames.push(Math.round(at * FPS));
        at += scene.durationSec;
      }
      startFrames.push(Math.round(at * FPS));
    }
    const sceneFrames = timeline.map((_, index) => Math.max(1, startFrames[index + 1]! - startFrames[index]!));
    const head = new Array<number>(scenes.length).fill(0);
    const tail = new Array<number>(scenes.length).fill(0);
    const blend = new Array<number>(scenes.length).fill(0); // frames, between scene i-1 and i
    for (let index = 1; index < scenes.length; index += 1) {
      const wanted = Math.round(transitionSeconds(timeline[index - 1]!.transition, bpm) * FPS);
      if (wanted < 2) continue;
      // Never longer than half of either shot.
      const cap = Math.min(wanted, Math.floor(sceneFrames[index - 1]! / 2), Math.floor(sceneFrames[index]! / 2));
      const spareOut = Math.floor((sources[index - 1]!.available * FPS - sceneFrames[index - 1]! - head[index - 1]!) + 0.001);
      const spareIn = scenes[index]!.lipSync ? 0 : Math.floor(sources[index]!.available * FPS - sceneFrames[index]! + 0.001);
      if (spareOut >= cap) tail[index - 1] = blend[index] = cap;
      else if (spareIn >= cap) head[index] = blend[index] = cap;
      else {
        const best = Math.max(spareOut, spareIn, 0);
        if (best < 3) continue; // hard cut beats a 2-frame smear
        blend[index] = best;
        if (spareOut >= spareIn) tail[index - 1] = best;
        else head[index] = best;
      }
      if (blend[index]! < wanted) log.push({ at: new Date().toISOString(), stage, engine: 'transition shortened', ms: 0, detail: `scene ${index} → ${index + 1}: ${blend[index] ? `${blend[index]} of ${wanted} frames` : 'hard cut'} (not enough footage for the full blend)` });
    }

    await enter('CONFORM', 36, `Conforming ${scenes.length} shot${scenes.length === 1 ? '' : 's'}`);
    let conformedCount = 0;
    // Two at a time: each conform is a CPU-bound x264 encode.
    const conformed = await pool(scenes.length, 2, async (index) => {
      throwIfStopped();
      const scene = scenes[index]!;
      const source = sources[index]!.file;
      const frames = head[index]! + sceneFrames[index]! + tail[index]!;
      const length = frames / FPS;
      // CapCut-style clip edits (trim-in, speed, reverse, look, adjust, zoom, text).
      const edits = parseEdits(scene.edits);
      const pieces = clipFilters(edits, { width, height, fps: FPS, length });
      const available = sources[index]!.available;
      const hold = Math.max(0, length - available + 0.05);
      const textFile = join(workDir, `texts-${index}.ass`);
      const texts = (await writeTextOverlays(edits, textFile, { width, height, length: scene.durationSec })) && (await canBurnSubtitles(textFile).catch(() => false));
      const segment = join(workDir, `segment-${index}.mp4`);
      const filters = [
        ...pieces.early,
        `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${width}:${height}`,
        'setsar=1',
        // Generated clips vary (24/25/30 fps); motion-interpolated retiming looks synthetic, so plain fps conversion.
        `fps=${FPS}`,
        ...(hold > 0 ? [`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`] : []),
        ...pieces.late,
        // Bundled fonts (fontsdir), the same ones the browser previews.
        ...(texts ? [subtitlesFilter(textFile)] : []),
        'format=yuv420p',
      ];
      await timed('ffmpeg conform', () =>
        // Exact frame count (not -t): every segment is a whole number of frames, so joins land on the planned frame.
        ffmpeg([...pieces.input, '-i', source, '-frames:v', String(frames), '-vf', filters.join(','), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', segment], {
          signal: abort.signal,
        }),
      );
      conformedCount += 1;
      await progressed(36 + Math.round((conformedCount / scenes.length) * 33), `${conformedCount} of ${scenes.length} shots conformed`);
      return segment;
    });
    segments.push(...conformed);

    /* JOIN + FINISH + SOUND + MASTER ----------------------------------- */
    await enter('MASTER', 70);
    // The film ends with the last locked shot (never runs on into the rest of the song).
    const total = startFrames[scenes.length]! / FPS;
    const lengths = sceneFrames.map((frames) => frames / FPS);
    const runs = plan && plan.shots.length === scenes.length && !plan.continuous ? songRuns(plan, lengths) : null;
    const runVideoStart = (run: SongRun): number => startFrames[run.first]! / FPS;
    const runLength = (run: SongRun): number => (startFrames[run.last + 1]! - startFrames[run.first]!) / FPS;
    /** Song time (s after the song start) → video time, or null when that part of the song is not in the film. */
    const toVideo = (songTime: number): number | null => {
      if (!runs) return songTime;
      const run = runs.find((item) => songTime >= item.songFrom && songTime < item.songFrom + runLength(item));
      return run ? runVideoStart(run) + (songTime - run.songFrom) : null;
    };
    if (runs) {
      log.push({
        at: new Date().toISOString(),
        stage,
        engine: 'song sync',
        ms: 0,
        detail: `${runs.length} song piece${runs.length === 1 ? '' : 's'}: ${runs.map((run) => `${run.songFrom.toFixed(1)}–${(run.songFrom + runLength(run)).toFixed(1)} s`).join(', ')}`,
      });
    }
    const inputs = segments.flatMap((segment) => ['-i', segment]);
    const graph: string[] = [];
    let last = '[0:v]';
    // Frames in the chain so far: hard cuts concatenate; blends overlap by `blend` frames, so each scene's
    // first fully-visible frame (tail mode) or blend midpoint (head mode) sits on its planned frame.
    let chainEnd = head[0]! + sceneFrames[0]! + tail[0]!;
    for (let index = 1; index < segments.length; index += 1) {
      const out = `[x${index}]`;
      const frames = blend[index]!;
      const length = head[index]! + sceneFrames[index]! + tail[index]!;
      if (frames === 0) {
        graph.push(`${last}[${index}:v]concat=n=2:v=1:a=0${out}`);
        chainEnd += length;
      } else {
        const offset = chainEnd - frames;
        const transition = TRANSITIONS[timeline[index - 1]!.transition];
        graph.push(`${last}[${index}:v]xfade=transition=${transition.xfade}:duration=${(frames / FPS).toFixed(4)}:offset=${(offset / FPS).toFixed(4)}${out}`);
        chainEnd = offset + length;
      }
      last = out;
    }
    const bar = Math.round((height - width / 2.39) / 2);
    // Lyric subtitles: the (edited) lyrics, moved onto the edited song's timeline, burned in.
    let subtitleFilter = '';
    if (mv?.subtitles && mv.lyrics?.lines.length) {
      const srt = join(workDir, 'lyrics.srt');
      const [original] = mv.originalSongId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${mv.originalSongId}` : [];
      // Every place a lyric is heard in the mix (events copied on the storyboard repeat their lines).
      const pieces = original?.meta.durationSec ? mixPieces(original.meta.durationSec, mv.audioEdits) : [{ from: 0, to: Number.MAX_SAFE_INTEGER, at: 0 }];
      const stamp = (seconds: number): string => {
        const ms = Math.max(0, Math.round(seconds * 1000));
        const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
        return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
      };
      // Scenes with subtitles switched off stay clean.
      const muted: { from: number; to: number }[] = [];
      scenes.reduce((at, scene) => {
        if (scene.subtitles === false) muted.push({ from: at, to: at + scene.durationSec });
        return at + scene.durationSec;
      }, 0);
      const cues = mv.lyrics.lines
        .flatMap((line) => {
          if (!line.text.trim()) return [];
          return mixPositions(pieces, line.start).flatMap((start) => {
            // Where the line is heard in the film (null: its part of the song is left out).
            const begin = toVideo(start - songStart);
            if (begin === null) return [];
            const end = Math.min(begin + Math.max(0.6, line.end - line.start), total);
            if (muted.some((range) => begin >= range.from && begin < range.to)) return [];
            return begin >= 0 && begin < total ? [{ begin, end, text: line.text.trim() }] : [];
          });
        })
        .sort((a, b) => a.begin - b.begin);
      if (cues.length) await writeFile(srt, cues.map((cue, index) => `${index + 1}\n${stamp(cue.begin)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n'), 'utf8');
      if (cues.length && (await canBurnSubtitles(srt).catch(() => false))) {
        const size = Math.round(height / 22);
        subtitleFilter = `subtitles=${filterPath(srt)}:force_style='FontName=Arial,Bold=1,FontSize=${Math.round(size / 2.2)},PrimaryColour=&H00FFFFFF,OutlineColour=&H99000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=${Math.round(height / 18 / 2.2)}'`;
      } else if (cues.length) {
        log.push({ at: new Date().toISOString(), stage, engine: 'subtitles skipped', ms: 0, detail: "this server's ffmpeg has no subtitle (libass) support" });
      }
    }
    // Opening titles over the intro + "Directed by" end credit (music videos).
    const titles = mv?.titles ? parseTitles(mv.titles, mv.artistName, project.title) : null;
    let titleFilter = '';
    if (titles?.enabled) {
      const overlay = join(workDir, 'titles.ass');
      if ((await writeOverlayAss(titles, overlay, { width, height, total })) && (await canBurnSubtitles(overlay).catch(() => false))) titleFilter = subtitlesFilter(overlay);
    }
    const finishing = [
      LOOKS[finish.look],
      'unsharp=5:5:0.35:5:5:0',
      ...(finish.grain > 0 ? [`noise=c0s=${finish.grain}:c0f=t+u`] : []),
      'vignette=angle=PI/5:mode=backward',
      ...(finish.letterbox && project.aspect === '16:9' && bar > 0 ? [`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`] : []),
      ...(subtitleFilter ? [subtitleFilter] : []),
      ...(titleFilter ? [titleFilter] : []),
      'format=yuv420p',
    ];
    // Graded picture; the watermark (if any) is laid on just before the encode, once every input is known.
    graph.push(`${last}${finishing.join(',')}[graded]`);

    // Commercials: each scene's spoken line (VOICE asset) starts with its scene (a beat after the cut).
    const voiceTracks: { file: string; at: number }[] = [];
    if (project.kind === 'COMMERCIAL') {
      const ids = scenes.flatMap((scene) => (scene.voiceAssetId ? [scene.voiceAssetId] : []));
      const voices = ids.length ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ANY(${ids}::uuid[]) AND status = 'READY'` : [];
      for (const [index, scene] of scenes.entries()) {
        const voice = voices.find((asset) => asset.id === scene.voiceAssetId);
        if (!voice) continue;
        const file = join(workDir, `voice-${index}`);
        await downloadToFile(voice.key, file);
        voiceTracks.push({ file, at: startFrames[index]! / FPS + 0.12 });
      }
      if (voiceTracks.length) log.push({ at: new Date().toISOString(), stage, engine: 'voices', ms: 0, detail: `${voiceTracks.length} spoken line(s) mixed at their scenes` });
    }
    const voiceChain = (input: string, track: { at: number }, label: string): string => {
      const delay = Math.round(track.at * 1000);
      // Voice-over polish: rumble cut, gentle presence, even level; placed at its scene.
      return `${input}aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,acompressor=threshold=-18dB:ratio=2.5:attack=5:release=120,adelay=${delay}|${delay}[${label}]`;
    };

    const audioIndex = segments.length;
    const audioArgs: string[] = [];
    const fadeOut = Math.min(2.5, total / 4);
    if (music) {
      const song = join(workDir, 'music');
      await downloadToFile(music.key, song);
      const start = project.kind === 'MUSIC_VIDEO' ? Math.max(0, project.brief.songStart ?? 0) : 0;
      audioArgs.push('-ss', start.toFixed(3), '-i', song);
      const volume = project.kind === 'MUSIC_VIDEO' ? 1 : Math.min(1, Math.max(0, finish.musicVolume));
      // Industry loudness: integrated LUFS target (default -14, the streaming standard), true peak -1 dBTP.
      const lufs = Math.min(-6, Math.max(-30, finish.loudnessLufs ?? DEFAULT_FINISH.loudnessLufs));
      if (runs) {
        // One slice of the song per continuous run, each with a 12 ms fade at its edges (no click where the song jumps).
        const fade = 0.012;
        graph.push(`[${audioIndex}:a]aresample=48000,asplit=${runs.length}${runs.map((_, index) => `[sp${index}]`).join('')}`);
        runs.forEach((run, index) => {
          const length = runLength(run);
          graph.push(
            `[sp${index}]atrim=start=${run.songFrom.toFixed(3)}:duration=${length.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${length.toFixed(3)},` +
              `afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, length - fade).toFixed(3)}:d=${fade}[run${index}]`,
          );
        });
        graph.push(`${runs.map((_, index) => `[run${index}]`).join('')}concat=n=${runs.length}:v=0:a=1,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume}[song]`);
      } else {
        graph.push(`[${audioIndex}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,volume=${volume}[song]`);
      }
      // Foley sits under the song: band-limited, about -12 dB, placed at each scene's start.
      let bed = '[song]';
      if (foleyTracks.length) {
        foleyTracks.forEach((track, index) => {
          audioArgs.push('-i', track.file);
          const delay = Math.round(track.at * 1000);
          graph.push(`[${audioIndex + 1 + index}:a]aresample=48000,highpass=f=60,lowpass=f=12000,volume=0.25,adelay=${delay}|${delay}[fx${index}]`);
        });
        graph.push(`[song]${foleyTracks.map((_, index) => `[fx${index}]`).join('')}amix=inputs=${foleyTracks.length + 1}:duration=first:normalize=0[bed]`);
        bed = '[bed]';
      }
      // Spoken lines over a music bed: the music ducks under the voice (side-chain), like a broadcast ad.
      if (voiceTracks.length) {
        const first = audioIndex + 1 + foleyTracks.length;
        voiceTracks.forEach((track, index) => {
          audioArgs.push('-i', track.file);
          graph.push(voiceChain(`[${first + index}:a]`, track, `vo${index}`));
        });
        graph.push(`${voiceTracks.map((_, index) => `[vo${index}]`).join('')}amix=inputs=${voiceTracks.length}:duration=longest:normalize=0,apad=whole_dur=${total.toFixed(3)},asplit=2[voice][key]`);
        graph.push(`${bed}[key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[ducked]`);
        graph.push(`[ducked][voice]amix=inputs=2:duration=first:normalize=0[voiced]`);
        bed = '[voiced]';
      }
      // The mastering desk (gain, EQ, glue, width) goes before the loudness stage, as on a real master bus.
      const desk = project.kind === 'MUSIC_VIDEO' ? masterAudioFilters(finish.audio) : [];
      graph.push(`${bed}${desk.length ? `${desk.join(',')},` : ''}loudnorm=I=${lufs}:TP=-1:LRA=11,aresample=48000,afade=t=in:d=0.15,afade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`);
    } else {
      audioArgs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      if (voiceTracks.length) {
        // Voice-only commercial: the lines over silence, mastered to the loudness target.
        const lufs = Math.min(-6, Math.max(-30, finish.loudnessLufs ?? DEFAULT_FINISH.loudnessLufs));
        voiceTracks.forEach((track, index) => {
          audioArgs.push('-i', track.file);
          graph.push(voiceChain(`[${audioIndex + 1 + index}:a]`, track, `vo${index}`));
        });
        graph.push(
          `[${audioIndex}:a]${voiceTracks.map((_, index) => `[vo${index}]`).join('')}amix=inputs=${voiceTracks.length + 1}:duration=first:normalize=0,` +
            `loudnorm=I=${lufs}:TP=-1:LRA=11,aresample=48000,atrim=0:${total.toFixed(3)}[aout]`,
        );
      } else {
        graph.push(`[${audioIndex}:a]anull[aout]`);
      }
    }

    // Platform watermark: on every render until the project owner pays it off.
    if ((await projectWatermarked(projectId)) && (await watermarkAvailable())) {
      const logoIndex = segments.length + audioArgs.filter((arg) => arg === '-i').length;
      audioArgs.push('-loop', '1', '-i', WATERMARK_FILE);
      const mark = watermarkFilters('[graded]', logoIndex, { width, height }, 'vout');
      graph.push(...mark.graph);
      log.push({ at: new Date().toISOString(), stage, engine: 'watermark', ms: 0, detail: 'platform watermark added (remove it for this project from the project page)' });
    } else {
      graph.push('[graded]null[vout]');
    }

    const output = join(workDir, 'film.mp4');
    const thumb = join(workDir, 'film.jpg');
    await timed(
      `ffmpeg master (x264 slow CRF 16, ${width}×${height}, ${finish.look}, grain ${finish.grain}${finish.letterbox ? ', 2.39:1' : ''})`,
      () =>
        ffmpeg(
          [
            ...inputs,
            ...audioArgs,
            '-filter_complex',
            graph.join(';'),
            '-map',
            '[vout]',
            '-map',
            '[aout]',
            '-t',
            total.toFixed(3),
            '-r',
            String(FPS),
            '-c:v',
            'libx264',
            '-preset',
            'slow',
            '-crf',
            '16',
            '-profile:v',
            'high',
            '-pix_fmt',
            'yuv420p',
            '-x264-params',
            'aq-mode=3:psy-rd=1.0,0.15',
            '-c:a',
            'aac',
            '-b:a',
            '320k',
            '-movflags',
            '+faststart',
            output,
          ],
          {
            signal: abort.signal,
            onProgress: (seconds) => {
              beat();
              const progress = Math.min(97, 70 + Math.round((seconds / total) * 27));
              emit({ progress, detail: `${Math.round(seconds)} of ${Math.round(total)} s mastered` }, 400);
              void sql`UPDATE studio_projects SET progress = ${progress} WHERE id = ${projectId}`.catch(() => undefined);
            },
          },
        ),
      `${scenes.length} scene(s), ${total.toFixed(1)} s`,
    );

    // Story text cards / credits on black before the song: rendered separately and joined in front.
    let final = output;
    let opening = 0;
    if (titles?.enabled) {
      const openingAss = join(workDir, 'opening.ass');
      const seconds = await writeOpeningAss(titles, openingAss, { width, height });
      if (seconds > 0 && (await canBurnSubtitles(openingAss).catch(() => false))) {
        const joined = join(workDir, 'film-titled.mp4');
        await timed(
          'ffmpeg opening titles',
          () =>
            ffmpeg([
              '-f', 'lavfi', '-t', seconds.toFixed(3), '-i', `color=c=black:s=${width}x${height}:r=${FPS}`,
              '-f', 'lavfi', '-t', seconds.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
              '-i', output,
              '-filter_complex',
              `[0:v]${subtitlesFilter(openingAss)}${finish.grain > 0 ? `,noise=c0s=${Math.min(finish.grain, 8)}:c0f=t+u` : ''},format=yuv420p,setsar=1[ov];` +
                `[2:v]setsar=1,fade=t=in:st=0:d=0.6[fv];[2:a]aresample=48000,aformat=channel_layouts=stereo[fa];` +
                '[ov][1:a][fv][fa]concat=n=2:v=1:a=1[v][a]',
              '-map', '[v]', '-map', '[a]', '-r', String(FPS),
              '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', joined,
            ]),
          `${seconds.toFixed(1)} s of titles on black`,
        );
        final = joined;
        opening = seconds;
      }
    }

    // Music videos: VeloBot's cold open (a short narrated film) plays first, before any titles and the song.
    if (project.kind === 'MUSIC_VIDEO') {
      const { readyPrologue } = await import('../musicvideo/prologue.js');
      const cold = await readyPrologue(projectId).catch(() => null);
      if (cold) {
        const coldFile = join(workDir, 'cold-open.mp4');
        await downloadToFile(cold.key, coldFile);
        const withCold = join(workDir, 'film-cold-open.mp4');
        await timed(
          'ffmpeg cold open',
          () =>
            ffmpeg([
              '-i', coldFile,
              '-i', final,
              '-filter_complex',
              `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${FPS},setsar=1,format=yuv420p[cv];` +
                '[0:a]aresample=48000,aformat=channel_layouts=stereo[ca];' +
                `[1:v]fps=${FPS},setsar=1,format=yuv420p[fv];[1:a]aresample=48000,aformat=channel_layouts=stereo[fa];` +
                '[cv][ca][fv][fa]concat=n=2:v=1:a=1[v][a]',
              '-map', '[v]', '-map', '[a]', '-r', String(FPS),
              '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', withCold,
            ]),
          `${cold.seconds.toFixed(1)} s cold open`,
        );
        final = withCold;
        opening += cold.seconds;
      }
    }

    // Commercials: logo + call to action over the last seconds (inside the length). A failure never loses the master.
    if (project.kind === 'COMMERCIAL') {
      const { applyEndCard } = await import('../commercials/endCard.js');
      const card = await applyEndCard(projectId, final, workDir, { width, height, total, fps: FPS, signal: abort.signal }).catch((error: unknown) => {
        if (abort.signal.aborted) throw error;
        logger.warn({ err: error, projectId }, 'end card failed: the ad is kept without it');
        log.push({ at: new Date().toISOString(), stage, engine: 'end card skipped', ms: 0, detail: 'could not render it; the ad is kept without it' });
        return null;
      });
      if (card) {
        final = card.file;
        log.push({ at: new Date().toISOString(), stage, engine: 'end card', ms: 0, detail: card.detail });
      }
    }

    await enter('UPLOAD', 98);
    await thumbnail(final, thumb, opening + Math.min(2, total / 3));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputKey = keys.studioOutput(project.workspaceId, projectId, stamp, 'mp4');
    const thumbKey = keys.studioOutput(project.workspaceId, projectId, stamp, 'jpg');
    await Promise.all([uploadFile(outputKey, final, 'video/mp4'), uploadFile(thumbKey, thumb, 'image/jpeg')]);
    const size = (await stat(final)).size;

    const charge = Math.ceil(total / 60) * settings.costs.assemblyPerMinute + upscaledSeconds * settings.costs.upscalePerSecond + foleySeconds * settings.costs.foleyPerSecond;
    const charged = await settle(project, charge, `${scenes.length} scene(s), ${Math.round(total)} s${upscaledSeconds ? `, ${upscaledSeconds} s enhanced` : ''}`);
    await update({
      status: 'READY',
      stage: 'DONE',
      progress: 100,
      outputKey,
      thumbKey,
      outputDuration: total + opening,
      outputSize: size,
      error: null,
      assemblyReservationId: null,
      tokensCharged: project.tokensCharged + charged,
      finishedAt: new Date(),
      engineLog: json([...project.engineLog, ...log].slice(-200)),
    });
    emit({ status: 'READY', stage: 'DONE', progress: 100, detail: `${Math.round(total)} s film ready` });
    // The film it replaces leaves the bucket.
    if (project.outputKey && project.outputKey !== outputKey) await deleteObject(project.outputKey).catch(() => undefined);
    if (project.thumbKey && project.thumbKey !== thumbKey) await deleteObject(project.thumbKey).catch(() => undefined);
    logger.info({ projectId, seconds: total, bytes: size, tokens: charged }, 'studio film assembled');
  } catch (error) {
    const canceled = error instanceof Canceled || abort.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    if (!canceled) logger.error({ err: error, projectId, stage }, 'studio assembly failed');
    // Upscales already delivered are paid for; the assembly itself isn't.
    const charged = await settle(project, upscaledSeconds * settings.costs.upscalePerSecond, `${upscaledSeconds} s enhanced (assembly ${canceled ? 'canceled' : 'failed'})`).catch(() => 0);

    // "Stop & play what's done" (or the watchdog stopped it): join the shots prepared so far, in order.
    const [keepRow] = canceled ? await sql<{ cancelKeep: boolean }[]>`SELECT cancel_keep FROM studio_projects WHERE id = ${projectId}`.catch(() => []) : [];
    const doneShots: NonNullable<(typeof prepared)[number]>[] = [];
    for (const shot of prepared) {
      if (!shot) break;
      doneShots.push(shot);
    }
    const stallNote = stalled
      ? `Mastering stopped itself: nothing moved for ${STALL_MS / 60_000} minutes (${stage.toLowerCase()} step). Only finished upscales were charged. Press Continue to pick up from here.`
      : null;
    if (stalled) logger.warn({ projectId, stage }, 'assembly stalled: stopped by the watchdog');
    // Every stop leaves something to play and download: Pause and the watchdog always; Cancel too,
    // unless there is already a full film (Cancel never replaces a finished film with a partial one).
    const preview =
      canceled && (keepRow?.cancelKeep || stalled || !project.outputKey) && doneShots.length
        ? await buildPreview(workDir, doneShots, previewSong, { width, height }).catch((previewError: unknown) => {
            logger.warn({ err: previewError, projectId }, 'partial preview failed');
            return null;
          })
        : null;
    if (preview) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputKey = keys.studioOutput(project.workspaceId, projectId, stamp, 'mp4');
      const thumbKey = keys.studioOutput(project.workspaceId, projectId, stamp, 'jpg');
      try {
        await Promise.all([uploadFile(outputKey, preview.file, 'video/mp4'), uploadFile(thumbKey, preview.thumb, 'image/jpeg')]);
        const detail = `Preview of what's done: ${doneShots.length} of ${shotCount} shot${shotCount === 1 ? '' : 's'}, ${Math.round(preview.seconds)} s (stopped; no grade or transitions). Press Continue for the full film.`;
        await update({
          status: 'READY',
          stage: 'DONE',
          progress: 100,
          outputKey,
          thumbKey,
          outputDuration: preview.seconds,
          outputSize: (await stat(preview.file)).size,
          error: stallNote,
          assemblyReservationId: null,
          cancelRequested: false,
          cancelKeep: false,
          tokensCharged: project.tokensCharged + charged,
          finishedAt: new Date(),
          engineLog: json([...project.engineLog, ...log, { at: new Date().toISOString(), stage: 'PREVIEW', engine: 'stopped: preview of what was done', ms: 0, detail }].slice(-200)),
        });
        emit({ status: 'READY', stage: 'DONE', progress: 100, detail });
        // The previous film's files are replaced by the preview.
        if (project.outputKey) await deleteObject(project.outputKey).catch(() => undefined);
        if (project.thumbKey) await deleteObject(project.thumbKey).catch(() => undefined);
        return;
      } catch (uploadError) {
        logger.warn({ err: uploadError, projectId }, 'partial preview upload failed');
      }
    }
    await update({
      // A previous film (if any) stays available; the project returns to editing.
      status: canceled ? (project.outputKey ? 'READY' : 'DRAFT') : 'FAILED',
      stage: null,
      progress: 0,
      error: stallNote ?? (canceled ? null : message.slice(0, 990)),
      assemblyReservationId: null,
      cancelRequested: false,
      cancelKeep: false,
      tokensCharged: project.tokensCharged + charged,
      // Paused (by the creator or the watchdog): the page offers Continue (finished upscales are reused).
      engineLog: json(
        [
          ...project.engineLog,
          ...log,
          ...(canceled
            ? [{ at: new Date().toISOString(), stage: 'PAUSED', engine: 'paused: the film engine stopped, nothing running or charged', ms: 0, detail: `${doneShots.length} of ${shotCount} shot(s) prepared` }]
            : []),
        ].slice(-200),
      ),
    })
      .then(() => emit({ status: canceled ? (project.outputKey ? 'READY' : 'DRAFT') : 'FAILED', stage: null, progress: 0, detail: canceled ? 'Paused' : message.slice(0, 200) }))
      .catch((writeError: unknown) => logger.error({ err: writeError, projectId }, 'could not record the failed assembly'));
  } finally {
    clearInterval(watchdog);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A quick, ungraded cut of the shots prepared before the stop: hard cuts, each
 * shot at its storyboard length, the song under it from the same sync plan as
 * the master (lip-synced shots on their words). Fast encode: it's for review.
 */
async function buildPreview(
  workDir: string,
  shots: { file: string; length: number; trimIn: number; speed: number }[],
  song: { key: string; start: number; plan: SyncPlan | null } | null,
  size: { width: number; height: number },
): Promise<{ file: string; thumb: string; seconds: number }> {
  const lengths = shots.map((shot) => Math.max(1 / FPS, Math.round(shot.length * FPS) / FPS));
  const seconds = lengths.reduce((sum, value) => sum + value, 0);
  const args: string[] = [];
  const graph: string[] = [];
  shots.forEach((shot, index) => {
    args.push(...(shot.trimIn > 0 ? ['-ss', shot.trimIn.toFixed(3)] : []), '-i', shot.file);
    const length = lengths[index]!.toFixed(3);
    graph.push(
      `[${index}:v]${shot.speed !== 1 ? `setpts=PTS/${shot.speed.toFixed(3)},` : ''}fps=${FPS},scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},setsar=1,` +
        `tpad=stop_mode=clone:stop_duration=${length},trim=duration=${length},setpts=PTS-STARTPTS[v${index}]`,
    );
  });
  graph.push(`${shots.map((_, index) => `[v${index}]`).join('')}concat=n=${shots.length}:v=1:a=0[vout]`);

  const audioIndex = shots.length;
  if (song) {
    const file = join(workDir, 'preview-song');
    await downloadToFile(song.key, file);
    args.push('-ss', song.start.toFixed(3), '-i', file);
    // Same slices as the master: the plan for the shots done so far.
    const plan = song.plan ? { ...song.plan, shots: song.plan.shots.slice(0, shots.length), continuous: false } : null;
    const runs = plan ? songRuns(plan, lengths) : [{ songFrom: 0, first: 0, last: shots.length - 1 }];
    graph.push(`[${audioIndex}:a]aresample=48000,asplit=${runs.length}${runs.map((_, index) => `[sp${index}]`).join('')}`);
    runs.forEach((run, index) => {
      const length = lengths.slice(run.first, run.last + 1).reduce((sum, value) => sum + value, 0);
      graph.push(
        `[sp${index}]atrim=start=${run.songFrom.toFixed(3)}:duration=${length.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${length.toFixed(3)},afade=t=in:d=0.012,afade=t=out:st=${Math.max(0, length - 0.012).toFixed(3)}:d=0.012[run${index}]`,
      );
    });
    graph.push(`${runs.map((_, index) => `[run${index}]`).join('')}concat=n=${runs.length}:v=0:a=1,atrim=0:${seconds.toFixed(3)},afade=t=out:st=${Math.max(0, seconds - 1).toFixed(3)}:d=1[aout]`);
  } else {
    args.push('-f', 'lavfi', '-t', seconds.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    graph.push(`[${audioIndex}:a]anull[aout]`);
  }
  const file = join(workDir, 'preview.mp4');
  const thumb = join(workDir, 'preview.jpg');
  await ffmpeg([
    ...args,
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', '[aout]', '-t', seconds.toFixed(3), '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', file,
  ]);
  await thumbnail(file, thumb, Math.min(2, seconds / 3));
  return { file, thumb, seconds };
}

async function settle(project: ProjectRow, charge: number, detail: string): Promise<number> {
  if (!project.assemblyReservationId) return 0;
  if (charge <= 0) {
    await releaseSystem(project.assemblyReservationId, project.workspaceId).catch(() => undefined);
    return 0;
  }
  const result = await settleSystem(project.assemblyReservationId, project.workspaceId, charge, `AI video · ${project.title.slice(0, 60)}: assembly, ${detail}`);
  return result.actual ?? charge;
}
