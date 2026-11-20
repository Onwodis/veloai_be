/**
 * Music video director: a staged production on top of the studio engine.
 *
 *   SONG        upload the song; title, genre, lead act, vision, mood; lyrics
 *   SOUND       DAW edits (cut / gain / swap regions, effect layers) → working mix
 *   CHARACTERS  lead (+ co-leads for a duo/trio), second lead, vixens, dancers…
 *               detailed attributes, costumes, photos + videos, AI casting
 *               sheet, the artist's permission per person, approval per person
 *   SCENES      the artist's scene ideas → director-expanded plans; approve each
 *   DISCUSSION  the director's room (debate with real-video references);
 *               proposals apply to scenes with one click
 *   STORYBOARD  the final timeline: INTRO → story → OUTRO, timed to the song;
 *               approve each scene
 *   SHOOT       any scene, in any order: generate takes, pick, approve. Or "I trust your judgement": generate, pick and stitch all
 *   MASTER      the final cut, loudness-normalised (default -14 LUFS)
 *
 * Every stage reached so far stays editable (no reopen needed to go back and
 * change something). A later stage opens from the stage bar once the stages
 * before it have what they need (openStage). Reopening a stage still exists
 * to clear its approval and every later one on purpose.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../middleware/authenticate.js';
import { deleteObject, deletePrefix, getObjectStream, keys, readUrl } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import * as studio from '../studio/service.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { PerformanceEmotion } from '../studio/cinema.js';
import type { AssetRow, ProjectRow, SceneRow, TakeRow } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { titleCase } from '../utils/names.js';
import { publishProgress } from '../realtime/events.js';
import { arrange, fxFilters, isIdentityArrangement, mixDuration, renderMix, transcribeSong, transcriptionPrompt, videoFrames, type AudioEdits, type AudioTrack, type Clip, type Lyrics, type Region, type TrackFx } from './audio.js';
import type { CharacterAttributes, CharacterRow, Costume } from './cast.js';
import { meContext } from '../likeness/service.js';
import { castCharacter, correctLyrics, detectPeople, discuss, expandScene, polishLyrics, profileVoice, proofreadLyrics, storyboard, type DirectorContext } from './director.js';
import { polishProject, type PolishReport } from './polish.js';
import { dismissReview, reviewTake } from './review.js';
import type { ProjectCategory } from '../config/categories.js';
import { aiMaster } from './mastering.js';
import { ANALYSIS_VERSION, analyseAudio, type AudioAnalysis } from './analysis.js';
import { directionSchema, lockToSong, parseDirection, placeText, songContext, songMapText, type Direction } from './songmap.js';
import { parseTitles, titlesSchema, type Titles } from './titles.js';

export const STAGES = ['SONG', 'SOUND', 'CHARACTERS', 'SCENES', 'DISCUSSION', 'STORYBOARD', 'SHOOT', 'MASTER'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  SONG: 'Song & vision',
  SOUND: 'Sound (DAW)',
  CHARACTERS: 'Characters & costumes',
  SCENES: 'Scene ideas',
  DISCUSSION: "Director's room",
  STORYBOARD: 'Storyboard',
  SHOOT: 'Shoot',
  MASTER: 'Master',
};

interface MvRow {
  projectId: string;
  workspaceId: string;
  artistName: string;
  genre: string;
  vision: string;
  mood: string;
  leadAct: 'SOLO' | 'DUO' | 'TRIO' | 'GROUP';
  stage: Stage;
  approvals: Partial<Record<Stage, string>>;
  originalSongId: string | null;
  audioEdits: AudioEdits;
  mixRenderedAt: Date | null;
  loudnessLufs: number;
  lyrics: Lyrics | null;
  lyricsJob: LyricsJob | null;
  polish: PolishReport | null;
  sequence: Sequence | null;
  audioAnalysis: Record<string, AudioAnalysis>;
  autoMode: boolean;
  creativeMode: boolean;
  cameraEnergy: 'natural' | 'bold' | 'wild';
  visualStyle: 'human' | 'animated-3d' | 'anime' | 'comic' | 'clay';
  subtitles: boolean;
  foley: boolean;
  autoApprove: boolean;
  autoBy: { userId: string; role: AuthContext['role'] } | null;
  /** Opening titles (migration 017); null = never set. */
  titles: unknown;
  /** The artist's direction settings (migration 017). */
  direction: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface MessageRow {
  id: string;
  projectId: string;
  author: 'CREATOR' | 'DIRECTOR';
  content: string;
  refs: { title: string; artist: string; year: string; director: string; why: string }[];
  proposals: { id: string; sceneId: string | null; summary: string; change: { description?: string; location?: string; costume?: string; durationSec?: number }; applied: boolean }[];
  /** The director's proposed opening titles (migration 017). */
  titles: (Titles & { why: string; applied: boolean }) | null;
  createdAt: Date;
}

const LEAD_COUNT: Record<MvRow['leadAct'], number> = { SOLO: 1, DUO: 2, TRIO: 3, GROUP: 4 };

/* ------------------------------------------------------------------ access + loading */

export async function access(auth: AuthContext, workspaceId: string, write: boolean): Promise<void> {
  if (auth.role === 'SUPER_ADMIN') return;
  await requireMembership(auth.userId, workspaceId, write ? ['OWNER', 'EDITOR'] : undefined);
}

export async function load(workspaceId: string, projectId: string): Promise<{ project: ProjectRow; mv: MvRow }> {
  const [project] = await sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND kind = 'MUSIC_VIDEO' AND deleted_at IS NULL`;
  if (!project) throw AppError.notFound('Music video');
  let [mv] = await sql<MvRow[]>`SELECT * FROM mv_projects WHERE project_id = ${projectId}`;
  // Music videos made in the old studio flow join the director at the first stage.
  if (!mv) [mv] = await sql<MvRow[]>`INSERT INTO mv_projects (project_id, workspace_id, vision) VALUES (${projectId}, ${workspaceId}, ${project.brief.style ?? ''}) RETURNING *`;
  return { project, mv: mv! };
}

/**
 * Edits are allowed on every stage the production has reached: the artist moves freely back
 * and forth (changing the song, a costume or an early scene never needs a "reopen"). A stage
 * not reached yet is opened with openStage(), which checks it has what it needs.
 */
export function assertStage(mv: MvRow, ...allowed: Stage[]): void {
  const reached = STAGES.indexOf(mv.stage);
  if (allowed.some((stage) => STAGES.indexOf(stage) <= reached)) return;
  throw AppError.conflict(`This is part of “${STAGE_LABEL[allowed[0]!]}”, which isn't open yet: open it from the stage bar (it checks what it needs first).`);
}

export async function touch(projectId: string): Promise<void> {
  await sql`UPDATE mv_projects SET updated_at = now() WHERE project_id = ${projectId}`;
  await sql`UPDATE studio_projects SET updated_at = now() WHERE id = ${projectId}`;
}

/** Runs a token-gated AI step: reserve → work → settle (or release on failure). */
export async function charged<T>(auth: AuthContext, workspaceId: string, projectId: string, kind: string, tokens: number, note: string, work: () => Promise<T>): Promise<T> {
  const { reservation } = await reserveTokens(auth, workspaceId, kind, tokens, { projectId });
  try {
    const result = await work();
    await settleSystem(reservation.id, workspaceId, tokens, note);
    if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${tokens} WHERE id = ${projectId}`;
    return result;
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ views */

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

async function characterView(character: CharacterRow, assets: Map<string, AssetRow>) {
  return {
    id: character.id,
    position: character.position,
    role: character.role,
    name: titleCase(character.name),
    isArtist: character.isArtist,
    attributes: character.attributes,
    costumes: character.costumes,
    media: await Promise.all(
      character.mediaAssetIds.flatMap((id) => {
        const asset = assets.get(id);
        return asset ? [(async () => ({ id: asset.id, role: asset.role, name: asset.name, url: asset.status === 'READY' ? await readUrl(asset.key) : null }))()] : [];
      }),
    ),
    referenceCount: character.referenceKeys.length,
    profile: character.profile,
    performance: character.performance ?? null,
    expressionUrls: await Promise.all((character.expressionKeys ?? []).map((key) => readUrl(key))),
    prompt: character.prompt,
    castEngine: character.castEngine,
    consentAt: iso(character.consentAt),
    approvedAt: iso(character.approvedAt),
    isMe: Boolean(character.likenessUserId),
  };
}

/**
 * Every mv_projects column the view reads. audio_analysis (the song's beat / energy map,
 * often hundreds of KB) is left out: the view never uses it, and it was sent on every
 * load and every poll.
 */
const MV_VIEW_COLUMNS = [
  'project_id', 'workspace_id', 'genre', 'vision', 'mood', 'lead_act', 'stage', 'approvals', 'original_song_id', 'audio_edits', 'mix_rendered_at',
  'loudness_lufs', 'lyrics', 'auto_mode', 'auto_by', 'created_at', 'updated_at', 'artist_name', 'lyrics_job', 'polish', 'sequence', 'creative_mode', 'camera_energy', 'visual_style',
  'subtitles', 'foley', 'auto_approve', 'titles', 'direction',
];

export async function view(auth: AuthContext, workspaceId: string, projectId: string) {
  // Two round trips in all: everything that needs only the ids, then everything that needs the project.
  const [, [project], [mvRow], assets] = await Promise.all([
    access(auth, workspaceId, false),
    sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND kind = 'MUSIC_VIDEO' AND deleted_at IS NULL`,
    sql<MvRow[]>`SELECT ${sql(MV_VIEW_COLUMNS)} FROM mv_projects WHERE project_id = ${projectId}`,
    sql<AssetRow[]>`SELECT * FROM studio_assets WHERE project_id = ${projectId}`,
  ]);
  if (!project) throw AppError.notFound('Music video');
  // Music videos made in the old studio flow join the director here (rare: one-off).
  const mv = mvRow ?? (await load(workspaceId, projectId)).mv;
  const [base, characters, messages, settings] = await Promise.all([
    studio.projectView(project, { assets }),
    sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId} ORDER BY position, created_at`,
    // The latest 200 messages of the director's room (oldest first); the rest stay in the database.
    sql<MessageRow[]>`SELECT * FROM (SELECT * FROM mv_messages WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 200) recent ORDER BY created_at`,
    getStudioSettings(),
  ]);
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const original = mv.originalSongId ? assetMap.get(mv.originalSongId) : base.musicAssetId ? assetMap.get(base.musicAssetId) : undefined;
  const current = STAGES.indexOf(mv.stage);
  return {
    ...base,
    title: titleCase(base.title),
    director: {
      artistName: titleCase(mv.artistName),
      genre: mv.genre,
      vision: mv.vision,
      mood: mv.mood,
      leadAct: mv.leadAct,
      stage: mv.stage,
      stages: STAGES.map((key, index) => ({ key, label: STAGE_LABEL[key], approvedAt: mv.approvals[key] ?? null, status: index < current ? 'approved' : index === current ? 'current' : 'locked' })),
      originalSong: original ? { id: original.id, name: original.name, url: await readUrl(original.key), durationSec: original.meta.durationSec ?? null } : null,
      audioEdits: mv.audioEdits,
      mixRenderedAt: iso(mv.mixRenderedAt),
      mixDurationSec: original?.meta.durationSec ? +mixDuration(original.meta.durationSec, mv.audioEdits).toFixed(2) : null,
      loudnessLufs: mv.loudnessLufs,
      lyrics: mv.lyrics,
      // A RUNNING job that stopped updating was lost to a restart: report it as failed.
      lyricsJob:
        mv.lyricsJob?.status === 'RUNNING' && Date.now() - new Date(mv.lyricsJob.startedAt).getTime() > LYRICS_STALE_MS
          ? { ...mv.lyricsJob, status: 'FAILED' as const, error: 'Transcription was interrupted (the server restarted). Run it again.' }
          : mv.lyricsJob,
      autoMode: mv.autoMode,
      options: { creativeMode: mv.creativeMode, cameraEnergy: mv.cameraEnergy ?? 'bold', visualStyle: mv.visualStyle ?? 'human', subtitles: mv.subtitles, foley: mv.foley, autoApprove: mv.autoApprove },
      polish: mv.polish,
      sequence: mv.sequence,
      effects: await Promise.all(
        assets
          .filter((asset) => asset.role === 'SFX' && asset.status === 'READY')
          .map(async (asset) => ({ id: asset.id, name: asset.name, url: await readUrl(asset.key), durationSec: asset.meta.durationSec ?? null })),
      ),
      characters: await Promise.all(characters.map((character) => characterView(character, assetMap))),
      messages: messages.map((message) => ({
        id: message.id,
        author: message.author,
        content: message.content,
        refs: message.refs,
        proposals: message.proposals,
        titles: message.titles ?? null,
        createdAt: message.createdAt.toISOString(),
      })),
      titles: parseTitles(mv.titles, titleCase(mv.artistName), titleCase(base.title)),
      titlesSet: mv.titles !== null && mv.titles !== undefined,
      direction: parseDirection(mv.direction),
      costs: {
        casting: settings.costs.mvCasting,
        scene: settings.costs.mvScene,
        chat: settings.costs.mvChat,
        storyboard: settings.costs.mvStoryboard,
        lyricsPerMinute: settings.costs.mvLyricsPerMinute,
        mix: settings.costs.mvMix,
        foleyPerSecond: settings.models.foley.enabled ? settings.costs.foleyPerSecond : 0,
        characterStill: settings.costs.characterStill,
        /** A look created from the description: portrait + full body + the casting sheet. */
        characterLook: settings.costs.image + settings.costs.imageEdit + settings.costs.mvCasting,
        videoEditPerSecond: settings.costs.videoEditPerSecond,
        // About one 6 s lip-synced shot: what the low-balance banner compares against.
        typicalShot: settings.costs.keyframe + 6 * (settings.costs.videoPerSecond + settings.costs.lipSyncPerSecond),
      },
    },
  };
}
export type MusicVideoView = Awaited<ReturnType<typeof view>>;

export async function list(
  auth: AuthContext,
  workspaceId: string,
  filters: { category?: ProjectCategory | undefined; scope: 'all' | 'mine' | 'shared'; sort: 'updated' | 'created' | 'size' | 'title' } = { scope: 'all', sort: 'updated' },
) {
  await access(auth, workspaceId, false);
  const order = { updated: sql`p.updated_at DESC`, created: sql`p.created_at DESC`, size: sql`size_bytes DESC, p.updated_at DESC`, title: sql`lower(p.title)` }[filters.sort];
  const rows = await sql<(ProjectRow & { stage2: Stage | null; thumbAny: string | null; sizeBytes: string; category: string; ownerName: string | null })[]>`
    SELECT p.*, m.stage AS stage2, u.display_name AS owner_name,
      COALESCE(p.thumb_key, (SELECT t.thumb_key FROM studio_takes t WHERE t.project_id = p.id AND t.status = 'READY' ORDER BY t.created_at DESC LIMIT 1)) AS thumb_any,
      -- Size on disk: every stored file of the project (takes, uploads, mixes, the film).
      (SELECT COALESCE(sum(o.bytes), 0) FROM storage_objects o WHERE o.key LIKE ${`workspaces/${workspaceId}/studio/`} || p.id::text || '/%')::text AS size_bytes
    FROM studio_projects p LEFT JOIN mv_projects m ON m.project_id = p.id LEFT JOIN users u ON u.id = p.created_by_id
    WHERE p.workspace_id = ${workspaceId} AND p.kind = 'MUSIC_VIDEO' AND p.deleted_at IS NULL
      ${filters.category ? sql`AND p.category = ${filters.category}` : sql``}
      ${filters.scope === 'mine' ? sql`AND p.created_by_id = ${auth.userId}` : filters.scope === 'shared' ? sql`AND p.created_by_id IS DISTINCT FROM ${auth.userId}` : sql``}
    ORDER BY ${order} LIMIT 200`;
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      title: titleCase(row.title),
      status: row.status,
      stage: row.stage2 ?? 'SONG',
      stageLabel: STAGE_LABEL[row.stage2 ?? 'SONG'],
      category: row.category,
      mine: row.createdById === auth.userId,
      ownerName: row.ownerName,
      sizeBytes: Number(row.sizeBytes),
      hasOutput: Boolean(row.outputKey),
      thumbUrl: row.thumbAny ? await readUrl(row.thumbAny) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  );
}

/* ------------------------------------------------------------------ create + song */

export async function create(auth: AuthContext, workspaceId: string, input: { title: string; artistName: string; aspect: '16:9' | '9:16' | '1:1'; category: ProjectCategory; visualStyle?: 'human' | 'animated-3d' | 'anime' | 'comic' | 'clay' | undefined }) {
  const project = await studio.createProject(auth, workspaceId, { kind: 'MUSIC_VIDEO', category: input.category, title: input.title, aspect: input.aspect, brief: {} });
  await sql`INSERT INTO mv_projects (project_id, workspace_id, artist_name, visual_style) VALUES (${project.id}, ${workspaceId}, ${input.artistName}, ${input.visualStyle ?? 'human'}) ON CONFLICT DO NOTHING`;
  return view(auth, workspaceId, project.id);
}

export async function updateSong(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  input: {
    title?: string | undefined;
    artistName?: string | undefined;
    aspect?: '16:9' | '9:16' | '1:1' | undefined;
    genre?: string | undefined;
    vision?: string | undefined;
    mood?: string | undefined;
    leadAct?: MvRow['leadAct'] | undefined;
  },
) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SONG');
  await sql`
    UPDATE mv_projects SET artist_name = ${input.artistName ?? mv.artistName}, genre = ${input.genre ?? mv.genre}, vision = ${input.vision ?? mv.vision}, mood = ${input.mood ?? mv.mood}, lead_act = ${input.leadAct ?? mv.leadAct}, updated_at = now()
    WHERE project_id = ${projectId}`;
  await sql`
    UPDATE studio_projects SET title = ${input.title ?? project.title}, aspect = ${input.aspect ?? project.aspect},
      brief = ${json({ ...project.brief, style: [input.vision ?? mv.vision, input.mood ?? mv.mood].filter(Boolean).join('. ').slice(0, 600) })}, updated_at = now()
    WHERE id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/** Creative mode, lyric subtitles and foley: switchable at any stage. */
export async function setOptions(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  input: { creativeMode?: boolean | undefined; cameraEnergy?: 'natural' | 'bold' | 'wild' | undefined; visualStyle?: 'human' | 'animated-3d' | 'anime' | 'comic' | 'clay' | undefined; subtitles?: boolean | undefined; foley?: boolean | undefined; autoApprove?: boolean | undefined },
) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  await sql`
    UPDATE mv_projects SET creative_mode = COALESCE(${input.creativeMode ?? null}::boolean, creative_mode), camera_energy = COALESCE(${input.cameraEnergy ?? null}::varchar, camera_energy), visual_style = COALESCE(${input.visualStyle ?? null}::varchar, visual_style), subtitles = COALESCE(${input.subtitles ?? null}::boolean, subtitles),
      foley = COALESCE(${input.foley ?? null}::boolean, foley), auto_approve = COALESCE(${input.autoApprove ?? null}::boolean, auto_approve), updated_at = now()
    WHERE project_id = ${projectId}`;
  if (input.autoApprove) await autoApprove(projectId);
  return view(auth, workspaceId, projectId);
}

export interface LyricsJob {
  status: 'RUNNING' | 'DONE' | 'FAILED';
  progress: number;
  lines: Lyrics['lines'];
  error: string | null;
  startedAt: string;
}

/** A RUNNING job older than this was lost to a restart. */
const LYRICS_STALE_MS = 45 * 60_000;

/**
 * Starts lyric transcription in the background and returns at once. Progress
 * (fraction + the lines heard so far) is saved on the project and pushed live;
 * tokens are reserved up front and settled when it finishes (released on failure).
 */
export async function transcribeLyrics(auth: AuthContext, workspaceId: string, projectId: string, hint?: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  const running = mv.lyricsJob?.status === 'RUNNING' && Date.now() - new Date(mv.lyricsJob.startedAt).getTime() < LYRICS_STALE_MS;
  if (running) throw AppError.conflict('The lyrics are already being transcribed.');
  const songId = mv.originalSongId ?? project.musicAssetId;
  const [song] = songId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${songId} AND status = 'READY'` : [];
  if (!song) throw AppError.badRequest('Upload the song first.');
  const { costs } = await getStudioSettings();
  const minutes = Math.max(1, Math.ceil((song.meta.durationSec ?? 240) / 60));
  const tokens = costs.mvLyricsPerMinute * minutes;
  const { reservation } = await reserveTokens(auth, workspaceId, 'MV_LYRICS', tokens, { projectId });

  const job = (patch: Partial<LyricsJob>, base: LyricsJob): LyricsJob => ({ ...base, ...patch });
  let state: LyricsJob = { status: 'RUNNING', progress: 0, lines: [], error: null, startedAt: new Date().toISOString() };
  const save = async (next: LyricsJob): Promise<void> => {
    state = next;
    await sql`UPDATE mv_projects SET lyrics_job = ${json(next)}, updated_at = now() WHERE project_id = ${projectId}`;
    publishProgress({ kind: 'studio', workspaceId, projectId, stage: 'LYRICS', status: next.status, progress: Math.round(next.progress * 100), detail: next.lines.at(-1)?.text ?? '' });
  };
  await save(state);

  void (async () => {
    try {
      const prompt = transcriptionPrompt(hint, mv.lyrics?.languages ?? null);
      const lyrics = await transcribeSong(song.key, (progress) => save(job({ progress: progress.fraction, lines: progress.lines }, state)), prompt);
      const { seconds: _seconds, ...rest } = lyrics;
      const stored: Lyrics = { ...rest, languages: mv.lyrics?.languages ?? null };
      await settleSystem(reservation.id, workspaceId, tokens, `Music video · ${project.title.slice(0, 50)}: lyrics (${minutes} min)`);
      if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${tokens} WHERE id = ${projectId}`;
      await sql`UPDATE mv_projects SET lyrics = ${json(stored)} WHERE project_id = ${projectId}`;
      await save(job({ status: 'DONE', progress: 1, lines: stored.lines }, state));
      // The voice as a background cue (accent + region, from the words). Best effort, free.
      void refreshVoice(projectId, stored, { title: project.title, artist: mv.artistName, genre: mv.genre });
    } catch (error) {
      await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
      logger.error({ err: error, projectId }, 'lyric transcription failed');
      await save(job({ status: 'FAILED', error: message }, state)).catch(() => undefined);
    }
  })();
  return view(auth, workspaceId, projectId);
}

/**
 * Smart correction: the artist's edited lines are saved, then the director
 * fixes every other line where the same words were misheard. Returns how many
 * extra lines it fixed (shown to the artist). Charged like a director reply.
 */
export async function smartCorrectLyrics(auth: AuthContext, workspaceId: string, projectId: string, corrections: { index: number; text: string }[]) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  if (!mv.lyrics?.lines.length) throw AppError.badRequest('Transcribe the lyrics first.');
  const lines = mv.lyrics.lines.map((line) => ({ ...line }));
  const pairs = corrections
    .filter((item) => item.index >= 0 && item.index < lines.length && item.text.trim() && item.text.trim() !== lines[item.index]!.text)
    .map((item) => ({ index: item.index, before: lines[item.index]!.text, after: item.text.trim() }));
  if (pairs.length === 0) throw AppError.badRequest('Change at least one line first.');
  for (const pair of pairs) lines[pair.index]!.text = pair.after;
  const { costs } = await getStudioSettings();
  const result = await charged(auth, workspaceId, projectId, 'MV_LYRICS_FIX', costs.mvChat, `Music video · ${project.title.slice(0, 50)}: lyric corrections`, () =>
    correctLyrics(lines, pairs, { title: project.title, artist: mv.artistName, genre: mv.genre }),
  );
  const corrected = new Set(pairs.map((pair) => pair.index));
  let fixed = 0;
  for (const change of result.changes) {
    if (corrected.has(change.index) || lines[change.index]!.text === change.text) continue;
    lines[change.index]!.text = change.text.trim();
    fixed += 1;
  }
  const lyrics: Lyrics = { text: lines.map((line) => line.text).join('\n'), lines, language: mv.lyrics.language, languages: mv.lyrics.languages ?? null, voice: mv.lyrics.voice ?? null, engine: `${mv.lyrics.engine} + artist + AI corrections` };
  await sql`UPDATE mv_projects SET lyrics = ${json(lyrics)}, updated_at = now() WHERE project_id = ${projectId}`;
  return { project: await view(auth, workspaceId, projectId), fixed };
}

/**
 * Smart save: saves the edited lyrics (lines may have been added / removed),
 * then, when asked, the director uses the artist's corrections (before → after)
 * to fix every other place the same words were misheard, fuzzy variants included.
 */
export async function smartSaveLyrics(auth: AuthContext, workspaceId: string, projectId: string, input: Lyrics['lines'], pairs: { index: number; before: string; after: string }[], ai: boolean) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  const lines = input.filter((line) => line.text.trim()).map((line) => ({ start: +line.start.toFixed(2), end: +Math.max(line.start + 0.1, line.end).toFixed(2), text: line.text.trim() }));
  let fixed = 0;
  const changed: number[] = [];
  const hints = pairs.filter((pair) => pair.index < lines.length && pair.before.trim() !== pair.after.trim());
  if (ai && hints.length && lines.length) {
    const { costs } = await getStudioSettings();
    const result = await charged(auth, workspaceId, projectId, 'MV_LYRICS_FIX', costs.mvChat, `Music video · ${project.title.slice(0, 50)}: smart lyric save`, () =>
      correctLyrics(lines, hints, { title: project.title, artist: mv.artistName, genre: mv.genre }),
    );
    const corrected = new Set(hints.map((pair) => pair.index));
    for (const change of result.changes) {
      const line = lines[change.index];
      if (!line || corrected.has(change.index) || !change.text.trim() || line.text === change.text.trim()) continue;
      line.text = change.text.trim();
      changed.push(change.index);
      fixed += 1;
    }
  }
  const lyrics: Lyrics = {
    text: lines.map((line) => line.text).join('\n'),
    lines,
    language: mv.lyrics?.language ?? null,
    languages: mv.lyrics?.languages ?? null,
    voice: mv.lyrics?.voice ?? null,
    engine: mv.lyrics ? `${mv.lyrics.engine.replace(/ \+ artist.*$/, '')} + artist${fixed ? ' + AI corrections' : ''}` : 'artist',
  };
  await sql`UPDATE mv_projects SET lyrics = ${json(lyrics)}, updated_at = now() WHERE project_id = ${projectId}`;
  return { project: await view(auth, workspaceId, projectId), fixed, changed };
}

/** Per-scene lyric subtitles (any stage: it only affects the burned-in captions). */
export async function setSceneSubtitles(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, on: boolean) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const rows = await sql`UPDATE studio_scenes SET subtitles = ${on}, updated_at = now() WHERE id = ${sceneId} AND project_id = ${projectId} RETURNING id`;
  if (rows.length === 0) throw AppError.notFound('Scene');
  return view(auth, workspaceId, projectId);
}

/**
 * "Use my lines": the artist wrote a few lines correctly; the director learns
 * their language / pidgin / spelling from them, detects the song's languages
 * (saved on the lyrics) and rewrites every unclear or badly transcribed line.
 * Returns suggestions for the editor (the lyric text only changes when the
 * artist saves). Charged like a director reply.
 */
export async function polishWithSamples(auth: AuthContext, workspaceId: string, projectId: string, lines: Lyrics['lines'], samples: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  if (!lines.some((line) => line.text.trim())) throw AppError.badRequest('Transcribe the lyrics first (or paste them), then write a few lines yourself.');
  const { costs } = await getStudioSettings();
  const result = await charged(auth, workspaceId, projectId, 'MV_LYRICS_FIX', costs.mvChat, `Music video · ${project.title.slice(0, 50)}: lyrics from the artist's lines`, () =>
    polishLyrics(lines, samples, { title: project.title, artist: mv.artistName, genre: mv.genre }),
  );
  const language = [result.languages.primary, ...result.languages.others].join(' + ');
  if (mv.lyrics) await sql`UPDATE mv_projects SET lyrics = ${json({ ...mv.lyrics, language, languages: result.languages })}, updated_at = now() WHERE project_id = ${projectId}`;
  return { project: await view(auth, workspaceId, projectId), languages: result.languages, changes: result.changes };
}

/** AI proofreading: suggested corrections for probably-misheard lines (nothing is changed). */
export async function proofread(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  if (!mv.lyrics?.lines.length) throw AppError.badRequest('Transcribe the lyrics first.');
  const { costs } = await getStudioSettings();
  const result = await charged(auth, workspaceId, projectId, 'MV_LYRICS_PROOF', costs.mvChat, `Music video · ${project.title.slice(0, 50)}: lyric proofreading`, () =>
    proofreadLyrics(mv.lyrics!.lines, { title: project.title, artist: mv.artistName, genre: mv.genre, vision: mv.vision }),
  );
  return { suggestions: result.suggestions };
}

/** The artist's corrections to the lyric lines. */
export async function updateLyrics(auth: AuthContext, workspaceId: string, projectId: string, lines: { start: number; end: number; text: string }[]) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  const lyrics: Lyrics = { text: lines.map((line) => line.text).join('\n'), lines, language: mv.lyrics?.language ?? null, languages: mv.lyrics?.languages ?? null, voice: mv.lyrics?.voice ?? null, engine: mv.lyrics ? `${mv.lyrics.engine} + artist edits` : 'artist' };
  await sql`UPDATE mv_projects SET lyrics = ${json(lyrics)}, updated_at = now() WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ sound (DAW) */

export async function saveAudio(auth: AuthContext, workspaceId: string, projectId: string, edits: AudioEdits, loudnessLufs?: number) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SOUND', 'MASTER');
  if (mv.stage === 'MASTER') {
    // At the master stage only the loudness target can change (the picture is cut to the mix).
    if (loudnessLufs !== undefined) await sql`UPDATE mv_projects SET loudness_lufs = ${loudnessLufs}, updated_at = now() WHERE project_id = ${projectId}`;
    return view(auth, workspaceId, projectId);
  }
  await sql`
    UPDATE mv_projects SET audio_edits = ${json({ ...edits, clips: undefined })}, mix_rendered_at = NULL, loudness_lufs = ${loudnessLufs ?? mv.loudnessLufs}, updated_at = now()
    WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/** Renders the DAW edits into the working mix (the song every later stage uses). */
export async function buildMix(auth: AuthContext, workspaceId: string, project: ProjectRow, mv: MvRow): Promise<void> {
  const originalId = mv.originalSongId ?? project.musicAssetId;
  const [song] = originalId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${originalId}` : [];
  if (!song) throw AppError.badRequest('Upload the song first.');
  const edits = mv.audioEdits;
  // An arrangement that is just the untouched song needs no render.
  const plain = (edits.clips?.length ? isIdentityArrangement(song.meta.durationSec ?? 0, edits.clips) && !edits.gainDb : edits.regions.length === 0) && fxFilters(edits.musicFx).length === 0;
  if (plain && edits.layers.length === 0) {
    // No edits: the original song is the mix.
    await sql`UPDATE studio_projects SET music_asset_id = ${song.id} WHERE id = ${project.id}`;
    await sql`UPDATE mv_projects SET mix_rendered_at = now() WHERE project_id = ${project.id}`;
    return;
  }
  const effects = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE project_id = ${project.id} AND role = 'SFX' AND status = 'READY'`;
  const layerKeys = new Map(effects.map((asset) => [asset.id, asset.key]));
  const { costs } = await getStudioSettings();
  const [mix] = await sql<AssetRow[]>`
    INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta, status)
    VALUES (${project.id}, ${workspaceId}, 'MIX', '', 'mix.m4a', 'audio/mp4', 0, '{}'::jsonb, 'PENDING') RETURNING *`;
  const key = keys.studioAsset(workspaceId, project.id, mix!.id, 'mix.m4a');
  try {
    const seconds = await charged(auth, workspaceId, project.id, 'MV_MIX', costs.mvMix, `Music video · ${project.title.slice(0, 50)}: mix render`, () => renderMix(song.key, edits, layerKeys, key));
    await sql`UPDATE studio_assets SET key = ${key}, status = 'READY', meta = ${json({ durationSec: +seconds.toFixed(3) })} WHERE id = ${mix!.id}`;
  } catch (error) {
    await sql`DELETE FROM studio_assets WHERE id = ${mix!.id}`;
    throw error;
  }
  // Older mixes are replaced (the original upload is always kept).
  const old = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE project_id = ${project.id} AND role = 'MIX' AND id <> ${mix!.id}`;
  await sql`UPDATE studio_projects SET music_asset_id = ${mix!.id}, brief = ${json({ ...project.brief, songStart: 0 })} WHERE id = ${project.id}`;
  for (const asset of old) await studio.deleteAsset(auth, workspaceId, project.id, asset.id).catch(() => undefined);
  await sql`UPDATE mv_projects SET mix_rendered_at = now() WHERE project_id = ${project.id}`;
}

export async function renderAudio(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SOUND');
  await buildMix(auth, workspaceId, project, mv);
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ characters */

export interface CharacterInput {
  role?: CharacterRow['role'] | undefined;
  name?: string | undefined;
  isArtist?: boolean | undefined;
  attributes?: CharacterAttributes | undefined;
  costumes?: (Omit<Costume, 'id'> & { id?: string | undefined })[] | undefined;
  mediaAssetIds?: string[] | undefined;
  profile?: string | undefined;
  prompt?: string | undefined;
}

export async function loadCharacter(projectId: string, characterId: string): Promise<CharacterRow> {
  const [row] = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE id = ${characterId} AND project_id = ${projectId}`;
  if (!row) throw AppError.notFound('Character');
  return row;
}

async function validMedia(projectId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE project_id = ${projectId} AND role IN ('PHOTO', 'VIDEO') AND id = ANY(${ids}::uuid[])`;
  const ok = new Set(rows.map((row) => row.id));
  return ids.filter((id) => ok.has(id));
}

/** Casting sheet limits (keep in sync with routes.ts and CharactersStage.tsx). */
export const PROFILE_MAX = 12000;
export const PROMPT_MAX = 4000;

const withIds = (costumes: CharacterInput['costumes']): Costume[] => (costumes ?? []).map((costume) => ({ ...costume, id: costume.id || randomUUID() }));

export async function addCharacter(auth: AuthContext, workspaceId: string, projectId: string, input: CharacterInput & { role: CharacterRow['role']; name: string }) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mv_characters WHERE project_id = ${projectId}`;
  if (count >= 24) throw AppError.badRequest('A music video can have up to 24 characters.');
  await sql`
    INSERT INTO mv_characters (project_id, position, role, name, is_artist, attributes, costumes, media_asset_ids)
    VALUES (${projectId}, ${count}, ${input.role}, ${input.name}, ${input.isArtist ?? ['LEAD', 'CO_LEAD'].includes(input.role)}, ${json(input.attributes ?? {})},
      ${json(withIds(input.costumes))}, ${await validMedia(projectId, input.mediaAssetIds ?? [])}::uuid[])`;
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

export async function updateCharacter(auth: AuthContext, workspaceId: string, projectId: string, characterId: string, input: CharacterInput) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const current = await loadCharacter(projectId, characterId);
  const media = input.mediaAssetIds ? await validMedia(projectId, input.mediaAssetIds) : current.mediaAssetIds;
  const mediaChanged = media.join() !== current.mediaAssetIds.join();
  // Any change re-opens this character for approval; new media also needs a new casting sheet.
  await sql`
    UPDATE mv_characters SET role = ${input.role ?? current.role}, name = ${input.name ?? current.name}, is_artist = ${input.isArtist ?? current.isArtist},
      attributes = ${json(input.attributes ?? current.attributes)}, costumes = ${json(input.costumes ? withIds(input.costumes) : current.costumes)},
      media_asset_ids = ${media}::uuid[], profile = ${input.profile ?? current.profile}, prompt = ${input.prompt ?? current.prompt},
      reference_keys = ${mediaChanged ? [] : current.referenceKeys}::text[], approved_at = NULL, updated_at = now()
    WHERE id = ${characterId}`;
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

/**
 * "Add random characters", step 1: the director finds every distinct person
 * in a pile of photos / videos, estimates looks, height and body frame, and
 * suggests a role. Nothing is created yet: the artist reviews every estimate.
 */
export async function detectCast(auth: AuthContext, workspaceId: string, projectId: string, assetIds: string[]) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const assets = await sql<AssetRow[]>`
    SELECT * FROM studio_assets WHERE project_id = ${projectId} AND role IN ('PHOTO', 'VIDEO') AND status = 'READY' AND id = ANY(${assetIds}::uuid[])`;
  if (assets.length === 0) throw AppError.badRequest('Upload some photos or videos first.');
  const images: { key: string; label: string; assetId: string }[] = [];
  for (const asset of assets.filter((item) => item.role === 'PHOTO')) images.push({ key: asset.key, label: `photo ${asset.name}`, assetId: asset.id });
  for (const asset of assets.filter((item) => item.role === 'VIDEO').slice(0, 6)) {
    const frames = await videoFrames(asset.key, (index) => `${keys.studio(workspaceId, projectId)}/characters/detect/${asset.id}-${index}.jpg`);
    frames.forEach((key, index) => images.push({ key, label: `frame ${index + 1} of video ${asset.name}`, assetId: asset.id }));
  }
  const cast = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId} ORDER BY position`;
  const { costs } = await getStudioSettings();
  const result = await charged(auth, workspaceId, projectId, 'MV_CASTING', costs.mvCasting, `Music video · ${project.title.slice(0, 50)}: find people in ${assets.length} files`, () =>
    detectPeople(images, { title: project.title, artist: mv.artistName, genre: mv.genre, vision: mv.vision, leadAct: mv.leadAct, cast: cast.map((item) => ({ name: item.name, role: item.role })) }),
  );
  const used = images.slice(0, 20);
  const people = await Promise.all(
    result.people.map(async (person) => {
      const faceImage = used[person.face.image] ?? used[person.images[0]!]!;
      return {
        label: titleCase(person.label),
        assetIds: [...new Set(person.images.map((index) => used[index]!.assetId))],
        face: { url: await readUrl(faceImage.key), x: person.face.x, y: person.face.y, w: person.face.w, h: person.face.h },
        attributes: {
          gender: person.gender,
          ageRange: person.ageRange,
          heightCm: person.heightCm,
          build: person.build,
          skinTone: person.skinTone,
          hairStyle: person.bald ? '' : person.hairStyle,
          hairColor: person.hairColor,
          bald: person.bald,
          facialHair: person.facialHair,
          persona: person.expression,
        },
        heightConfidence: person.heightConfidence,
        suggestedRole: person.suggestedRole,
        roleReason: person.roleReason,
      };
    }),
  );
  return { people, unused: assets.filter((asset) => !people.some((person) => person.assetIds.includes(asset.id))).map((asset) => asset.id) };
}

/** "Add random characters", step 2: creates every reviewed person as a character. */
export async function addCharacters(auth: AuthContext, workspaceId: string, projectId: string, people: (CharacterInput & { role: CharacterRow['role']; name: string })[]) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mv_characters WHERE project_id = ${projectId}`;
  if (count + people.length > 24) throw AppError.badRequest(`A music video can have up to 24 characters: ${Math.max(0, 24 - count)} more fit.`);
  for (const [index, person] of people.entries()) {
    await sql`
      INSERT INTO mv_characters (project_id, position, role, name, is_artist, attributes, costumes, media_asset_ids)
      VALUES (${projectId}, ${count + index}, ${person.role}, ${person.name}, ${person.isArtist ?? ['LEAD', 'CO_LEAD'].includes(person.role)}, ${json(person.attributes ?? {})},
        ${json(withIds(person.costumes))}, ${await validMedia(projectId, person.mediaAssetIds ?? [])}::uuid[])`;
  }
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

/**
 * Removes one photo / video from a character and deletes the file when no
 * other character uses it. Allowed at any stage: while casting, the character
 * goes back for approval; after the cast is locked, its approval stands and
 * the remaining photos simply carry the likeness from the next take on.
 */
export async function removeCharacterMedia(auth: AuthContext, workspaceId: string, projectId: string, characterId: string, assetId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  const casting = STAGES.indexOf(mv.stage) <= STAGES.indexOf('CHARACTERS');
  const character = await loadCharacter(projectId, characterId);
  if (!character.mediaAssetIds.includes(assetId)) throw AppError.notFound('Photo or video');
  const [asset] = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${assetId} AND project_id = ${projectId}`;
  // Frames cut from a deleted video live under its id: drop them with it.
  let referenceKeys = character.referenceKeys.filter((key) => key !== asset?.key && !key.includes(`/${assetId}-`));
  if (referenceKeys.length === 0) {
    // Never leave a cast member without a face: fall back to their remaining photos.
    const left = character.mediaAssetIds.filter((id) => id !== assetId);
    const photos = left.length ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ANY(${left}::uuid[]) AND role = 'PHOTO' AND status = 'READY'` : [];
    referenceKeys = left.flatMap((id) => photos.find((photo) => photo.id === id)?.key ?? []).slice(0, 6);
  }
  await sql`
    UPDATE mv_characters SET media_asset_ids = array_remove(media_asset_ids, ${assetId}::uuid), reference_keys = ${referenceKeys}::text[],
      approved_at = ${casting ? null : character.approvedAt}, updated_at = now()
    WHERE id = ${characterId}`;
  const [{ used } = { used: 0 }] = await sql<{ used: number }[]>`SELECT count(*)::int AS used FROM mv_characters WHERE project_id = ${projectId} AND ${assetId}::uuid = ANY(media_asset_ids)`;
  if (used === 0) await studio.deleteAsset(auth, workspaceId, projectId, assetId).catch((error: unknown) => logger.warn({ err: error, assetId }, 'character media file not deleted'));
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

export async function deleteCharacter(auth: AuthContext, workspaceId: string, projectId: string, characterId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const character = await loadCharacter(projectId, characterId);
  const photos = await sql<{ imageKey: string | null }[]>`SELECT image_key FROM mv_character_photos WHERE character_id = ${characterId}`;
  await sql`DELETE FROM mv_characters WHERE id = ${characterId}`;
  await sql`UPDATE studio_scenes SET character_ids = array_remove(character_ids, ${characterId}::uuid) WHERE project_id = ${projectId}`;
  // Their files leave the bucket too: uploads no other character uses, generated photos
  // (unless a scene took one as its first frame), and frames cut for them.
  const shared = await sql<{ id: string }[]>`
    SELECT DISTINCT unnest(media_asset_ids)::text AS id FROM mv_characters WHERE project_id = ${projectId}`;
  const stillUsed = new Set(shared.map((row) => row.id));
  for (const assetId of character.mediaAssetIds.filter((id) => !stillUsed.has(id))) {
    await studio.deleteAsset(auth, workspaceId, projectId, assetId).catch((error: unknown) => logger.warn({ err: error, assetId }, 'character media file not deleted'));
  }
  for (const photo of photos) {
    if (!photo.imageKey) continue;
    const [used] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_assets WHERE project_id = ${projectId} AND key = ${photo.imageKey}`;
    if (!used?.count) await deleteObject(photo.imageKey).catch(() => undefined);
  }
  await deletePrefix(`${keys.studio(workspaceId, projectId)}/characters/${characterId}/`).catch((error: unknown) =>
    logger.warn({ err: error, characterId }, 'character frames not deleted'),
  );
  return view(auth, workspaceId, projectId);
}

/** The artist confirms this is them, or that they have this person's permission. Logged. */
export async function consentCharacter(auth: AuthContext, workspaceId: string, projectId: string, characterId: string, ip: string | null) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  await loadCharacter(projectId, characterId);
  await sql`UPDATE mv_characters SET consent_at = now(), consent_by = ${auth.userId}, consent_ip = ${ip}, updated_at = now() WHERE id = ${characterId}`;
  logger.info({ projectId, characterId, userId: auth.userId }, 'music video character consent recorded');
  return view(auth, workspaceId, projectId);
}

/**
 * "This is me": the character is the signed-in user. Their saved likeness
 * (reference photos + written profile, already consented on the My likeness
 * page) drives every shot; photos / videos uploaded to the character are
 * optional extras. One "me" per user per project.
 */
export async function setCharacterMe(auth: AuthContext, workspaceId: string, projectId: string, characterId: string, on: boolean, ip: string | null) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const character = await loadCharacter(projectId, characterId);
  if (on) {
    const me = await meContext(auth.userId);
    if (!me || me.referenceKeys.length === 0) throw AppError.badRequest('Build your likeness first on the My likeness page (a few photos + the analysis), then come back and press "This is me".');
    await sql`
      UPDATE mv_characters SET likeness_user_id = NULL, reference_keys = '{}'::text[], approved_at = NULL, updated_at = now()
      WHERE project_id = ${projectId} AND likeness_user_id = ${auth.userId} AND id <> ${characterId}`;
    const referenceKeys = [...me.referenceKeys, ...character.referenceKeys.filter((key) => !me.referenceKeys.includes(key))].slice(0, 6);
    await sql`
      UPDATE mv_characters SET likeness_user_id = ${auth.userId}, is_artist = true, reference_keys = ${referenceKeys}::text[],
        profile = COALESCE(profile, ${me.description.slice(0, PROFILE_MAX)}), consent_at = now(), consent_by = ${auth.userId}, consent_ip = ${ip}, approved_at = NULL, updated_at = now()
      WHERE id = ${characterId}`;
    logger.info({ projectId, characterId, userId: auth.userId }, 'music video character set to the creator likeness');
  } else {
    const me = await meContext(auth.userId);
    const mine = new Set(me?.referenceKeys ?? []);
    await sql`
      UPDATE mv_characters SET likeness_user_id = NULL, reference_keys = ${character.referenceKeys.filter((key) => !mine.has(key))}::text[], approved_at = NULL, updated_at = now()
      WHERE id = ${characterId}`;
  }
  return view(auth, workspaceId, projectId);
}

/** AI casting sheet from the character's photos, video frames and the artist's notes. */
export async function castOne(auth: AuthContext, workspaceId: string, projectId: string, characterId: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const character = await loadCharacter(projectId, characterId);
  if (!character.consentAt) throw AppError.badRequest(`Confirm you have ${character.isArtist ? 'consented' : `${character.name}'s permission`} before their likeness is analysed.`);
  const media = character.mediaAssetIds.length ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ANY(${character.mediaAssetIds}::uuid[]) AND status = 'READY'` : [];
  // Photos = who the person is (identity). Videos = how they sing and express themselves (performance):
  // sampled densely so the model sees the face move through a phrase, never mixed into the identity references.
  const images: { key: string; label: string }[] = [];
  const me = character.likenessUserId ? await meContext(character.likenessUserId) : null;
  if (me) images.push(...me.referenceKeys.slice(0, 4).map((key, index) => ({ key, label: `saved likeness photo ${index + 1}` })));
  for (const asset of media.filter((item) => item.role === 'PHOTO').slice(0, 8)) images.push({ key: asset.key, label: 'photo' });
  const videos = media.filter((item) => item.role === 'VIDEO').slice(0, 3);
  const perVideo = videos.length ? Math.min(8, Math.max(3, Math.floor((16 - images.length) / videos.length))) : 0;
  for (const asset of videos) {
    const frames = await videoFrames(asset.key, (index) => `${keys.studio(workspaceId, projectId)}/characters/${characterId}/${asset.id}-p${index}.jpg`, perVideo);
    frames.forEach((key, index) => images.push({ key, label: `performance video "${asset.name}", frame ${index + 1} of ${frames.length} (in time order)` }));
  }
  const castAs = me
    ? { ...character, attributes: { ...character.attributes, notes: [character.attributes.notes, `Saved likeness profile: ${me.description}`].filter(Boolean).join('\n') } }
    : character;
  const { costs } = await getStudioSettings();
  const result = await charged(auth, workspaceId, projectId, 'MV_CASTING', costs.mvCasting, `Music video · ${project.title.slice(0, 50)}: casting ${character.name}`, () =>
    castCharacter(castAs, images, mv.vision),
  );
  const best = result.bestReferences.map((index) => images[index]!.key);
  // Identity pool: photos only when there are any; video frames only stand in when there are none.
  const identity = images.filter((image) => /photo/.test(image.label)).length ? images.filter((image) => /photo/.test(image.label)) : images;
  const referenceKeys = [...best, ...identity.map((image) => image.key).filter((key) => !best.includes(key))].slice(0, 6);
  const expressionKeys = result.expressionFrames.map((index) => images[index]!.key);
  await sql`
    UPDATE mv_characters SET profile = ${(result.profile + (result.notes ? `\n\nNote: ${result.notes}` : '')).slice(0, PROFILE_MAX)}, prompt = ${result.prompt.slice(0, PROMPT_MAX)}, reference_keys = ${referenceKeys}::text[],
      performance = ${result.performance.trim() ? result.performance.trim().slice(0, 1500) : null}, expression_keys = ${expressionKeys}::text[],
      cast_engine = ${result.engine}, approved_at = NULL, updated_at = now()
    WHERE id = ${characterId}`;
  return view(auth, workspaceId, projectId);
}

export async function approveCharacter(auth: AuthContext, workspaceId: string, projectId: string, characterId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const character = await loadCharacter(projectId, characterId);
  if (!character.consentAt) throw AppError.badRequest('Record the permission for this person first.');
  if (!character.prompt && !character.profile) throw AppError.badRequest('Build the casting sheet first (or write the description yourself).');
  await sql`UPDATE mv_characters SET approved_at = now() WHERE id = ${characterId}`;
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ scenes */

export interface MvSceneInput {
  kind?: 'INTRO' | 'STORY' | 'OUTRO' | undefined;
  /** The artist's names for the scene (labels only). */
  title?: string | undefined;
  subtitle?: string | undefined;
  description?: string | undefined;
  prompt?: string | undefined;
  shot?: SceneRow['shot'] | undefined;
  transition?: SceneRow['transition'] | undefined;
  durationSec?: number | undefined;
  characterIds?: string[] | undefined;
  costume?: string | undefined;
  location?: string | undefined;
  timeOfDay?: string | undefined;
  lyric?: string | undefined;
  lipSync?: boolean | undefined;
  transitionMode?: 'MANUAL' | 'AI' | undefined;
  /** PERFORMANCE = lip-synced; NARRATIVE / BROLL = no singing. Setting it sets lip sync to match. */
  mode?: 'PERFORMANCE' | 'NARRATIVE' | 'BROLL' | undefined;
  /** Lip-synced scenes: delivery and how far to take it (1 subtle · 2 natural · 3 full out). null clears. */
  emotion?: PerformanceEmotion | null | undefined;
  intensity?: number | undefined;
}

/** Performance intensity 1-3 (the director may answer outside the range). */
const intensityLevel = (value: number | null | undefined): number | null => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.min(3, Math.max(1, Math.round(value))));

/** Scenes can be written, edited, planned, added and deleted in these stages (the shoot is a timeline editor). */
export const SCENE_STAGES: Stage[] = ['SCENES', 'STORYBOARD', 'SHOOT'];
/** Approving / unapproving a scene never locks anything: allowed through the shoot. */
const APPROVAL_STAGES: Stage[] = ['SCENES', 'DISCUSSION', 'STORYBOARD', 'SHOOT'];

/** With auto-approve on, every scene that has a plan (prompt) is approved. */
async function autoApprove(projectId: string): Promise<void> {
  await sql`
    UPDATE studio_scenes s SET approved_at = now()
    FROM mv_projects m
    WHERE m.project_id = ${projectId} AND m.auto_approve AND s.project_id = ${projectId} AND s.approved_at IS NULL AND COALESCE(btrim(s.prompt), '') <> ''`;
}

async function loadScenes(projectId: string): Promise<SceneRow[]> {
  return sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE project_id = ${projectId} ORDER BY position`;
}

/** Positions 0..n-1 in the given order. Intro / outro are only labels: any scene can sit anywhere. */
export async function normalizeOrder(projectId: string, order?: string[]): Promise<void> {
  const scenes = await loadScenes(projectId);
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const ordered = order ? [...order.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...scenes.filter((scene) => !order.includes(scene.id))] : scenes;
  for (const [position, scene] of ordered.entries()) if (scene.position !== position) await sql`UPDATE studio_scenes SET position = ${position} WHERE id = ${scene.id}`;
}

/** A brand-new scene list starts with an intro and an outro (suggestions: both can be renamed, moved or deleted). */
async function ensureBookends(projectId: string): Promise<void> {
  const scenes = await loadScenes(projectId);
  if (scenes.length > 0) return;
  if (!scenes.some((scene) => scene.kind === 'INTRO')) {
    await sql`INSERT INTO studio_scenes (project_id, position, kind, description, shot, transition, duration_sec, features_subject)
      VALUES (${projectId}, -1, 'INTRO', 'Opening shot: set the world of the song before the first line', 'aerial-reveal', 'dissolve', 6, false)`;
  }
  if (!scenes.some((scene) => scene.kind === 'OUTRO')) {
    await sql`INSERT INTO studio_scenes (project_id, position, kind, description, shot, transition, duration_sec, features_subject)
      VALUES (${projectId}, 100000, 'OUTRO', 'Closing shot: the final image as the song fades', 'wide', 'dip-black', 6, false)`;
  }
  await normalizeOrder(projectId);
}

export async function addScene(auth: AuthContext, workspaceId: string, projectId: string, input: MvSceneInput & { description: string; afterSceneId?: string | undefined }) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const { limits } = await getStudioSettings();
  const scenes = await loadScenes(projectId);
  if (scenes.length >= limits.maxScenes) throw AppError.badRequest(`Up to ${limits.maxScenes} scenes.`);
  const cast = input.characterIds ?? [];
  const [added] = await sql<{ id: string }[]>`
    INSERT INTO studio_scenes (project_id, position, kind, title, subtitle, description, prompt, shot, transition, duration_sec, features_subject, lip_sync, character_ids, costume, location, time_of_day, lyric, emotion, intensity)
    VALUES (${projectId}, ${scenes.length}, 'STORY', ${(input.title ?? '').slice(0, 80)}, ${(input.subtitle ?? '').slice(0, 120)}, ${input.description}, ${input.prompt ?? null}, ${input.shot ?? 'medium'}, ${input.transition ?? 'crossfade'}, ${input.durationSec ?? 5},
      ${cast.length > 0}, ${Boolean(input.lipSync) && cast.length > 0}, ${cast}::uuid[], ${input.costume ?? null}, ${input.location ?? null}, ${input.timeOfDay ?? null}, ${input.lyric ?? null},
      ${input.emotion ?? null}, ${intensityLevel(input.intensity)}) RETURNING id`;
  // Beside the scene in focus (the ones after it move up one number), else before the outro.
  const after = input.afterSceneId ? scenes.find((scene) => scene.id === input.afterSceneId) : undefined;
  if (after && added) {
    const order = scenes.map((scene) => scene.id);
    const at = order.indexOf(after.id) + 1;
    order.splice(at, 0, added.id);
    await normalizeOrder(projectId, order);
  } else {
    await normalizeOrder(projectId);
  }
  await autoApprove(projectId);
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

async function writeScene(projectId: string, sceneId: string, input: MvSceneInput, approved: boolean): Promise<void> {
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  const cast = input.characterIds ?? scene.characterIds;
  const lipSync = (input.mode ? input.mode === 'PERFORMANCE' : (input.lipSync ?? scene.lipSync)) && cast.length > 0;
  const mode = lipSync ? 'PERFORMANCE' : input.mode && input.mode !== 'PERFORMANCE' ? input.mode : scene.mode === 'PERFORMANCE' || !scene.mode ? (cast.length ? 'NARRATIVE' : 'BROLL') : scene.mode;
  await sql`
    UPDATE studio_scenes SET mode = ${mode}, title = ${input.title ?? scene.title ?? ''}, subtitle = ${input.subtitle ?? scene.subtitle ?? ''}, description = ${input.description ?? scene.description}, prompt = ${input.prompt ?? scene.prompt}, shot = ${input.shot ?? scene.shot},
      transition = ${input.transition ?? scene.transition}, duration_sec = ${input.durationSec ?? scene.durationSec}, character_ids = ${cast}::uuid[],
      features_subject = ${cast.length > 0}, lip_sync = ${lipSync}, costume = ${input.costume ?? scene.costume}, location = ${input.location ?? scene.location},
      time_of_day = ${input.timeOfDay ?? scene.timeOfDay}, lyric = ${input.lyric ?? scene.lyric},
      emotion = ${input.emotion !== undefined ? input.emotion : (scene.emotion ?? null)}, intensity = ${intensityLevel(input.intensity ?? scene.intensity)},
      transition_mode = ${input.transitionMode ?? (input.transition ? 'MANUAL' : (scene.transitionMode ?? 'AI'))},
      approved_at = ${approved ? scene.approvedAt : null}, updated_at = now()
    WHERE id = ${sceneId}`;
}

export async function updateScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, input: MvSceneInput) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  // The artist's own edits keep the scene's approval: unapproving is a separate, explicit action.
  await writeScene(projectId, sceneId, input, true);
  await autoApprove(projectId);
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

export async function deleteScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_scenes WHERE project_id = ${projectId}`;
  if (count <= 1) throw AppError.badRequest('Keep at least one scene: add another before deleting this one.');
  // Running takes are stopped (their workers clear their own files); finished ones' files go now.
  await studio.cancelScenes(projectId, [sceneId]);
  const takeIds = await studio.finishedTakeIds(projectId, [sceneId]);
  await sql`DELETE FROM studio_scenes WHERE id = ${sceneId}`;
  await studio.dropTakeFiles(workspaceId, projectId, takeIds);
  await normalizeOrder(projectId);
  return view(auth, workspaceId, projectId);
}

export async function reorderScenes(auth: AuthContext, workspaceId: string, projectId: string, order: string[]) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  await normalizeOrder(projectId, order);
  return view(auth, workspaceId, projectId);
}

/**
 * Reads the song's voice (accent, the region it speaks to) from its words and
 * stores it on the lyrics. A cue only: the artist's cast background and shoot
 * location (Direction) always win.
 */
async function refreshVoice(projectId: string, lyrics: Lyrics, context: { title: string; artist: string; genre: string }): Promise<void> {
  if (!lyrics.lines.some((line) => line.text.trim())) return;
  try {
    const { engine: _engine, ...voice } = await profileVoice(lyrics.lines, { ...context, language: lyrics.language });
    await sql`UPDATE mv_projects SET lyrics = jsonb_set(lyrics, '{voice}', ${json(voice)}) WHERE project_id = ${projectId} AND lyrics IS NOT NULL`;
  } catch (error) {
    logger.warn({ err: error, projectId }, 'voice profile failed');
  }
}

export async function directorContext(project: ProjectRow, mv: MvRow, withSongMap = true): Promise<DirectorContext> {
  const [characters, scenes, music, song] = await Promise.all([
    sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${project.id} ORDER BY position`,
    loadScenes(project.id),
    project.musicAssetId ? sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${project.musicAssetId}` : Promise.resolve([] as AssetRow[]),
    withSongMap ? songContext(project.id).catch(() => null) : Promise.resolve(null),
  ]);
  const direction = parseDirection(mv.direction);
  const place = placeText(direction, mv.lyrics?.voice);
  return {
    ...(place ? { place } : {}),
    songMap: song && (song.lines.length || song.analysis) ? songMapText(song, direction) : undefined,
    titles: mv.titles ? parseTitles(mv.titles, mv.artistName, project.title) : null,
    title: project.title,
    artist: mv.artistName,
    genre: mv.genre,
    vision: mv.vision,
    mood: mv.mood,
    leadAct: mv.leadAct,
    creativeMode: mv.creativeMode,
    cameraEnergy: mv.cameraEnergy ?? 'bold',
    visualStyle: mv.visualStyle ?? 'human',
    aspect: project.aspect,
    // The video runs from songStart to the end of the (edited) song.
    songSeconds: music[0]?.meta.durationSec ? Math.max(1, music[0].meta.durationSec - Math.max(0, project.brief.songStart ?? 0)) : null,
    lyrics: mv.lyrics ? mv.lyrics.lines.map((line) => `[${line.start.toFixed(1)}-${line.end.toFixed(1)}] ${line.text}`).join('\n') : null,
    characters,
    scenes: scenes.map((scene) => ({
      id: scene.id,
      kind: scene.kind,
      description: scene.description,
      prompt: scene.prompt,
      durationSec: scene.durationSec,
      characterIds: scene.characterIds,
      location: scene.location,
      costume: scene.costume,
      mode: scene.mode ?? null,
      lyric: scene.lyric,
    })),
  };
}

/** The director expands (or re-expands, with the artist's notes) one scene. */
export async function expand(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, notes?: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  const context = await directorContext(project, mv);
  const { costs } = await getStudioSettings();
  const plan = await charged(auth, workspaceId, projectId, 'MV_SCENE', costs.mvScene, `Music video · ${project.title.slice(0, 50)}: scene ${scene.position + 1} plan`, () =>
    expandScene(context, { kind: scene.kind, description: scene.description, notes }),
  );
  await writeScene(
    projectId,
    sceneId,
    {
      ...(scene.title?.trim() ? {} : { title: plan.title.slice(0, 80) }),
      ...(scene.subtitle?.trim() ? {} : { subtitle: plan.subtitle.slice(0, 120) }),
      description: plan.description.slice(0, 1000),
      prompt: plan.prompt.slice(0, 2000),
      shot: plan.shot,
      transition: plan.transition,
      durationSec: plan.durationSec,
      characterIds: plan.characterIds,
      costume: plan.costume.slice(0, 500),
      location: plan.location.slice(0, 200),
      timeOfDay: plan.timeOfDay.slice(0, 24),
      lyric: plan.lyric.slice(0, 300),
      lipSync: plan.lipSync,
      mode: plan.lipSync ? 'PERFORMANCE' : plan.mode === 'PERFORMANCE' ? 'NARRATIVE' : plan.mode,
      emotion: plan.lipSync ? plan.emotion : null,
      intensity: plan.intensity,
    },
    false,
  );
  await autoApprove(projectId);
  // The director says what it did and why (shown on the scene card).
  return { project: await view(auth, workspaceId, projectId), why: plan.why.slice(0, 1200) };
}

export async function approveScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...APPROVAL_STAGES);
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  if (!scene.prompt?.trim()) throw AppError.badRequest('Let the director plan this scene (or write the prompt) before approving it.');
  await sql`UPDATE studio_scenes SET approved_at = now() WHERE id = ${sceneId}`;
  return view(auth, workspaceId, projectId);
}

/**
 * Takes a scene out of the video: it is not generated and not stitched until
 * approved again. Turns auto-approve off (otherwise it would come straight back).
 */
export async function unapproveScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...APPROVAL_STAGES);
  const rows = await sql`UPDATE studio_scenes SET approved_at = NULL, shot_approved_at = NULL WHERE id = ${sceneId} AND project_id = ${projectId} RETURNING id`;
  if (rows.length === 0) throw AppError.notFound('Scene');
  if (mv.autoApprove) await sql`UPDATE mv_projects SET auto_approve = false WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/**
 * Approves every scene the director has planned (has a prompt) in one go.
 * Scenes still without a plan are left unapproved and reported back.
 */
export async function approveAllScenes(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...APPROVAL_STAGES);
  const approved = await sql<{ id: string }[]>`
    UPDATE studio_scenes SET approved_at = now()
    WHERE project_id = ${projectId} AND approved_at IS NULL AND COALESCE(btrim(prompt), '') <> '' RETURNING id`;
  const unplanned = await sql<{ position: number }[]>`
    SELECT position FROM studio_scenes WHERE project_id = ${projectId} AND approved_at IS NULL ORDER BY position`;
  return { project: await view(auth, workspaceId, projectId), approved: approved.length, unplanned: unplanned.map((row) => row.position + 1) };
}

/* ------------------------------------------------------------------ director's room */

export async function sendMessage(auth: AuthContext, workspaceId: string, projectId: string, message: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'DISCUSSION');
  const [context, history, settings] = await Promise.all([
    directorContext(project, mv),
    sql<MessageRow[]>`SELECT * FROM (SELECT * FROM mv_messages WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 40) recent ORDER BY created_at`,
    getStudioSettings(),
  ]);
  const result = await charged(auth, workspaceId, projectId, 'MV_CHAT', settings.costs.mvChat, `Music video · ${project.title.slice(0, 50)}: director's room`, () =>
    discuss(context, history, message),
  );
  // The director's opening-titles proposal, validated like the artist's own edits.
  const proposedTitles = result.titles.propose
    ? titlesSchema.safeParse({
        enabled: true,
        presenter: result.titles.presenter.slice(0, 80),
        label: result.titles.label.slice(0, 80),
        artist: titleCase(mv.artistName).slice(0, 80),
        song: titleCase(project.title).slice(0, 80),
        featuring: result.titles.featuring.slice(0, 80),
        director: result.titles.director.slice(0, 80),
        prologue: result.titles.prologue
          .filter((card) => card.text.trim())
          .slice(0, 3)
          .map((card) => ({ text: card.text.trim().slice(0, 220), seconds: Math.min(8, Math.max(2, Math.round(card.seconds * 2) / 2)) })),
        style: result.titles.style,
        placement: result.titles.placement,
      })
    : null;
  const titlesProposal = proposedTitles?.success ? { ...proposedTitles.data, why: result.titles.why.slice(0, 300), applied: false } : null;
  const proposals = result.proposals.map((proposal) => ({
    id: randomUUID(),
    sceneId: proposal.sceneIndex >= 0 ? (context.scenes[proposal.sceneIndex]?.id ?? null) : null,
    summary: proposal.summary,
    change: {
      ...(proposal.description ? { description: proposal.description } : {}),
      ...(proposal.location ? { location: proposal.location } : {}),
      ...(proposal.costume ? { costume: proposal.costume } : {}),
      ...(proposal.durationSec > 0 ? { durationSec: Math.min(10, Math.max(3, proposal.durationSec)) } : {}),
    },
    applied: false,
  }));
  await sql`INSERT INTO mv_messages (project_id, author, content) VALUES (${projectId}, 'CREATOR', ${message})`;
  await sql`INSERT INTO mv_messages (project_id, author, content, refs, proposals, titles) VALUES (${projectId}, 'DIRECTOR', ${result.reply}, ${json(result.references)}, ${json(proposals)}, ${titlesProposal ? json(titlesProposal) : null})`;
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ opening titles + direction */

/** Saves the opening titles (any stage: they are rendered at the master). */
export async function setTitles(auth: AuthContext, workspaceId: string, projectId: string, titles: Titles) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  await sql`UPDATE mv_projects SET titles = ${json(titles)}, updated_at = now() WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/** Uses the director's proposed titles from one message (the artist's call). */
export async function applyTitles(auth: AuthContext, workspaceId: string, projectId: string, messageId: string) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [message] = await sql<MessageRow[]>`SELECT * FROM mv_messages WHERE id = ${messageId} AND project_id = ${projectId}`;
  if (!message?.titles) throw AppError.notFound('Titles proposal');
  const { why: _why, applied: _applied, ...titles } = message.titles;
  const parsed = titlesSchema.safeParse(titles);
  if (!parsed.success) throw AppError.badRequest('That proposal is no longer valid.');
  await sql`UPDATE mv_projects SET titles = ${json(parsed.data)}, updated_at = now() WHERE project_id = ${projectId}`;
  await sql`UPDATE mv_messages SET titles = ${json({ ...message.titles, applied: true })} WHERE id = ${messageId}`;
  return view(auth, workspaceId, projectId);
}

/** The artist's direction settings: performance share, pace, lyric approach, chorus home. */
export async function setDirection(auth: AuthContext, workspaceId: string, projectId: string, input: Partial<Direction>) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  const next = directionSchema.parse({ ...parseDirection(mv.direction), ...input });
  await sql`UPDATE mv_projects SET direction = ${json(next)}, updated_at = now() WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/**
 * Re-times the current scenes to the song without re-planning them: cuts on
 * bar lines, the real words under each scene, lip sync off where nobody
 * sings. Free (no AI). Approvals and takes are kept.
 */
export async function lockScenesToSong(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, ...SCENE_STAGES);
  const scenes = await loadScenes(projectId);
  const context = await songContext(projectId);
  if (!context.lines.length && !context.analysis) throw AppError.badRequest('Upload the song (and transcribe the lyrics) first.');
  const plan = scenes.map((scene) => ({ id: scene.id, durationSec: scene.durationSec, lyric: scene.lyric ?? '', lipSync: scene.lipSync, characterIds: scene.characterIds, mode: scene.mode ?? null }));
  lockToSong(plan, context);
  for (const scene of plan) {
    await sql`UPDATE studio_scenes SET duration_sec = ${scene.durationSec}, lyric = ${scene.lyric}, lip_sync = ${scene.lipSync}, mode = ${scene.mode ?? null}, updated_at = now() WHERE id = ${scene.id}`;
  }
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

/** "Go with the director's plan": applies every proposal not applied yet, oldest first. */
export async function applyAllProposals(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'DISCUSSION');
  const messages = await sql<MessageRow[]>`SELECT * FROM mv_messages WHERE project_id = ${projectId} AND author = 'DIRECTOR' ORDER BY created_at`;
  for (const message of messages) {
    for (const proposal of message.proposals.filter((item) => !item.applied)) {
      await applyProposal(auth, workspaceId, projectId, message.id, proposal.id);
    }
  }
  return view(auth, workspaceId, projectId);
}

/** Applies one of the director's proposals to the scene list (the artist's call). */
export async function applyProposal(auth: AuthContext, workspaceId: string, projectId: string, messageId: string, proposalId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'DISCUSSION');
  const [message] = await sql<MessageRow[]>`SELECT * FROM mv_messages WHERE id = ${messageId} AND project_id = ${projectId}`;
  const proposal = message?.proposals.find((item) => item.id === proposalId);
  if (!message || !proposal) throw AppError.notFound('Proposal');
  if (proposal.applied) throw AppError.conflict('Already applied.');
  if (proposal.sceneId) {
    await writeScene(projectId, proposal.sceneId, proposal.change, false);
  } else {
    const scenes = await loadScenes(projectId);
    await sql`INSERT INTO studio_scenes (project_id, position, kind, description, location, costume, duration_sec, features_subject)
      VALUES (${projectId}, ${scenes.length}, 'STORY', ${proposal.change.description ?? proposal.summary}, ${proposal.change.location ?? null}, ${proposal.change.costume ?? null}, ${proposal.change.durationSec ?? 5}, false)`;
    await normalizeOrder(projectId);
  }
  const proposals = message.proposals.map((item) => (item.id === proposalId ? { ...item, applied: true } : item));
  await sql`UPDATE mv_messages SET proposals = ${json(proposals)} WHERE id = ${messageId}`;
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ storyboard */

/**
 * The director writes the whole scene list, cut to the song's story and
 * structure (intro → story → outro), every field filled in for the artist to
 * edit. Used to draft the scenes (SCENES stage) and to lock the final
 * storyboard (STORYBOARD stage, also folding in the director's room).
 */
export async function buildStoryboard(auth: AuthContext, workspaceId: string, projectId: string, sceneCount?: number) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SCENES', 'STORYBOARD');
  const [context, messages, settings] = await Promise.all([
    directorContext(project, mv),
    sql<MessageRow[]>`SELECT * FROM mv_messages WHERE project_id = ${projectId} ORDER BY created_at`,
    getStudioSettings(),
  ]);
  const discussion = messages.map((item) => `${item.author === 'CREATOR' ? 'ARTIST' : 'DIRECTOR'}: ${item.content}`).join('\n');
  // Enough scenes to cover the whole song (about one every 6 s, 3-10 s each).
  const songSeconds = context.songSeconds ?? 0;
  const wanted = sceneCount ?? (songSeconds ? Math.min(settings.limits.maxScenes, Math.max(4, Math.ceil(songSeconds / 6))) : undefined);
  const board = await charged(auth, workspaceId, projectId, 'MV_STORYBOARD', settings.costs.mvStoryboard, `Music video · ${project.title.slice(0, 50)}: storyboard`, () =>
    storyboard(context, discussion, wanted),
  );
  if (songSeconds > 0) fitToSong(board.scenes, songSeconds, settings.limits.maxScenes);
  if (board.scenes.length < 2) throw new AppError(502, 'INTERNAL_ERROR', 'The director returned an incomplete storyboard. Try again.');
  // Lock to the song: cuts on bar lines, real words under each scene, lip sync only where someone sings.
  const song = await songContext(projectId).catch(() => null);
  if (song && (song.lines.length || song.analysis)) lockToSong(board.scenes, song);
  // Every old scene is replaced: their finished takes' files leave the bucket after the swap.
  const oldTakes = await studio.finishedTakeIds(projectId);
  await sql.begin(async (tx) => {
    // Running takes on scenes that are being replaced are cancelled first.
    await tx`UPDATE studio_takes SET status = 'CANCELED', finished_at = now() WHERE project_id = ${projectId} AND status IN ('QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING')`;
    await tx`DELETE FROM studio_scenes WHERE project_id = ${projectId}`;
    for (const [position, scene] of board.scenes.slice(0, settings.limits.maxScenes).entries()) {
      await tx`
        INSERT INTO studio_scenes (project_id, position, kind, title, subtitle, description, prompt, shot, transition, duration_sec, features_subject, lip_sync, character_ids, costume, location, time_of_day, lyric, mode, emotion, intensity)
        VALUES (${projectId}, ${position}, ${scene.kind}, ${scene.title.slice(0, 80)}, ${scene.subtitle.slice(0, 120)}, ${scene.description.slice(0, 1000)}, ${scene.prompt.slice(0, 2000)}, ${scene.shot}, ${scene.transition}, ${scene.durationSec},
          ${scene.characterIds.length > 0}, ${scene.lipSync && scene.characterIds.length > 0}, ${scene.characterIds}::uuid[], ${scene.costume.slice(0, 500)},
          ${scene.location.slice(0, 200)}, ${scene.timeOfDay.slice(0, 24)}, ${scene.lyric.slice(0, 300)},
          ${scene.lipSync && scene.characterIds.length > 0 ? 'PERFORMANCE' : scene.mode === 'PERFORMANCE' ? 'NARRATIVE' : (scene.mode ?? null)},
          ${scene.lipSync ? (scene.emotion ?? null) : null}, ${intensityLevel(scene.intensity)})`;
    }
  });
  await studio.dropTakeFiles(workspaceId, projectId, oldTakes);
  await sql`UPDATE studio_projects SET brief = ${json({ ...project.brief, script: board.logline.slice(0, 12_000) })}, updated_at = now() WHERE id = ${projectId}`;
  await autoApprove(projectId);
  return view(auth, workspaceId, projectId);
}

/**
 * Makes the scene lengths add up to the song: scales them to the song length
 * (each 3-10 s, half-second steps), then, if the 10 s cap leaves the song
 * uncovered, adds story scenes before the outro until it is covered.
 */
function fitToSong(
  scenes: {
    durationSec: number;
    kind: string;
    description: string;
    prompt: string;
    shot: string;
    transition: string;
    characterIds: string[];
    costume: string;
    location: string;
    timeOfDay: string;
    lyric: string;
    lipSync: boolean;
  }[],
  songSeconds: number,
  maxScenes: number,
): void {
  if (scenes.length === 0) return;
  const clamp = (value: number): number => Math.min(10, Math.max(3, Math.round(value * 2) / 2));
  const total = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const factor = songSeconds / Math.max(1, total);
  for (const scene of scenes) scene.durationSec = clamp(scene.durationSec * factor);
  let covered = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  // Top up the longest-possible way first, then add scenes (copies of the story beats, marked to be re-planned).
  for (const scene of scenes) {
    if (covered >= songSeconds - 0.5) break;
    const extra = Math.min(10 - scene.durationSec, songSeconds - covered);
    scene.durationSec = clamp(scene.durationSec + extra);
    covered = scenes.reduce((sum, item) => sum + item.durationSec, 0);
  }
  let source = 1;
  while (covered < songSeconds - 0.5 && scenes.length < maxScenes) {
    const base = scenes[Math.min(source, scenes.length - 2)] ?? scenes[0]!;
    const duration = clamp(Math.min(10, songSeconds - covered));
    scenes.splice(scenes.length - 1, 0, { ...base, kind: 'STORY', durationSec: duration, description: `${base.description} (continuation: rework this beat)`, characterIds: [...base.characterIds] });
    covered += duration;
    source += 2;
  }
  // Trim any overshoot from the longest story scene.
  const over = covered - songSeconds;
  if (over > 0.5) {
    const longest = scenes.filter((scene) => scene.kind === 'STORY').sort((a, b) => b.durationSec - a.durationSec)[0];
    if (longest) longest.durationSec = clamp(longest.durationSec - over);
  }
}

/* ------------------------------------------------------------------ stage approval */

async function checkStage(project: ProjectRow, mv: MvRow, stage: Stage): Promise<string | null> {
  const scenes = await loadScenes(project.id);
  switch (stage) {
    case 'SONG':
      if (!mv.artistName.trim()) return 'Enter the artist or band name.';
      if (!project.musicAssetId && !mv.originalSongId) return 'Upload the song.';
      if (!mv.genre.trim()) return 'Choose the genre.';
      if (mv.vision.trim().length < 20) return 'Describe how you want the video to look and feel (a few sentences).';
      return null;
    case 'SOUND':
      return null;
    case 'CHARACTERS': {
      const characters = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${project.id}`;
      const leads = characters.filter((character) => character.role === 'LEAD' || character.role === 'CO_LEAD');
      if (leads.length < LEAD_COUNT[mv.leadAct]) return `A ${mv.leadAct.toLowerCase()} act needs ${LEAD_COUNT[mv.leadAct]} lead artist${LEAD_COUNT[mv.leadAct] === 1 ? '' : 's'} (lead + co-leads).`;
      const pending = characters.filter((character) => !character.approvedAt);
      if (pending.length) return `Approve every character first: ${pending.map((character) => character.name).join(', ')}.`;
      return null;
    }
    case 'SCENES': {
      const story = scenes.filter((scene) => scene.kind === 'STORY');
      if (story.length === 0) return 'Add at least one scene idea.';
      // Approval never blocks the move on: only approved scenes are generated later.
      return null;
    }
    case 'DISCUSSION': {
      const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mv_messages WHERE project_id = ${project.id} AND author = 'DIRECTOR'`;
      return count > 0 ? null : 'Talk the scenes through with the director at least once.';
    }
    case 'STORYBOARD': {
      // Only approved scenes WITH a finished video go on to the master; the rest are left out
      // (generate or approve them later by reopening the storyboard).
      const approved = scenes.filter((scene) => scene.approvedAt);
      if (approved.length === 0) return 'Approve at least one scene: only approved scenes are generated and stitched.';
      const ready = new Set((await sql<{ sceneId: string }[]>`SELECT DISTINCT scene_id FROM studio_takes WHERE project_id = ${project.id} AND status = 'READY'`).map((row) => row.sceneId));
      if (!approved.some((scene) => ready.has(scene.id))) return 'Generate the video for at least one approved scene: only approved scenes with a finished video go to the master.';
      // Don't keep paying for videos that would be left out.
      if (mv.sequence?.active) return '“Generate all” is still running: stop it first (the shot being filmed can finish), then lock.';
      return null;
    }
    case 'SHOOT': {
      // Only locked (approved + finished video) scenes are stitched; the others are left out.
      if (!scenes.some((scene) => scene.approvedAt && scene.shotApprovedAt)) return 'Lock at least one approved scene with a finished video.';
      return null;
    }
    case 'MASTER':
      return null;
  }
}

export async function approveStage(auth: AuthContext, workspaceId: string, projectId: string, stage: Stage) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, stage);
  const problem = await checkStage(project, mv, stage);
  if (problem) throw AppError.badRequest(problem);
  if (stage === 'SONG' && !mv.originalSongId) await sql`UPDATE mv_projects SET original_song_id = ${project.musicAssetId} WHERE project_id = ${projectId}`;
  if (stage === 'SOUND' && !mv.mixRenderedAt) await buildMix(auth, workspaceId, project, (await load(workspaceId, projectId)).mv);
  if (stage === 'STORYBOARD') {
    // Locking the storyboard stitches the generated scenes: each scene keeps its picked
    // take (or its newest finished one), every scene is locked, and the shoot is skipped.
    await sql`
      UPDATE studio_scenes s SET selected_take_id = (
        SELECT t.id FROM studio_takes t WHERE t.scene_id = s.id AND t.status = 'READY' ORDER BY t.created_at DESC LIMIT 1)
      WHERE s.project_id = ${projectId} AND s.approved_at IS NOT NULL AND (s.selected_take_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM studio_takes t2 WHERE t2.id = s.selected_take_id AND t2.status = 'READY'))`;
    // Only approved scenes with a finished video go into the stitch; the rest are left out.
    await sql`
      UPDATE studio_scenes s SET shot_approved_at = CASE
        WHEN s.approved_at IS NOT NULL AND EXISTS (SELECT 1 FROM studio_takes t WHERE t.id = s.selected_take_id AND t.status = 'READY')
          THEN COALESCE(s.shot_approved_at, now())
        ELSE NULL END
      WHERE s.project_id = ${projectId}`;
    const fresh = (await load(workspaceId, projectId)).mv;
    if (!fresh.mixRenderedAt && (fresh.audioEdits.regions.length || fresh.audioEdits.layers.length || fresh.audioEdits.clips?.length)) await buildMix(auth, workspaceId, project, fresh);
    const at = new Date().toISOString();
    await sql`UPDATE mv_projects SET approvals = approvals || ${json({ STORYBOARD: at, SHOOT: at })}, stage = 'MASTER', updated_at = now() WHERE project_id = ${projectId}`;
    // The shoot check runs now (free): beat-synced cuts, song sync of every shot (lip sync first), flops.
    // In the background: it downloads every take; the Master page shows the report when it lands.
    const musicId = (await load(workspaceId, projectId)).project.musicAssetId;
    const [song] = musicId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${musicId}` : [];
    if (song) {
      void polishProject(projectId, song.key)
        .then(() => publishProgress({ kind: 'studio', workspaceId, projectId, detail: 'Sync check ready' }))
        .catch((error: unknown) => logger.warn({ err: error, projectId }, 'sync check after storyboard lock failed'));
    }
    return view(auth, workspaceId, projectId);
  }
  const next = STAGES[Math.min(STAGES.length - 1, STAGES.indexOf(stage) + 1)]!;
  await sql`
    UPDATE mv_projects SET approvals = approvals || ${json({ [stage]: new Date().toISOString() })}, stage = ${next}, updated_at = now()
    WHERE project_id = ${projectId}`;
  // The scene stage always has its intro and outro waiting.
  if (next === 'SCENES') await ensureBookends(projectId);
  // Approvals carry over: the artist can unapprove any scene at any time.
  await autoApprove(projectId);
  return view(auth, workspaceId, projectId);
}

/**
 * Jumps to any stage. A stage already reached just opens. A later one is reached by completing
 * each stage in between the normal way (same checks and side effects as Approve), so nothing is
 * skipped silently; the first stage missing something stops it and says what is needed.
 */
export async function openStage(auth: AuthContext, workspaceId: string, projectId: string, stage: Stage) {
  await access(auth, workspaceId, true);
  const target = STAGES.indexOf(stage);
  for (let guard = 0; guard < STAGES.length; guard += 1) {
    const { project, mv } = await load(workspaceId, projectId);
    const at = STAGES.indexOf(mv.stage);
    if (at >= target) break;
    const problem = await checkStage(project, mv, mv.stage);
    if (problem) throw AppError.badRequest(`To open “${STAGE_LABEL[stage]}”, “${STAGE_LABEL[mv.stage]}” needs one more thing: ${problem}`);
    await approveStage(auth, workspaceId, projectId, mv.stage);
  }
  return view(auth, workspaceId, projectId);
}

export async function reopenStage(auth: AuthContext, workspaceId: string, projectId: string, stage: Stage) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  if (STAGES.indexOf(stage) > STAGES.indexOf(mv.stage)) throw AppError.badRequest('That stage is not open yet.');
  if (project.status === 'ASSEMBLING') throw AppError.conflict('Wait for the final cut to finish (or cancel it) first.');
  const keep = Object.fromEntries(Object.entries(mv.approvals).filter(([key]) => STAGES.indexOf(key as Stage) < STAGES.indexOf(stage)));
  await sql`UPDATE mv_projects SET approvals = ${json(keep)}, stage = ${stage}, auto_mode = false, updated_at = now() WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ shoot */

/** The next approved scene without a locked shot (unapproved scenes are not in the video). */
async function firstUnshot(projectId: string): Promise<SceneRow | undefined> {
  return (await loadScenes(projectId)).find((scene) => scene.approvedAt && !scene.shotApprovedAt);
}


/** Generates takes for any scene, in any order. Generating a scene puts it in the video (approves it). */
export async function shoot(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, takes: number, dryRun: boolean) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SHOOT', 'STORYBOARD');
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  // Asking for a scene's video is the approval: no separate click, and no waiting on the scenes before it.
  if (!scene.approvedAt && !dryRun) await sql`UPDATE studio_scenes SET approved_at = now() WHERE id = ${sceneId}`;
  // One generation per scene at a time (a second click is refused, not charged).
  if (!dryRun) await studio.assertScenesIdle(projectId, [sceneId]);
  // Re-shooting an approved scene re-opens it.
  if (scene.shotApprovedAt && !dryRun) await sql`UPDATE studio_scenes SET shot_approved_at = NULL WHERE id = ${sceneId}`;
  const result = await studio.generate(auth, workspaceId, projectId, [sceneId], takes, dryRun);
  return { estimate: result.estimate, project: dryRun ? null : await view(auth, workspaceId, projectId) };
}

export async function approveShot(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'STORYBOARD', 'SHOOT');
  const [scene] = await sql<(SceneRow & { takeStatus: string | null })[]>`
    SELECT s.*, t.status AS take_status FROM studio_scenes s LEFT JOIN studio_takes t ON t.id = s.selected_take_id
    WHERE s.id = ${sceneId} AND s.project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  if (scene.takeStatus !== 'READY') throw AppError.badRequest('Pick the take you want for this scene first.');
  await sql`UPDATE studio_scenes SET shot_approved_at = now() WHERE id = ${sceneId}`;
  return view(auth, workspaceId, projectId);
}

/**
 * "I trust your judgement": one take for every scene not yet approved; as each
 * finishes it is picked and approved (see onTakeFinished), and when the last
 * one lands the film is cut and mastered automatically.
 */
export async function autoShoot(auth: AuthContext, workspaceId: string, projectId: string, dryRun: boolean) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'STORYBOARD', 'SHOOT');
  const remaining = (await loadScenes(projectId)).filter((scene) => scene.approvedAt && !scene.shotApprovedAt);
  if (remaining.length === 0) throw AppError.badRequest('Every approved scene already has a locked shot. Approve the stage to master the film (unapproved scenes are left out).');
  // Scenes that already have a finished, picked take are approved as they are.
  const picked = await sql<{ id: string }[]>`
    SELECT s.id FROM studio_scenes s JOIN studio_takes t ON t.id = s.selected_take_id AND t.status = 'READY'
    WHERE s.project_id = ${projectId} AND s.shot_approved_at IS NULL AND s.approved_at IS NOT NULL`;
  // Scenes already generating are left to finish (auto mode picks them up when they land), never filmed twice.
  const running = new Set(
    (
      await sql<{ sceneId: string }[]>`
        SELECT DISTINCT scene_id FROM studio_takes WHERE project_id = ${projectId} AND status = ANY(${ACTIVE_TAKE_SQL}::text[])`
    ).map((row) => row.sceneId),
  );
  if (!dryRun && mv.autoMode && running.size) throw AppError.conflict('Already generating every scene. Press Stop to halt it.');
  const toShoot = remaining.filter((scene) => !picked.some((row) => row.id === scene.id) && !running.has(scene.id));
  const result = toShoot.length
    ? await studio.generate(
        auth,
        workspaceId,
        projectId,
        toShoot.map((scene) => scene.id),
        1,
        dryRun,
      )
    : { estimate: { takes: 0, tokens: 0, bytes: 0, perScene: [] } };
  if (dryRun) return { estimate: result.estimate, project: null };
  if (picked.length) await sql`UPDATE studio_scenes SET shot_approved_at = now() WHERE id = ANY(${picked.map((row) => row.id)}::uuid[])`;
  await sql`UPDATE mv_projects SET auto_mode = true, auto_by = ${json({ userId: auth.userId, role: auth.role })}, updated_at = now() WHERE project_id = ${projectId}`;
  if (toShoot.length === 0 && running.size === 0) await finishAuto(projectId);
  return { estimate: result.estimate, project: await view(auth, workspaceId, projectId) };
}

/* ------------------------------------------------------------------ generate all, in order */

export interface Sequence {
  active: boolean;
  queue: string[];
  /** First scene of the batch in flight (kept for older clients). */
  current: string | null;
  /** Scenes of the batch in flight: the next batch starts when all of them finished. */
  batch?: string[];
  /** Batch sizes in order, e.g. [2, 4]: the last size repeats until every scene is done. */
  sizes?: number[];
  /** 1-based batch number in flight; also the claim that stops two finishing takes starting the next batch twice. */
  round?: number;
  /** Stop after each batch so the artist can review before the next. */
  pauseBetween?: boolean;
  /** Paused between batches (press Continue). */
  paused?: boolean;
  total?: number;
  by: { userId: string; role: AuthContext['role'] };
  startedAt: string;
  error: string | null;
}

const ACTIVE_TAKE_SQL = ['QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING'];

/** Size of batch number `round` (1-based): the last listed size repeats. */
const batchSize = (sizes: number[], round: number): number => Math.max(1, sizes[Math.min(round - 1, sizes.length - 1)] ?? 1);

/**
 * "Generate all", in sequential batches: films the approved scenes without a
 * video, in order, `sizes[0]` at a time, then `sizes[1]`… (the last size
 * repeats). A batch's scenes run together; the next batch starts only when
 * every scene in it finished, so the artist can stop, correct a script or a
 * character, and every later batch is generated with that fix. With
 * `pauseBetween`, it stops after each batch for review (Continue resumes).
 */
export async function startSequence(auth: AuthContext, workspaceId: string, projectId: string, options: { sizes?: number[] | undefined; pauseBetween?: boolean | undefined } = {}) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'STORYBOARD', 'SHOOT');
  if (mv.sequence?.active) throw AppError.conflict('Already generating.');
  const sizes = (options.sizes?.length ? options.sizes : (mv.sequence?.paused ? mv.sequence.sizes : undefined)) ?? [1];
  const pauseBetween = options.pauseBetween ?? (mv.sequence?.paused ? mv.sequence.pauseBetween : undefined) ?? false;
  // Continuing after a pause keeps counting batches.
  const round = mv.sequence?.paused ? (mv.sequence.round ?? 0) + 1 : 1;
  const scenes = await loadScenes(projectId);
  const withVideo = new Set(
    (await sql<{ sceneId: string }[]>`SELECT DISTINCT scene_id FROM studio_takes WHERE project_id = ${projectId} AND status IN ('READY', 'QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING')`).map(
      (row) => row.sceneId,
    ),
  );
  const queue = scenes.filter((scene) => scene.approvedAt && !withVideo.has(scene.id) && scene.prompt).map((scene) => scene.id);
  if (queue.length === 0) {
    const unapproved = scenes.filter((scene) => !scene.approvedAt).length;
    throw AppError.badRequest(
      unapproved
        ? `Every approved scene already has a video. ${unapproved} scene${unapproved === 1 ? ' is' : 's are'} not approved: approve ${unapproved === 1 ? 'it' : 'them'} to generate ${unapproved === 1 ? 'it' : 'them'} too.`
        : 'Every scene already has a video. Use Regenerate on a scene to film it again.',
    );
  }
  const size = batchSize(sizes, round);
  const batch = queue.slice(0, size);
  const sequence: Sequence = {
    active: true,
    queue: queue.slice(size),
    current: batch[0]!,
    batch,
    sizes,
    round,
    pauseBetween,
    paused: false,
    total: mv.sequence?.paused && mv.sequence.total ? mv.sequence.total : queue.length,
    by: { userId: auth.userId, role: auth.role },
    startedAt: new Date().toISOString(),
    error: null,
  };
  // Claim it atomically: a second Continue/Generate-all click arriving together gets 409, not a second batch.
  const claimed = await sql`
    UPDATE mv_projects SET sequence = ${json(sequence)}, updated_at = now()
    WHERE project_id = ${projectId} AND NOT COALESCE((sequence->>'active')::boolean, false) RETURNING project_id`;
  if (claimed.length === 0) throw AppError.conflict('Already generating.');
  try {
    // The whole batch is reserved and queued now (a 402 here leaves nothing started).
    await studio.generate(auth, workspaceId, projectId, batch, 1, false);
  } catch (error) {
    await sql`UPDATE mv_projects SET sequence = ${mv.sequence ? json(mv.sequence) : null}, updated_at = now() WHERE project_id = ${projectId}`;
    throw error;
  }
  return view(auth, workspaceId, projectId);
}

/**
 * Stops "Generate all" / Continue and "I trust your judgement". By default the
 * shot(s) being filmed now finish (already paid for) and nothing else starts;
 * with `now` they are cancelled as well (fal.ai is told to stop; only stages it
 * already rendered are charged). Continue picks up from the next unfilmed scene.
 */
export async function stopSequence(auth: AuthContext, workspaceId: string, projectId: string, now = false) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  const batch = mv.sequence?.batch ?? (mv.sequence?.current ? [mv.sequence.current] : []);
  if (mv.sequence) {
    // Paused (not finished): Continue resumes with the scenes still to film.
    const stopped: Sequence = { ...mv.sequence, active: false, paused: true, queue: [], error: null, ...(now ? { batch: [], current: null } : {}) };
    await sql`UPDATE mv_projects SET sequence = ${json(stopped)}, updated_at = now() WHERE project_id = ${projectId}`;
  }
  if (mv.autoMode) await sql`UPDATE mv_projects SET auto_mode = false, updated_at = now() WHERE project_id = ${projectId}`;
  if (now) {
    // Everything in flight on this project's scenes (the batch, auto shots, single regenerations).
    const scenes = await sql<{ id: string }[]>`
      SELECT DISTINCT scene_id AS id FROM studio_takes WHERE project_id = ${projectId} AND status = ANY(${ACTIVE_TAKE_SQL}::text[])`;
    const canceled = await studio.cancelScenes(projectId, [...new Set([...batch, ...scenes.map((row) => row.id)])]);
    logger.info({ projectId, canceled: canceled.length }, 'music video generation stopped now');
  }
  return view(auth, workspaceId, projectId);
}

/** Stops one scene's generation now (fal.ai is told to stop; files are cleared). */
export async function stopScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  const canceled = await studio.cancelScenes(projectId, [sceneId]);
  if (canceled.length === 0) throw AppError.badRequest(`Scene ${scene.position + 1} is not generating.`);
  // Stopping a shot of "I trust your judgement" hands control back to the artist.
  if (mv.autoMode) await sql`UPDATE mv_projects SET auto_mode = false, updated_at = now() WHERE project_id = ${projectId}`;
  // A queued take never reaches a worker, so move "Generate all" on here (claiming the round makes a second call a no-op).
  const [take] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${canceled[0]!}`;
  if (take) await advanceSequence(projectId, take).catch((error: unknown) => logger.error({ err: error, sceneId }, 'generate-all step after stop failed'));
  return view(auth, workspaceId, projectId);
}

async function advanceSequence(projectId: string, take: TakeRow): Promise<void> {
  const [mv] = await sql<MvRow[]>`SELECT * FROM mv_projects WHERE project_id = ${projectId}`;
  const sequence = mv?.sequence;
  const batch = sequence?.batch ?? (sequence?.current ? [sequence.current] : []);
  if (!mv || !sequence?.active || !batch.includes(take.sceneId)) return;
  if (take.status === 'READY') {
    await sql`UPDATE studio_scenes SET selected_take_id = COALESCE(selected_take_id, ${take.id}::uuid) WHERE id = ${take.sceneId}`;
  } else if (take.status !== 'FAILED' && take.status !== 'CANCELED') {
    return;
  }

  // Wait for the whole batch.
  const [{ running } = { running: 0 }] = await sql<{ running: number }[]>`
    SELECT count(*)::int AS running FROM studio_takes WHERE project_id = ${projectId} AND scene_id = ANY(${batch}::uuid[]) AND status = ANY(${ACTIVE_TAKE_SQL}::text[])`;
  if (running > 0) return;

  // Exactly one finishing take moves the sequence on: claim this round atomically.
  const round = sequence.round ?? 1;
  const claimed = await sql`
    UPDATE mv_projects SET sequence = jsonb_set(sequence, '{round}', ${json(round + 1)}), updated_at = now()
    WHERE project_id = ${projectId} AND (sequence->>'active')::boolean AND COALESCE((sequence->>'round')::int, 1) = ${round}
    RETURNING project_id`;
  if (claimed.length === 0) return;

  const failed = await sql<{ position: number; error: string | null }[]>`
    SELECT s.position, t.error FROM studio_scenes s
    JOIN LATERAL (SELECT status, error FROM studio_takes WHERE scene_id = s.id AND status <> 'CANCELED' ORDER BY created_at DESC LIMIT 1) t ON true
    WHERE s.id = ANY(${batch}::uuid[]) AND t.status = 'FAILED' ORDER BY s.position`;
  const save = (next: Partial<Sequence>): Promise<unknown> => sql`UPDATE mv_projects SET sequence = ${json({ ...sequence, ...next })} WHERE project_id = ${projectId}`;
  // A scene of the batch stopped by the artist (no video for it): pause so they decide what's next.
  const stopped = await sql<{ position: number }[]>`
    SELECT s.position FROM studio_scenes s
    WHERE s.id = ANY(${batch}::uuid[])
      AND NOT EXISTS (SELECT 1 FROM studio_takes t WHERE t.scene_id = s.id AND t.status = 'READY')
      AND (SELECT status FROM studio_takes WHERE scene_id = s.id ORDER BY created_at DESC LIMIT 1) = 'CANCELED'
    ORDER BY s.position`;
  if (stopped.length) {
    await save({
      active: false,
      paused: true,
      round,
      batch: [],
      current: null,
      // Continue rebuilds the queue from every approved scene still without a video (the stopped one included).
      error: `Stopped: scene ${stopped.map((row) => row.position + 1).join(', ')} was stopped before it finished. Press Continue to go on.`,
    });
    return;
  }
  if (failed.length) {
    await save({
      active: false,
      round,
      error: `Batch ${round} stopped: scene ${failed.map((row) => row.position + 1).join(', ')} failed (${(failed[0]!.error ?? 'the take failed').slice(0, 240)}). Fix it, then press Continue.`,
      paused: true,
    });
    return;
  }

  let queue = [...sequence.queue];
  if (queue.length === 0) {
    await save({ active: false, paused: false, queue: [], current: null, batch: [], round });
    return;
  }
  if (sequence.pauseBetween) {
    await save({ active: false, paused: true, round, batch: [], current: null });
    return;
  }

  const auth: AuthContext = { userId: sequence.by.userId, role: sequence.by.role, sessionId: 'sequence' };
  // Skip scenes unapproved (or given a video) while they waited.
  const ready = new Set(
    (
      await sql<{ id: string }[]>`
        SELECT s.id FROM studio_scenes s WHERE s.id = ANY(${queue}::uuid[]) AND s.approved_at IS NOT NULL AND s.prompt IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM studio_takes t WHERE t.scene_id = s.id AND t.status = 'READY')`
    ).map((row) => row.id),
  );
  queue = queue.filter((id) => ready.has(id));
  const size = batchSize(sequence.sizes ?? [1], round + 1);
  const next = queue.slice(0, size);
  if (next.length === 0) {
    await save({ active: false, paused: false, queue: [], current: null, batch: [], round });
    return;
  }
  try {
    // Read at start time: edits made while the previous batch was filming are used.
    await studio.generate(auth, mv.workspaceId, projectId, next, 1, false);
    await save({ queue: queue.slice(size), current: next[0]!, batch: next, round: round + 1 });
  } catch (error) {
    await save({ active: false, paused: true, queue, current: null, batch: [], round, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
}

/* ------------------------------------------------------------------ cut / mute on the timeline */

/**
 * Cut or mute a range picked on the working mix (the song as the video uses
 * it). The range is mapped back onto the original song through the current
 * edits, added as region(s), and the mix is re-rendered.
 */
export async function editMixRange(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  input: { start: number; end: number; op: 'cut' | 'mute' | 'gain' | 'fadein' | 'fadeout'; gainDb?: number | undefined },
) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'STORYBOARD', 'SHOOT');
  const originalId = mv.originalSongId ?? project.musicAssetId;
  const [song] = originalId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${originalId}` : [];
  const duration = song?.meta.durationSec;
  if (!song || !duration) throw AppError.badRequest('The song length is unknown; edit it on the Sound stage.');
  if (input.end - input.start < 0.1) throw AppError.badRequest('Select a longer section.');
  if (mv.audioEdits.clips?.length) throw AppError.badRequest('This song is arranged as events: edit it on the music track and render the mix.');
  const pieces = arrange(duration, mv.audioEdits.regions);
  const added: Region[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const length = piece.to - piece.from;
    const from = Math.max(input.start, cursor);
    const to = Math.min(input.end, cursor + length);
    if (to > from) {
      const op: Region['op'] = input.op === 'cut' ? 'cut' : input.op === 'fadein' || input.op === 'fadeout' ? input.op : 'gain';
      const region: Region = { id: randomUUID(), op, start: +(piece.from + (from - cursor)).toFixed(3), end: +(piece.from + (to - cursor)).toFixed(3) };
      if (input.op === 'mute') region.gainDb = -60;
      if (input.op === 'gain') region.gainDb = Math.max(-24, Math.min(12, input.gainDb ?? 0));
      added.push(region);
    }
    cursor += length;
  }
  if (added.length === 0) throw AppError.badRequest('That section is outside the song.');
  const edits: AudioEdits = { ...mv.audioEdits, regions: [...mv.audioEdits.regions, ...added] };
  await sql`UPDATE mv_projects SET audio_edits = ${json(edits)}, mix_rendered_at = NULL WHERE project_id = ${projectId}`;
  await buildMix(auth, workspaceId, project, (await load(workspaceId, projectId)).mv);
  return view(auth, workspaceId, projectId);
}

/** Real waveform + tempo, key, loudness and sections of the working mix (or the original), cached per file. */
export async function audioAnalysis(auth: AuthContext, workspaceId: string, projectId: string, which: 'mix' | 'original') {
  await access(auth, workspaceId, false);
  const { project, mv } = await load(workspaceId, projectId);
  const assetId = which === 'original' ? (mv.originalSongId ?? project.musicAssetId) : project.musicAssetId;
  const [asset] = assetId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${assetId} AND status = 'READY'` : [];
  if (!asset) throw AppError.badRequest('Upload the song first.');
  const cached = mv.audioAnalysis?.[asset.id];
  if (cached && cached.version === ANALYSIS_VERSION) return { assetId: asset.id, analysis: cached };
  // One analysis per file at a time (the song page asks for "mix" and "original" together, often the same file).
  let running = analysing.get(asset.id);
  if (!running) {
    running = analyseAudio(asset.key).finally(() => analysing.delete(asset.id));
    analysing.set(asset.id, running);
  }
  const analysis = await running;
  // Merge in SQL so two parallel analyses never overwrite each other; the fresh result always wins over a stale
  // cached one (it used to be spread underneath the old entry, so an outdated analysis kept coming back).
  const keep = [project.musicAssetId, mv.originalSongId].filter((id): id is string => Boolean(id));
  await sql`
    UPDATE mv_projects SET audio_analysis = (
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      FROM jsonb_each(COALESCE(audio_analysis, '{}'::jsonb) || ${json({ [asset.id]: analysis })}) AS entry
      WHERE entry.key = ANY(${[...keep, asset.id]}::text[])
    )
    WHERE project_id = ${projectId}`;
  return { assetId: asset.id, analysis };
}
const analysing = new Map<string, Promise<AudioAnalysis>>();

/** The volume line: whole-track level of the song (re-renders the mix). */
export async function setTrackGain(auth: AuthContext, workspaceId: string, projectId: string, gainDb: number) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SOUND', 'STORYBOARD', 'SHOOT');
  const edits: AudioEdits = { ...mv.audioEdits, gainDb: Math.max(-24, Math.min(12, gainDb)) };
  await sql`UPDATE mv_projects SET audio_edits = ${json(edits)}, mix_rendered_at = NULL WHERE project_id = ${projectId}`;
  await buildMix(auth, workspaceId, project, (await load(workspaceId, projectId)).mv);
  return view(auth, workspaceId, projectId);
}

/**
 * The storyboard arrangement (Cubase-style audio events on the music track).
 * Replaces the region edits: the events already hold every cut, move, copy,
 * gain and fade. One render, one charge.
 */
export async function saveClips(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  clips: Clip[],
  extra: { gainDb?: number | undefined; layers?: AudioEdits['layers'] | undefined; tracks?: AudioTrack[] | undefined } = {},
) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'STORYBOARD', 'SHOOT');
  const originalId = mv.originalSongId ?? project.musicAssetId;
  const [song] = originalId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${originalId}` : [];
  const duration = song?.meta.durationSec;
  if (!song || !duration) throw AppError.badRequest('The song length is unknown; re-upload it on the Song stage.');
  const clean = clips
    .map((clip) => {
      const src = Math.max(0, Math.min(duration, clip.src));
      const len = Math.min(clip.len, duration - src);
      return { ...clip, src: +src.toFixed(4), len: +len.toFixed(4), at: +Math.max(0, clip.at).toFixed(4), fadeIn: Math.min(clip.fadeIn, len), fadeOut: Math.min(clip.fadeOut, len) };
    })
    .filter((clip) => clip.len >= 0.02);
  if (!clean.some((clip) => !clip.muted)) throw AppError.badRequest('Keep at least one unmuted event on the music track.');
  // Imported tracks: their events must use this project's own audio files.
  if (extra.layers?.length) {
    const own = new Set((await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE project_id = ${project.id} AND role = 'SFX' AND status = 'READY'`).map((row) => row.id));
    if (extra.layers.some((layer) => !own.has(layer.assetId))) throw AppError.badRequest('An audio track uses a file that is not in this project.');
  }
  const edits: AudioEdits = {
    ...mv.audioEdits,
    regions: [],
    clips: clean,
    ...(extra.gainDb !== undefined ? { gainDb: Math.max(-24, Math.min(12, extra.gainDb)) } : {}),
    ...(extra.layers ? { layers: extra.layers } : {}),
    ...(extra.tracks ? { tracks: extra.tracks } : {}),
  };
  await sql`UPDATE mv_projects SET audio_edits = ${json(edits)}, mix_rendered_at = NULL WHERE project_id = ${projectId}`;
  await buildMix(auth, workspaceId, project, (await load(workspaceId, projectId)).mv);
  return view(auth, workspaceId, projectId);
}

/** Streams the ORIGINAL song through the API (the bucket has no CORS rule, so the browser can't fetch it for Web Audio). */
export async function songSource(auth: AuthContext, workspaceId: string, projectId: string, assetId?: string) {
  await access(auth, workspaceId, false);
  const { project, mv } = await load(workspaceId, projectId);
  const originalId = mv.originalSongId ?? project.musicAssetId;
  // The original song, or one of this project's imported audio files (audio tracks).
  const [song] = assetId
    ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${assetId} AND project_id = ${project.id} AND role IN ('SFX', 'MUSIC', 'MIX') AND status = 'READY'`
    : originalId
      ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${originalId} AND status = 'READY'`
      : [];
  if (!song) throw AppError.badRequest('Upload the song first.');
  const object = await getObjectStream(song.key);
  if (!object) throw AppError.notFound('Song');
  return { ...object, contentType: object.contentType ?? song.contentType ?? 'audio/mpeg' };
}

/**
 * The storyboard mixer (Cubase MixConsole style): the imported audio tracks
 * (added / removed / renamed, level, mute), every channel strip's effects
 * (song, overlay lane, each track) and the overlay events with the track each
 * sits on. A removed track's events move back to the overlay lane (never
 * silently lost). One save = one mix render (the price is shown first).
 */
export async function saveMixer(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  input: { tracks: AudioTrack[]; layers: AudioEdits['layers']; musicFx?: TrackFx | undefined; overlayFx?: TrackFx | undefined },
) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SOUND', 'STORYBOARD', 'SHOOT');
  if (new Set(input.tracks.map((track) => track.id)).size !== input.tracks.length) throw AppError.badRequest('Two tracks share an id.');
  if (input.layers.length) {
    const own = new Set((await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE project_id = ${project.id} AND role = 'SFX' AND status = 'READY'`).map((row) => row.id));
    if (input.layers.some((layer) => !own.has(layer.assetId))) throw AppError.badRequest('An audio event uses a file that is not in this project.');
  }
  const trackIds = new Set(input.tracks.map((track) => track.id));
  const layers = input.layers.map((layer) => {
    if (!layer.track || trackIds.has(layer.track)) return layer;
    const moved = { ...layer };
    delete moved.track;
    return moved;
  });
  const edits: AudioEdits = {
    ...mv.audioEdits,
    tracks: input.tracks,
    layers,
    ...(input.musicFx ? { musicFx: input.musicFx } : {}),
    ...(input.overlayFx ? { overlayFx: input.overlayFx } : {}),
  };
  if (!input.musicFx) delete edits.musicFx;
  if (!input.overlayFx) delete edits.overlayFx;
  await sql`UPDATE mv_projects SET audio_edits = ${json(edits)}, mix_rendered_at = NULL WHERE project_id = ${projectId}`;
  await buildMix(auth, workspaceId, project, (await load(workspaceId, projectId)).mv);
  return view(auth, workspaceId, projectId);
}

/** Overlay tracks (effect layers under the song) edited on the storyboard timeline. */
export async function saveLayers(auth: AuthContext, workspaceId: string, projectId: string, layers: AudioEdits['layers']) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SOUND', 'STORYBOARD', 'SHOOT');
  const edits: AudioEdits = { ...mv.audioEdits, layers };
  await sql`UPDATE mv_projects SET audio_edits = ${json(edits)}, mix_rendered_at = NULL WHERE project_id = ${projectId}`;
  await buildMix(auth, workspaceId, project, (await load(workspaceId, projectId)).mv);
  return view(auth, workspaceId, projectId);
}

/** Called by the take worker when a take settles (auto mode only does anything). */
export async function onTakeFinished(takeId: string): Promise<void> {
  const [take] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId}`;
  if (!take) return;
  // VeloBot checks every finished shot in the background (weak, off-story, lip sync, looks AI…).
  if (take.status === 'READY') void reviewTake(takeId).catch(() => undefined);
  await advanceSequence(take.projectId, take).catch((error: unknown) => logger.error({ err: error, takeId }, 'generate-all step failed'));
  const [mv] = await sql<MvRow[]>`SELECT * FROM mv_projects WHERE project_id = ${take.projectId}`;
  if (!mv?.autoMode || mv.stage !== 'SHOOT') return;
  if (take.status === 'READY') {
    await sql`UPDATE studio_scenes SET selected_take_id = ${takeId}, shot_approved_at = now() WHERE id = ${take.sceneId} AND shot_approved_at IS NULL`;
  } else if (take.status === 'FAILED') {
    // Auto mode stops and hands back to the artist; finished scenes stay approved.
    await sql`UPDATE mv_projects SET auto_mode = false WHERE project_id = ${take.projectId}`;
    await sql`UPDATE studio_projects SET error = ${`Auto shoot paused: a take for one scene failed (${(take.error ?? 'unknown error').slice(0, 300)}). Re-shoot it, then continue.`} WHERE id = ${take.projectId}`;
    return;
  }
  await finishAuto(take.projectId);
}

async function finishAuto(projectId: string): Promise<void> {
  const [mv] = await sql<MvRow[]>`SELECT * FROM mv_projects WHERE project_id = ${projectId}`;
  if (!mv?.autoMode || !mv.autoBy) return;
  if (await firstUnshot(projectId)) return;
  const auth: AuthContext = { userId: mv.autoBy.userId, role: mv.autoBy.role, sessionId: 'auto-shoot' };
  try {
    await sql`
      UPDATE mv_projects SET approvals = approvals || ${json({ SHOOT: new Date().toISOString() })}, stage = 'MASTER', auto_mode = false, updated_at = now()
      WHERE project_id = ${projectId}`;
    await studio.assemble(auth, mv.workspaceId, projectId, { loudnessLufs: mv.loudnessLufs }, false);
    logger.info({ projectId }, 'auto shoot complete: master started');
  } catch (error) {
    logger.error({ err: error, projectId }, 'auto shoot could not start the master');
    await sql`UPDATE studio_projects SET error = ${`Every scene is shot, but the final cut could not start: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`} WHERE id = ${projectId}`;
  }
}

/** True while the saved polish/sync report still matches the locked shots (same shots, same takes, no edits since). */
async function polishFresh(projectId: string, report: PolishReport | null | undefined): Promise<boolean> {
  if (!report?.sync) return false;
  const locked = await sql<{ id: string; changed: boolean }[]>`
    SELECT s.id, (s.updated_at > ${report.at}::timestamptz OR t.created_at > ${report.at}::timestamptz OR t.finished_at > ${report.at}::timestamptz) AS changed
    FROM studio_scenes s JOIN studio_takes t ON t.id = s.selected_take_id AND t.status = 'READY'
    WHERE s.project_id = ${projectId} AND s.shot_approved_at IS NOT NULL ORDER BY s.position`;
  if (locked.length !== report.sync.shots.length || locked.some((row, index) => row.id !== report.sync!.shots[index]!.sceneId || row.changed)) return false;
  const [mv] = await sql<{ updatedAudio: boolean }[]>`SELECT (mix_rendered_at > ${report.at}::timestamptz) AS updated_audio FROM mv_projects WHERE project_id = ${projectId}`;
  return !mv?.updatedAudio;
}

/**
 * VeloBot AI master: measures the song, sets the mastering desk for the genre, renders and
 * re-measures it, and saves the settings + the report (what / why, scores out of 100) on the
 * project's finish. Free (local analysis); the artist can tweak every control afterwards.
 */
export async function aiMasterProject(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'MASTER');
  if (project.status === 'ASSEMBLING') throw AppError.conflict('Wait for the master to finish (or pause it) first.');
  const [song] = project.musicAssetId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${project.musicAssetId}` : [];
  if (!song) throw AppError.badRequest('The song is missing.');
  const targetLufs = project.finish?.loudnessLufs ?? mv.loudnessLufs ?? -14;
  const report = await aiMaster(song.key, { genre: mv.genre || 'pop', targetLufs });
  await sql`
    UPDATE studio_projects SET finish = COALESCE(finish, '{}'::jsonb) || ${json({ audio: report.settings, aiReport: report })}, updated_at = now()
    WHERE id = ${projectId}`;
  return { project: await view(auth, workspaceId, projectId), report };
}

/** Re-check: VeloBot reviews the scene's picked (or newest finished) take again, in the background. */
export async function reviewScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [take] = await sql<{ id: string }[]>`
    SELECT t.id FROM studio_takes t JOIN studio_scenes s ON s.id = t.scene_id
    WHERE t.scene_id = ${sceneId} AND s.project_id = ${projectId} AND t.status = 'READY'
    ORDER BY (t.id = s.selected_take_id) DESC, t.created_at DESC LIMIT 1`;
  if (!take) throw AppError.badRequest('This scene has no finished video to check yet.');
  await sql`UPDATE studio_takes SET review = ${json({ status: 'RUNNING', at: new Date().toISOString() })} WHERE id = ${take.id}`;
  void reviewTake(take.id, true);
  return view(auth, workspaceId, projectId);
}

/** Keep a flagged take anyway: the red flag goes. */
export async function dismissSceneReview(auth: AuthContext, workspaceId: string, projectId: string, takeId: string) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [take] = await sql<{ id: string }[]>`SELECT id FROM studio_takes WHERE id = ${takeId} AND project_id = ${projectId}`;
  if (!take) throw AppError.notFound('Take');
  await dismissReview(takeId);
  return view(auth, workspaceId, projectId);
}

/** Stops the running master; with keep, what's done so far becomes a playable preview. */
export async function stopMaster(auth: AuthContext, workspaceId: string, projectId: string, keep: boolean) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'MASTER');
  if (project.status !== 'ASSEMBLING') throw AppError.badRequest('The film is not being mastered right now.');
  // Nothing that costs tokens keeps running: no new "Generate all" batch, no auto shots…
  if (mv.sequence?.active) {
    await sql`UPDATE mv_projects SET sequence = ${json({ ...mv.sequence, active: false, paused: true, queue: [], batch: [], current: null, error: null })} WHERE project_id = ${projectId}`;
  }
  if (mv.autoMode) await sql`UPDATE mv_projects SET auto_mode = false WHERE project_id = ${projectId}`;
  // …and running takes + the cut stop (the engine requests are cancelled, not left to finish).
  await studio.cancel(auth, workspaceId, projectId, keep);
  return view(auth, workspaceId, projectId);
}

/** Unlocks a locked scene (it leaves the stitch until locked again). */
export async function unlockShot(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  await access(auth, workspaceId, true);
  const { mv } = await load(workspaceId, projectId);
  assertStage(mv, 'STORYBOARD', 'SHOOT');
  await sql`UPDATE studio_scenes SET shot_approved_at = NULL WHERE id = ${sceneId} AND project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/** The free AI polish pass: beat sync, AI transitions, flop check (see polish.ts). */
export async function polish(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'SHOOT', 'MASTER');
  const [music] = project.musicAssetId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${project.musicAssetId}` : [];
  if (!music) throw AppError.badRequest('The song is missing.');
  await polishProject(projectId, music.key);
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ master */

export async function master(auth: AuthContext, workspaceId: string, projectId: string, finish: Parameters<typeof studio.assemble>[3], dryRun: boolean, ignoreFlops = false) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'MASTER');
  if (!dryRun) {
    // The polish pass always runs right before stitching (beat sync + AI transitions + flop check).
    const [music] = project.musicAssetId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${project.musicAssetId}` : [];
    if (music) {
      // The check downloads every take: reuse the last report while nothing it looked at has changed.
      const report = (await polishFresh(projectId, mv.polish)) ? mv.polish! : await polishProject(projectId, music.key);
      if (report.flops.length && !ignoreFlops) {
        throw AppError.badRequest(
          `The polish pass found ${report.flops.length} weak shot${report.flops.length === 1 ? '' : 's'} (${report.flops.map((flop) => `scene ${flop.position + 1}: ${flop.reason}`).join('; ')}). Regenerate them, or stitch anyway.`,
        );
      }
    }
  }
  const loudness = finish?.loudnessLufs ?? mv.loudnessLufs;
  if (!dryRun && loudness !== mv.loudnessLufs) await sql`UPDATE mv_projects SET loudness_lufs = ${loudness} WHERE project_id = ${projectId}`;
  const result = await studio.assemble(auth, workspaceId, projectId, { ...finish, loudnessLufs: loudness }, dryRun);
  return { estimate: result.estimate, project: dryRun ? null : await view(auth, workspaceId, projectId) };
}
