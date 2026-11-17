/**
 * Quick mix & master: a postable teaser from 1–3 consecutive scenes of a music
 * video, finished by VeloBot and downloaded under a name the artist chose. The
 * film itself is never touched; every export is its own row (mv_clips).
 *
 * What VeloBot does, in order (all on the server, ffmpeg):
 *   CHECK      the takes' own reviews (lip sync, cast consistency, weak or
 *              off-story footage) are read and reported; nothing is hidden.
 *   ON THE BAR the teaser starts on the first bar line inside its first shot
 *              and ends on the last bar line inside its last shot (picture and
 *              sound trimmed together, so lip sync never moves).
 *   LIGHTING   each shot's brightness and colour saturation are measured and
 *              matched to the group, so the cuts read as one shoot.
 *   PICTURE    the scene's own edits (trim, speed, look…), exact frame size,
 *              24 fps, gentle denoise, the project's grade, sharpen, grain,
 *              vignette; smooth half-beat dissolves where neither side is
 *              lip-synced (hard cuts keep lip-synced words on the mouth).
 *   SOUND      each shot plays its own slice of the song (lip-synced shots the
 *              exact words they were made to); gentle broadband noise
 *              reduction, rumble cut, the project's mastering desk, loudness
 *              to −14 LUFS / −1 dBTP, short fades for a clean start and end.
 *   WORDS      the lyric lines heard in the teaser, burned in, synced.
 *   BRAND      fade in from / out to black and the platform watermark (until
 *              it is paid off for the project).
 *
 * What it cannot do is redraw a face or re-sing a mouth: a take the review
 * flagged for that is reported so the scene can be re-shot.
 *
 * Billing: the assembly rate per started minute, held before and settled when
 * the clip is ready (released if it fails).
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canBurnSubtitles, ffmpeg, ffmpegLog, filterPath, probe } from '../media/ffmpeg.js';
import { projectWatermarked, WATERMARK_FILE, watermarkAvailable, watermarkFilters } from '../media/watermark.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { downloadToFile, keys, readUrl, uploadFile } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem, touchReservation } from '../services/token.service.js';
import { assertStorage, SIZE_ESTIMATE } from '../storage/service.js';
import { LOOKS, ASPECTS } from '../studio/cinema.js';
import { clipFilters, parseEdits } from '../studio/clipEdits.js';
import { thumbnail } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql, withSqlRetry } from '../studio/sql.js';
import { DEFAULT_FINISH, masterAudioFilters, type Finish, type ProjectRow, type TakeReview, type TakeSpec } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { access, load } from './service.js';
import { songContext } from './songmap.js';

export const MAX_CLIP_SCENES = 3;
const FPS = 24;
/** A dissolve between two non-lip-synced shots: about half a beat at 120 bpm. */
const BLEND_FRAMES = 6;
const JOIN = 0.02;

export type ClipStatus = 'QUEUED' | 'RENDERING' | 'READY' | 'FAILED';

interface ClipRow {
  id: string;
  projectId: string;
  workspaceId: string;
  createdById: string | null;
  name: string;
  sceneIds: string[];
  status: ClipStatus;
  stage: string | null;
  progress: number;
  detail: string | null;
  outputKey: string | null;
  thumbKey: string | null;
  durationSec: string | number | null;
  sizeBytes: string | number | null;
  watermarked: boolean;
  report: ClipReport;
  reservationId: string | null;
  tokensCharged: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface ClipReport {
  steps?: string[];
  warnings?: string[];
  trimmed?: { head: number; tail: number };
  lighting?: { position: number; brightness: number; saturation: number }[];
  subtitles?: number;
}

interface Shot {
  sceneId: string;
  position: number;
  description: string;
  durationSec: number;
  lipSync: boolean;
  subtitles: boolean | null;
  edits: unknown;
  takeId: string;
  videoKey: string;
  takeDuration: number | null;
  songFrom: number;
  review: TakeReview | null;
}

/* ------------------------------------------------------------------ selection */

/**
 * The chosen scenes, checked: 1–3, consecutive on the storyboard, each with a
 * finished video. Each carries the slice of the song it plays (the same rule
 * as the master: lip-synced shots the words they were made to, others their
 * storyboard place).
 */
async function resolveShots(project: ProjectRow, sceneIds: string[]): Promise<Shot[]> {
  const unique = [...new Set(sceneIds)];
  if (unique.length === 0) throw AppError.badRequest('Select at least one scene.');
  if (unique.length > MAX_CLIP_SCENES) throw AppError.badRequest(`Select up to ${MAX_CLIP_SCENES} scenes for a quick clip.`);
  const rows = await sql<
    {
      id: string;
      position: number;
      description: string;
      durationSec: string | number;
      lipSync: boolean;
      subtitles: boolean | null;
      edits: unknown;
      takeId: string | null;
      videoKey: string | null;
      takeStatus: string | null;
      takeDuration: string | number | null;
      spec: TakeSpec | null;
      review: TakeReview | null;
    }[]
  >`
    SELECT s.id, s.position, s.description, s.duration_sec, s.lip_sync, s.subtitles, s.edits,
      t.id AS take_id, t.video_key, t.status AS take_status, t.duration_sec AS take_duration, t.spec, t.review
    FROM studio_scenes s LEFT JOIN studio_takes t ON t.id = s.selected_take_id
    WHERE s.project_id = ${project.id} ORDER BY s.position`;
  const songStart = Math.max(0, project.brief.songStart ?? 0);
  const [music] = project.musicAssetId ? await sql<{ key: string }[]>`SELECT key FROM studio_assets WHERE id = ${project.musicAssetId}` : [];

  let planned = 0;
  const all: (Shot & { ready: boolean })[] = rows.map((row) => {
    const length = Number(row.durationSec);
    const edits = parseEdits(row.edits);
    let songFrom = planned;
    if (row.lipSync && row.spec?.music && (!music || row.spec.music.key === music.key)) {
      songFrom = Math.max(0, row.spec.music.start - songStart + edits.trimIn * edits.speed);
    }
    const shot = {
      sceneId: row.id,
      position: row.position,
      description: row.description,
      durationSec: length,
      lipSync: row.lipSync,
      subtitles: row.subtitles,
      edits: row.edits,
      takeId: row.takeId ?? '',
      videoKey: row.videoKey ?? '',
      takeDuration: row.takeDuration === null ? null : Number(row.takeDuration),
      songFrom: +songFrom.toFixed(3),
      review: row.review,
      ready: row.takeStatus === 'READY' && Boolean(row.videoKey),
    };
    planned += length;
    return shot;
  });

  const chosen = all.filter((shot) => unique.includes(shot.sceneId)).sort((a, b) => a.position - b.position);
  if (chosen.length !== unique.length) throw AppError.badRequest('One of the selected scenes no longer exists. Refresh and select again.');
  const notReady = chosen.filter((shot) => !shot.ready);
  if (notReady.length) throw AppError.badRequest(`Scene ${notReady.map((shot) => shot.position + 1).join(', ')} has no finished video yet. Only scenes with a generated video can go in a quick clip.`);
  const order = all.map((shot) => shot.sceneId);
  for (let index = 1; index < chosen.length; index += 1) {
    if (order.indexOf(chosen[index]!.sceneId) !== order.indexOf(chosen[index - 1]!.sceneId) + 1) {
      throw AppError.badRequest('The scenes must follow each other on the storyboard (for example 3, 4 and 5).');
    }
  }
  return chosen.map(({ ready: _ready, ...shot }) => shot);
}

/** What the takes' reviews flagged (and the artist did not dismiss). */
function reviewWarnings(shots: Shot[]): string[] {
  return shots.flatMap((shot) => {
    const review = shot.review;
    if (!review || review.status !== 'DONE' || review.verdict !== 'FLAG' || review.dismissedAt) return [];
    const issues = (review.issues ?? []).filter((issue) => issue.severity !== 'low').map((issue) => issue.detail);
    return [`Scene ${shot.position + 1}: ${issues[0] ?? review.summary ?? 'flagged by the review'}`];
  });
}

const sanitizeName = (value: string): string =>
  value
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

/** A name that says what the clip is: title, the hook line heard in it (else the scenes), "teaser". */
async function suggestName(project: ProjectRow, shots: Shot[]): Promise<string> {
  const context = await songContext(project.id, { analyse: false }).catch(() => null);
  const songStart = Math.max(0, project.brief.songStart ?? 0);
  const from = shots[0]!.songFrom;
  const to = shots.at(-1)!.songFrom + shots.at(-1)!.durationSec;
  const line = context?.lines.find((item) => item.text.trim() && item.start - songStart >= from - 0.3 && item.start - songStart < to);
  const hook = line ? line.text.trim().split(/\s+/).slice(0, 6).join(' ').replace(/[,.;:!?]+$/, '') : null;
  const scenes = shots.length === 1 ? `scene ${shots[0]!.position + 1}` : `scenes ${shots[0]!.position + 1}–${shots.at(-1)!.position + 1}`;
  return sanitizeName(`${project.title} – ${hook ? `“${hook}”` : scenes} teaser`);
}

/* ------------------------------------------------------------------ API */

const clipView = (row: ClipRow) => ({
  id: row.id,
  name: row.name,
  sceneIds: row.sceneIds,
  status: row.status,
  stage: row.stage,
  progress: row.progress,
  detail: row.detail,
  durationSec: row.durationSec === null ? null : Number(row.durationSec),
  sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  watermarked: row.watermarked,
  report: row.report,
  tokensCharged: row.tokensCharged,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});
export type ClipView = ReturnType<typeof clipView>;

/** Price, length, the suggested name and what the reviews flagged: shown before anything is charged. */
export async function previewClip(auth: AuthContext, workspaceId: string, projectId: string, sceneIds: string[]) {
  await access(auth, workspaceId, true);
  const { project } = await load(workspaceId, projectId);
  if (!project.musicAssetId) throw AppError.badRequest('Upload the song first.');
  const shots = await resolveShots(project, sceneIds);
  const seconds = shots.reduce((sum, shot) => sum + shot.durationSec, 0);
  const settings = await getStudioSettings();
  const tokens = Math.max(1, Math.ceil(seconds / 60)) * settings.costs.assemblyPerMinute;
  return {
    seconds: +seconds.toFixed(2),
    tokens,
    suggestedName: await suggestName(project, shots),
    warnings: reviewWarnings(shots),
    watermarked: (await projectWatermarked(projectId)) && (await watermarkAvailable()),
    scenes: shots.map((shot) => ({ id: shot.sceneId, position: shot.position, lipSync: shot.lipSync })),
  };
}

export async function createClip(auth: AuthContext, workspaceId: string, projectId: string, input: { sceneIds: string[]; name: string }) {
  await access(auth, workspaceId, true);
  const { project } = await load(workspaceId, projectId);
  if (!project.musicAssetId) throw AppError.badRequest('Upload the song first.');
  const name = sanitizeName(input.name);
  if (name.length < 2) throw AppError.badRequest('Give the clip a name.');
  const shots = await resolveShots(project, input.sceneIds);
  const [busy] = await sql<{ id: string }[]>`SELECT id FROM mv_clips WHERE project_id = ${projectId} AND status IN ('QUEUED', 'RENDERING') LIMIT 1`;
  if (busy) throw AppError.conflict('A quick clip of this video is already being made. It downloads when it is ready.');

  const seconds = shots.reduce((sum, shot) => sum + shot.durationSec, 0);
  const settings = await getStudioSettings();
  const tokens = Math.max(1, Math.ceil(seconds / 60)) * settings.costs.assemblyPerMinute;
  await assertStorage(auth, Math.round(seconds * SIZE_ESTIMATE.assemblyPerSecond), 'the clip');
  const { reservation } = await reserveTokens(auth, workspaceId, 'MV_QUICK_CLIP', tokens, { projectId, seconds, scenes: shots.length });
  const watermarked = (await projectWatermarked(projectId)) && (await watermarkAvailable());
  try {
    const [row] = await sql<ClipRow[]>`
      INSERT INTO mv_clips (project_id, workspace_id, created_by_id, name, scene_ids, watermarked, reservation_id, detail)
      VALUES (${projectId}, ${workspaceId}, ${auth.userId}, ${name}, ${shots.map((shot) => shot.sceneId)}::uuid[], ${watermarked}, ${reservation.id}, 'Waiting for the mastering room')
      RETURNING *`;
    const { enqueueClip } = await import('../studio/queue.js');
    await enqueueClip(row!.id);
    return { clip: clipView(row!) };
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
}

export async function listClips(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, false);
  await load(workspaceId, projectId);
  const rows = await sql<ClipRow[]>`SELECT * FROM mv_clips WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 30`;
  return { clips: rows.map(clipView) };
}

export async function getClip(auth: AuthContext, workspaceId: string, projectId: string, clipId: string) {
  await access(auth, workspaceId, false);
  const [row] = await sql<ClipRow[]>`SELECT * FROM mv_clips WHERE id = ${clipId} AND project_id = ${projectId} AND workspace_id = ${workspaceId}`;
  if (!row) throw AppError.notFound('Clip');
  return { clip: clipView(row) };
}

/** A short-lived download link that saves the file under the clip's name. */
export async function clipDownload(auth: AuthContext, workspaceId: string, projectId: string, clipId: string) {
  await access(auth, workspaceId, false);
  const [row] = await sql<ClipRow[]>`SELECT * FROM mv_clips WHERE id = ${clipId} AND project_id = ${projectId} AND workspace_id = ${workspaceId}`;
  if (!row) throw AppError.notFound('Clip');
  if (row.status !== 'READY' || !row.outputKey) throw AppError.conflict('The clip is not ready yet.');
  return { url: await readUrl(row.outputKey, `${row.name}.mp4`), fileName: `${row.name}.mp4` };
}

/* ------------------------------------------------------------------ job */

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Average luma (0–255) and saturation of a stretch of a clip, from a few sampled frames. */
async function measure(file: string, from: number, length: number): Promise<{ y: number; sat: number } | null> {
  try {
    const log = await ffmpegLog(['-ss', from.toFixed(3), '-t', Math.max(0.5, length).toFixed(3), '-i', file, '-vf', 'fps=2,scale=320:-2,signalstats,metadata=print', '-an', '-f', 'null', '-']);
    const pick = (name: string): number[] => [...log.matchAll(new RegExp(`lavfi\\.signalstats\\.${name}=([0-9.]+)`, 'g'))].map((match) => Number(match[1]));
    const ys = pick('YAVG');
    const sats = pick('SATAVG');
    if (!ys.length) return null;
    return { y: ys.reduce((sum, value) => sum + value, 0) / ys.length, sat: sats.length ? sats.reduce((sum, value) => sum + value, 0) / sats.length : 0 };
  } catch {
    return null;
  }
}

export async function runQuickClip(clipId: string): Promise<void> {
  const [clip] = await withSqlRetry(() => sql<ClipRow[]>`SELECT * FROM mv_clips WHERE id = ${clipId}`);
  if (!clip || clip.status !== 'QUEUED') return;
  const workDir = await mkdtemp(join(tmpdir(), `clip-${clipId.slice(0, 8)}-`));
  const steps: string[] = [];
  const update = async (patch: Record<string, unknown>): Promise<void> => {
    await withSqlRetry(() => sql`UPDATE mv_clips SET ${sql(patch as Record<string, never>)} WHERE id = ${clipId}`);
  };
  const stageTo = async (stage: string, progress: number, detail: string): Promise<void> => {
    await update({ stage, progress, detail, status: 'RENDERING' });
    if (clip.reservationId) await touchReservation(clip.reservationId).catch(() => undefined);
  };

  try {
    await stageTo('CHECK', 3, 'VeloBot is reading the takes and the song');
    const [project] = await sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${clip.projectId}`;
    if (!project) throw new Error('The music video was deleted.');
    const finish: Finish = { ...DEFAULT_FINISH, ...project.finish };
    const settings = await getStudioSettings();
    const shots = await resolveShots(project, clip.sceneIds);
    const warnings = reviewWarnings(shots);
    const { width, height } = ASPECTS[project.aspect];
    const songStart = Math.max(0, project.brief.songStart ?? 0);
    const [song] = project.musicAssetId ? await sql<{ key: string }[]>`SELECT key FROM studio_assets WHERE id = ${project.musicAssetId} AND status = 'READY'` : [];
    if (!song) throw new Error('The song is missing. Upload it again.');
    const [mv] = await sql<{ subtitles: boolean }[]>`SELECT subtitles FROM mv_projects WHERE project_id = ${project.id}`;
    const context = await songContext(project.id).catch(() => null);

    /* ON THE BAR ----------------------------------------------------- */
    const lengths = shots.map((shot) => shot.durationSec);
    const downbeats = (context?.analysis?.downbeats ?? []).map((time) => time - songStart);
    const first = shots[0]!;
    const last = shots.at(-1)!;
    const headWindow = Math.min(1.5, first.durationSec * 0.3);
    const tailWindow = Math.min(1.5, last.durationSec * 0.3);
    const startBar = downbeats.find((time) => time >= first.songFrom - 0.01 && time <= first.songFrom + headWindow);
    const lastEnd = last.songFrom + last.durationSec;
    const endBar = [...downbeats].reverse().find((time) => time <= lastEnd + 0.01 && time >= lastEnd - tailWindow);
    let head = startBar !== undefined ? Math.max(0, startBar - first.songFrom) : 0;
    let tail = endBar !== undefined ? Math.max(0, lastEnd - endBar) : 0;
    if (shots.length === 1 && first.durationSec - head - tail < 2) head = tail = 0;
    // With one shot both trims come off the same shot.
    lengths[0] = lengths[0]! - head;
    lengths[lengths.length - 1] = lengths.at(-1)! - tail;
    if (head > 0.01 || tail > 0.01) steps.push(`Starts and ends on the bar (${head.toFixed(2)} s off the start, ${tail.toFixed(2)} s off the end; picture and sound together).`);

    /* DOWNLOAD + LIGHTING ------------------------------------------- */
    await stageTo('LIGHTING', 10, 'Matching the lighting across the shots');
    const sources: { file: string; available: number; trimIn: number }[] = [];
    for (const [index, shot] of shots.entries()) {
      const file = join(workDir, `take-${index}.mp4`);
      await downloadToFile(shot.videoKey, file);
      const media = await probe(file);
      const edits = parseEdits(shot.edits);
      const trimIn = edits.trimIn + (index === 0 ? head * edits.speed : 0);
      sources.push({ file, available: Math.max(0, media.durationSec - trimIn) / edits.speed, trimIn });
    }
    const measured = await Promise.all(shots.map((_, index) => measure(sources[index]!.file, sources[index]!.trimIn, lengths[index]!)));
    const known = measured.filter((value): value is { y: number; sat: number } => value !== null);
    const targetY = known.length ? median(known.map((value) => value.y)) : 0;
    const targetSat = known.length ? median(known.map((value) => value.sat)) : 0;
    const lighting = shots.map((shot, index) => {
      const value = measured[index];
      if (!value || known.length < 2) return { position: shot.position, brightness: 0, saturation: 1 };
      // eq brightness is added to normalised luma; ±0.07 keeps it a correction, not a look.
      const brightness = Math.max(-0.07, Math.min(0.07, (targetY - value.y) / 219));
      const saturation = value.sat > 1 ? Math.max(0.85, Math.min(1.2, targetSat / value.sat)) : 1;
      return { position: shot.position, brightness: +brightness.toFixed(3), saturation: +saturation.toFixed(3) };
    });
    if (lighting.some((item) => Math.abs(item.brightness) > 0.005 || Math.abs(item.saturation - 1) > 0.02)) steps.push('Lighting and colour matched across the shots.');

    /* PICTURE: conform each shot ------------------------------------ */
    const blends = shots.map((shot, index) => {
      if (index === 0) return 0;
      const before = shots[index - 1]!;
      if (shot.lipSync || before.lipSync) return 0;
      const spare = sources[index - 1]!.available - lengths[index - 1]!;
      return spare * FPS >= BLEND_FRAMES ? BLEND_FRAMES : 0;
    });
    const segments: string[] = [];
    for (const [index, shot] of shots.entries()) {
      await stageTo('PICTURE', 15 + Math.round((index / shots.length) * 40), `Cleaning and grading shot ${index + 1} of ${shots.length}`);
      const edits = { ...parseEdits(shot.edits), trimIn: sources[index]!.trimIn };
      const tailFrames = blends[index + 1] ?? 0;
      const frames = Math.max(1, Math.round(lengths[index]! * FPS)) + tailFrames;
      const length = frames / FPS;
      const pieces = clipFilters(edits, { width, height, fps: FPS, length });
      const hold = Math.max(0, length - sources[index]!.available + 0.05);
      const fix = lighting[index]!;
      const segment = join(workDir, `segment-${index}.mp4`);
      const filters = [
        ...pieces.early,
        `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${width}:${height}`,
        'setsar=1',
        `fps=${FPS}`,
        ...(hold > 0 ? [`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`] : []),
        ...pieces.late,
        // Gentle spatial + temporal denoise: cleans generation noise without smearing detail.
        'hqdn3d=1.5:1.2:4:4',
        ...(fix.brightness !== 0 || fix.saturation !== 1 ? [`eq=brightness=${fix.brightness}:saturation=${fix.saturation}`] : []),
        'format=yuv420p',
      ];
      await ffmpeg([...pieces.input, '-i', sources[index]!.file, '-frames:v', String(frames), '-vf', filters.join(','), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', segment]);
      segments.push(segment);
    }
    steps.push('Generation noise cleaned; every shot conformed to the frame and graded with the project look.');
    if (blends.some((frames) => frames > 0)) steps.push('Smooth half-beat dissolves between shots; hard cuts next to lip-synced shots keep the words on the mouth.');

    /* SUBTITLES ------------------------------------------------------ */
    const starts: number[] = [];
    lengths.reduce((at, length) => {
      starts.push(at);
      return at + length;
    }, 0);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const shotFroms = shots.map((shot, index) => shot.songFrom + (index === 0 ? head : 0));
    const toClip = (songTime: number): number | null => {
      const index = shotFroms.findIndex((from, i) => songTime >= from - 0.001 && songTime < from + lengths[i]!);
      return index < 0 ? null : starts[index]! + (songTime - shotFroms[index]!);
    };
    let subtitleFilter = '';
    let cueCount = 0;
    if (mv?.subtitles !== false && context?.lines.length) {
      const stamp = (seconds: number): string => {
        const ms = Math.max(0, Math.round(seconds * 1000));
        const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
        return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
      };
      const muted = shots.flatMap((shot, index) => (shot.subtitles === false ? [{ from: starts[index]!, to: starts[index]! + lengths[index]! }] : []));
      const cues = context.lines
        .filter((line) => line.text.trim())
        .flatMap((line) => {
          const songTime = line.start - songStart;
          // A line already being sung when the clip starts is shown from the first frame.
          const begin = toClip(songTime) ?? (songTime < shotFroms[0]! && line.end - songStart > shotFroms[0]! + 0.3 ? 0 : null);
          if (begin === null || begin >= total - 0.2) return [];
          if (muted.some((range) => begin >= range.from && begin < range.to)) return [];
          const end = Math.min(total, begin + Math.max(0.6, line.end - Math.max(line.start, songStart + shotFroms[0]!)));
          return [{ begin, end, text: line.text.trim() }];
        });
      const srt = join(workDir, 'lyrics.srt');
      if (cues.length) await writeFile(srt, cues.map((cue, index) => `${index + 1}\n${stamp(cue.begin)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n'), 'utf8');
      if (cues.length && (await canBurnSubtitles(srt).catch(() => false))) {
        const size = Math.round(height / 22);
        subtitleFilter = `subtitles=${filterPath(srt)}:force_style='FontName=Arial,Bold=1,FontSize=${Math.round(size / 2.2)},PrimaryColour=&H00FFFFFF,OutlineColour=&H99000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=${Math.round(height / 18 / 2.2)}'`;
        cueCount = cues.length;
        steps.push(`${cues.length} lyric line${cues.length === 1 ? '' : 's'} burned in, in time with the vocal.`);
      }
    }

    /* MASTER: join, finish, sound ---------------------------------- */
    await stageTo('MASTER', 60, 'Mastering picture and sound');
    const inputs = segments.flatMap((segment) => ['-i', segment]);
    const graph: string[] = [];
    let video = '[0:v]';
    let chainEnd = Math.round(lengths[0]! * FPS) + (blends[1] ?? 0);
    for (let index = 1; index < segments.length; index += 1) {
      const out = `[j${index}]`;
      const frames = blends[index]!;
      const length = Math.round(lengths[index]! * FPS) + (blends[index + 1] ?? 0);
      if (frames === 0) {
        graph.push(`${video}[${index}:v]concat=n=2:v=1:a=0${out}`);
        chainEnd += length;
      } else {
        const offset = chainEnd - frames;
        graph.push(`${video}[${index}:v]xfade=transition=fade:duration=${(frames / FPS).toFixed(4)}:offset=${(offset / FPS).toFixed(4)}${out}`);
        chainEnd = offset + length;
      }
      video = out;
    }
    const fadeOut = Math.min(0.8, total / 5);
    const finishing = [
      LOOKS[finish.look] ?? LOOKS.natural,
      'unsharp=5:5:0.35:5:5:0',
      ...(finish.grain > 0 ? [`noise=c0s=${Math.min(finish.grain, 10)}:c0f=t+u`] : []),
      'vignette=angle=PI/5:mode=backward',
      ...(subtitleFilter ? [subtitleFilter] : []),
      'fade=t=in:st=0:d=0.35',
      `fade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`,
      'format=yuv420p',
    ];
    graph.push(`${video}${finishing.join(',')}[graded]`);
    let videoOut = '[graded]';

    const audioIndex = segments.length;
    const songFile = join(workDir, 'song');
    await downloadToFile(song.key, songFile);
    const extra: string[] = ['-ss', songStart.toFixed(3), '-i', songFile];
    let logoIndex = -1;
    if (clip.watermarked && (await watermarkAvailable())) {
      logoIndex = audioIndex + 1;
      extra.push('-loop', '1', '-i', WATERMARK_FILE);
      const mark = watermarkFilters(videoOut, logoIndex, { width, height });
      graph.push(...mark.graph);
      videoOut = mark.label;
      steps.push('Watermarked.');
    }

    // Each shot's own slice of the song; contiguous slices play as one run (no seams).
    const runs: { from: number; length: number }[] = [];
    shots.forEach((_, index) => {
      const from = shotFroms[index]!;
      const previous = runs.at(-1);
      if (previous && Math.abs(previous.from + previous.length - from) < JOIN) previous.length += lengths[index]!;
      else runs.push({ from, length: lengths[index]! });
    });
    const edge = 0.012;
    graph.push(`[${audioIndex}:a]aresample=48000,asplit=${runs.length}${runs.map((_, index) => `[sp${index}]`).join('')}`);
    runs.forEach((run, index) => {
      graph.push(
        `[sp${index}]atrim=start=${run.from.toFixed(3)}:duration=${run.length.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${run.length.toFixed(3)},` +
          `afade=t=in:d=${edge},afade=t=out:st=${Math.max(0, run.length - edge).toFixed(3)}:d=${edge}[run${index}]`,
      );
    });
    const desk = masterAudioFilters(finish.audio);
    graph.push(
      `${runs.map((_, index) => `[run${index}]`).join('')}concat=n=${runs.length}:v=0:a=1,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
        // Broadband noise reduction (gentle: a mastered song keeps its air), rumble cut, the project's desk, then loudness.
        `afftdn=nr=8:nf=-42:tn=1,highpass=f=28,${desk.length ? `${desk.join(',')},` : ''}` +
        `loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,afade=t=in:d=0.25,afade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`,
    );
    steps.push('Song slices joined without seams; background noise reduced; mastered to −14 LUFS, −1 dBTP.');

    const output = join(workDir, 'clip.mp4');
    const thumb = join(workDir, 'clip.jpg');
    await ffmpeg(
      [
        ...inputs,
        ...extra,
        '-filter_complex', graph.join(';'),
        '-map', videoOut, '-map', '[aout]',
        '-t', total.toFixed(3), '-r', String(FPS),
        // A teaser is posted: capped near what feeds re-encode to (grain otherwise pushes ~40 Mbps, 80 MB for 16 s).
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-maxrate', '14M', '-bufsize', '28M', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', output,
      ],
      {
        onProgress: (seconds) => {
          const progress = Math.min(94, 60 + Math.round((seconds / total) * 34));
          void update({ progress, detail: `${Math.round(seconds)} of ${Math.round(total)} s mastered` }).catch(() => undefined);
        },
      },
    );

    await stageTo('UPLOAD', 96, 'Saving your clip');
    await thumbnail(output, thumb, Math.min(1.5, total / 3));
    const outputKey = `${keys.studio(project.workspaceId, project.id)}/clips/${clipId}.mp4`;
    const thumbKey = `${keys.studio(project.workspaceId, project.id)}/clips/${clipId}.jpg`;
    await Promise.all([uploadFile(outputKey, output, 'video/mp4'), uploadFile(thumbKey, thumb, 'image/jpeg')]);
    const size = (await stat(output)).size;

    const charge = Math.max(1, Math.ceil(total / 60)) * settings.costs.assemblyPerMinute;
    let charged = 0;
    if (clip.reservationId) {
      const settled = await settleSystem(clip.reservationId, clip.workspaceId, charge, `Music video · ${project.title.slice(0, 50)}: quick mix & master “${clip.name.slice(0, 50)}”, ${shots.length} scene(s), ${Math.round(total)} s`);
      charged = settled.actual ?? charge;
    }
    await update({
      status: 'READY',
      stage: 'DONE',
      progress: 100,
      detail: `${Math.round(total)} s teaser ready`,
      outputKey,
      thumbKey,
      durationSec: +total.toFixed(3),
      sizeBytes: size,
      tokensCharged: charged,
      report: json({ steps, warnings, trimmed: { head: +head.toFixed(3), tail: +tail.toFixed(3) }, lighting, subtitles: cueCount } satisfies ClipReport),
      finishedAt: new Date(),
      error: null,
    });
    logger.info({ clipId, projectId: project.id, seconds: total, bytes: size, tokens: charged }, 'quick clip mastered');
  } catch (error) {
    logger.error({ err: error, clipId }, 'quick clip failed');
    if (clip.reservationId) await releaseSystem(clip.reservationId, clip.workspaceId).catch(() => undefined);
    const message = error instanceof AppError ? error.message : 'The clip could not be mastered. Nothing was charged; try again.';
    await update({ status: 'FAILED', stage: 'FAILED', error: message.slice(0, 1000), detail: message.slice(0, 300), finishedAt: new Date() }).catch(() => undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
