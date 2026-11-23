/**
 * The song map: how a professional music video is cut to its song.
 *
 *   mixLyrics     lyric lines moved from the ORIGINAL song's timeline onto
 *                 the edited mix (after DAW cuts / swaps), so every scene
 *                 gets the words actually heard under it
 *   songMap       sections (intro / verse / chorus / bridge / outro, from the
 *                 energy analysis) with the lines sung in each, bar length
 *                 and the instrumental gaps, as text for the director
 *   lockToSong    after the storyboard: scene cuts land on bar lines,
 *                 each scene's lyric is the real words under it, lip sync is
 *                 switched off where nobody sings (an instrumental with a
 *                 moving mouth is the classic AI tell), and performance
 *                 shots never start in the middle of a word
 *
 * Direction settings (the artist's taste) shape the plan: performance vs
 * story share, cutting pace, and how literally the pictures follow the words.
 */
import { z } from 'zod';
import { sql, json } from '../studio/sql.js';
import type { AssetRow } from '../studio/types.js';
import { analyseAudio, ANALYSIS_VERSION, type AudioAnalysis } from './analysis.js';
import { mixPieces, mixPositions, type AudioEdits, type Lyrics } from './audio.js';

export const directionSchema = z.strictObject({
  /** Share of the running time that is the artist performing to camera (lip-synced). */
  performanceShare: z.number().min(0.1).max(0.9),
  /** slow ≈ a cut every 2 bars or more, medium ≈ 1-2 bars, fast ≈ every bar. */
  pace: z.enum(['slow', 'medium', 'fast']),
  /** literal: picture shows what the words say; metaphorical: a story that mirrors them; abstract: mood and imagery. */
  lyricApproach: z.enum(['literal', 'metaphorical', 'abstract']),
  /** Choruses always return to the same hero performance set-up (location, look, framing). */
  chorusHome: z.boolean(),
  /** Who the supporting cast, extras and crowd are (asked during information gathering). auto = follow the song's regional cue. */
  castBackground: z.enum(['auto', 'local', 'black', 'white', 'black_white', 'diverse', 'south_asian', 'east_asian', 'latino', 'middle_eastern', 'custom']),
  /** The artist's own words on the cast mix (with "custom", or added detail). */
  castNote: z.string().trim().max(200),
  /** Where the video is shot ("Lagos, Nigeria", "a beach in Accra", "South London estate"). Empty = follow the song's cue. */
  shootLocation: z.string().trim().max(160),
});
export type Direction = z.infer<typeof directionSchema>;

export const DEFAULT_DIRECTION: Direction = { performanceShare: 0.5, pace: 'medium', lyricApproach: 'metaphorical', chorusHome: true, castBackground: 'auto', castNote: '', shootLocation: '' };

export const CAST_LABEL: Record<Direction['castBackground'], string> = {
  auto: '',
  local: 'people who look local to the shoot location',
  black: 'Black people',
  white: 'white people',
  black_white: 'a natural mix of Black and white people',
  diverse: 'a natural, diverse mix of backgrounds',
  south_asian: 'South Asian people',
  east_asian: 'East Asian people',
  latino: 'Latino / Hispanic people',
  middle_eastern: 'Middle Eastern / North African people',
  custom: '',
};

/**
 * Cast background + shoot location as one line for the director and every
 * shot prompt. The artist's settings win; when they left them open, the
 * song's regional cue (from the words: languages, slang, places) fills in the
 * place and a local cast. Empty when there is nothing to go on.
 */
export function placeText(direction: Direction, voice?: Lyrics['voice']): string {
  const cue = voice && voice.region && voice.confidence !== 'low' ? voice.region : '';
  const location = direction.shootLocation || (cue ? `${cue} (the song's own setting, from its language and accent)` : '');
  const custom = direction.castNote.trim();
  let cast = '';
  if (direction.castBackground === 'custom') cast = custom;
  else if (direction.castBackground === 'auto') cast = cue ? `people commonly seen in ${direction.shootLocation || cue}` : custom;
  else cast = `${CAST_LABEL[direction.castBackground]}${custom ? ` (${custom})` : ''}`;
  return [location ? `Shot in ${location}` : '', cast ? `supporting cast, extras and crowd: ${cast}` : ''].filter(Boolean).join('; ');
}

export function parseDirection(value: unknown): Direction {
  const parsed = directionSchema.partial().safeParse(value ?? {});
  return { ...DEFAULT_DIRECTION, ...(parsed.success ? parsed.data : {}) };
}

// Scenes are the units the video model renders (up to 10 s each): too short and the detail is lost.
// Faster cutting inside a scene is the editor's job (trims / quick-clip), not more, shorter scenes.
export const PACE_LABEL: Record<Direction['pace'], string> = {
  slow: 'scenes of about 8-10 s (2-4 bars), letting the story breathe',
  medium: 'scenes of about 6-9 s (2-3 bars)',
  fast: 'scenes of about 4-7 s (1-2 bars), quicker cuts on the high-energy parts only',
};
export const APPROACH_LABEL: Record<Direction['lyricApproach'], string> = {
  literal: 'the pictures show what the words say',
  metaphorical: 'a story that mirrors the words without illustrating each line',
  abstract: 'mood, place and imagery; the words set the feeling, not the action',
};

type Line = Lyrics['lines'][number];

/** Lyric lines on the edited mix's timeline (lines inside a cut are dropped). */
export function mixLyrics(lines: Line[], originalSeconds: number | undefined, edits: AudioEdits | null | undefined): Line[] {
  if (!originalSeconds || (!edits?.regions?.length && !edits?.clips?.length)) return lines;
  const pieces = mixPieces(originalSeconds, edits);
  // A line copied with its event (a repeated chorus) is placed at every copy.
  return lines
    .flatMap((line) => mixPositions(pieces, line.start).map((start) => ({ ...line, start, end: start + Math.max(0.2, line.end - line.start) })))
    .sort((a, b) => a.start - b.start);
}

export interface SongContext {
  lines: Line[];
  analysis: AudioAnalysis | null;
  songSeconds: number | null;
  /** Where the video starts in the mix. */
  songStart: number;
}

/** Lyrics on the mix timeline + the mix's analysis (computed and cached when missing). */
export async function songContext(projectId: string, opts: { analyse: boolean } = { analyse: true }): Promise<SongContext> {
  const [row] = await sql<{ lyrics: Lyrics | null; audioEdits: AudioEdits | null; originalSongId: string | null; audioAnalysis: Record<string, AudioAnalysis> | null; musicAssetId: string | null; brief: { songStart?: number } }[]>`
    SELECT m.lyrics, m.audio_edits, m.original_song_id, m.audio_analysis, p.music_asset_id, p.brief
    FROM mv_projects m JOIN studio_projects p ON p.id = m.project_id WHERE m.project_id = ${projectId}`;
  if (!row) return { lines: [], analysis: null, songSeconds: null, songStart: 0 };
  const ids = [row.originalSongId, row.musicAssetId].filter((id): id is string => Boolean(id));
  const assets = ids.length ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ANY(${ids}::uuid[])` : [];
  const original = assets.find((asset) => asset.id === row.originalSongId);
  const mix = assets.find((asset) => asset.id === row.musicAssetId);
  // When the mix IS the original (no DAW edits rendered), times already match.
  const lines = mixLyrics(row.lyrics?.lines ?? [], mix && original && mix.id !== original.id ? original.meta.durationSec : undefined, row.audioEdits);
  let analysis = mix ? (row.audioAnalysis?.[mix.id] ?? null) : null;
  if (analysis && (analysis.version ?? 1) < ANALYSIS_VERSION) analysis = null;
  if (!analysis && mix && opts.analyse) {
    try {
      analysis = { ...(await analyseAudio(mix.key)), version: ANALYSIS_VERSION };
      await sql`UPDATE mv_projects SET audio_analysis = COALESCE(audio_analysis, '{}'::jsonb) || ${json({ [mix.id]: analysis })} WHERE project_id = ${projectId}`;
    } catch {
      analysis = null;
    }
  }
  return { lines, analysis, songSeconds: mix?.meta.durationSec ?? analysis?.duration ?? null, songStart: Math.max(0, row.brief?.songStart ?? 0) };
}

/** Lines sung in [start, end) (video time, i.e. after songStart). */
export function linesIn(context: SongContext, start: number, end: number): Line[] {
  const from = context.songStart + start;
  const to = context.songStart + end;
  return context.lines.filter((line) => line.text.trim() && line.end > from + 0.15 && line.start < to - 0.15);
}

/** Seconds of singing inside [start, end) (video time). */
export function sungSeconds(context: SongContext, start: number, end: number): number {
  return linesIn(context, start, end).reduce((sum, line) => sum + Math.max(0, Math.min(line.end, context.songStart + end) - Math.max(line.start, context.songStart + start)), 0);
}

function barSeconds(analysis: AudioAnalysis | null): number | null {
  return analysis?.bpm ? (4 * 60) / analysis.bpm : null;
}

/** The map the director plans on: sections, the words in each, bar length, instrumental gaps. */
export function songMapText(context: SongContext, direction: Direction): string {
  const total = (context.songSeconds ?? context.analysis?.duration ?? 0) - context.songStart;
  if (total <= 0) return '<song_map>unknown</song_map>';
  const bar = barSeconds(context.analysis);
  const sections =
    context.analysis?.sections.length
      ? context.analysis.sections
          .map((section) => ({ ...section, start: section.start - context.songStart, end: section.end - context.songStart }))
          .filter((section) => section.end > 0 && section.start < total)
      : [{ start: 0, end: total, label: 'Song', energy: 0.5 }];
  const rows = sections.map((section) => {
    const start = Math.max(0, section.start);
    const end = Math.min(total, section.end);
    const words = linesIn(context, start, end);
    const sung = sungSeconds(context, start, end);
    const vocal = sung / Math.max(0.1, end - start);
    // Analysis can leave energy/label null on some sections.
    const energy = typeof section.energy === 'number' && Number.isFinite(section.energy) ? section.energy : 0.5;
    const label = (section.label ?? 'Section').toString();
    return (
      `[${start.toFixed(1)}-${end.toFixed(1)}s] ${label.toUpperCase()} energy ${energy.toFixed(2)}, ${vocal < 0.15 ? 'INSTRUMENTAL (no singing: no lip sync here)' : `vocals ${Math.round(vocal * 100)}%`}` +
      (words.length ? `\n   ${words.map((line) => `(${(line.start - context.songStart).toFixed(1)}) ${line.text.trim()}`).join('\n   ')}` : '')
    );
  });
  return [
    '<song_map>',
    `Video length ${total.toFixed(1)} s${context.analysis?.bpm ? `, ${context.analysis.bpm} BPM, one bar = ${bar!.toFixed(2)} s` : ''}. Times are seconds into the video.`,
    ...rows,
    '</song_map>',
    '<direction>',
    `Performance (artist singing to camera, lip-synced) ≈ ${Math.round(direction.performanceShare * 100)}% of the running time; the rest is story and atmosphere.`,
    `Cutting pace: ${direction.pace} (${PACE_LABEL[direction.pace]}).`,
    `Lyric approach: ${direction.lyricApproach}: ${APPROACH_LABEL[direction.lyricApproach]}.`,
    direction.chorusHome ? 'Every chorus returns to the same hero performance set-up (same location, wardrobe and framing family) so the hook has a visual home.' : '',
    '</direction>',
  ]
    .filter(Boolean)
    .join('\n');
}

export const PRO_RULES =
  'Cut it like a professional music video. Scene boundaries sit on the song: section changes and bar lines (downbeats), never in the middle of a sung word. ' +
  'PERFORMANCE scenes (lip sync) only where the song map shows vocals, framed medium close-up or close-up, face toward the lens, mouth clear, 5-9 s (a whole line or two, never half a phrase); ' +
  'every scene runs long enough for its action and details to play out (usually 6-10 s): fewer, fuller scenes beat many thin ones. ' +
  'Aerial / drone shots sit on drops, kicks and big entrances: their move (rise, push, turn) starts on the beat that hits. ' +
  'the artist sings the words under that scene (lip-synced afterwards from the isolated vocal) with the line\'s emotion on the whole face and body: set emotion + intensity per scene (soft verse = subtle, full-voice hook = full out). ' +
  'Hums, "ooh"/"mm" lines, low or whispered choruses and cool laid-back lines are intensity 1: sung softly, lips barely part, no forced mouth shapes (a real singer does not open wide to hum). ' +
  'NARRATIVE scenes act out what the words under them are about, following the lyric approach; one clear action each; nobody mouths words. ' +
  'BROLL scenes carry instrumentals, intros, breaks and transitions: places, details, hands, light, crowd, no singing. ' +
  'Energy follows the song: calmer, wider and slower in low-energy parts; closer, more movement and more cuts as the energy rises; the biggest moment on the final chorus. ' +
  'Story has a beginning, turn and resolution across the verses, bridge and outro; repeated lines get a visual echo.';

export interface LockableScene {
  durationSec: number;
  lyric: string;
  lipSync: boolean;
  characterIds: string[];
  mode?: 'PERFORMANCE' | 'NARRATIVE' | 'BROLL' | null;
}

const clamp = (value: number): number => Math.min(10, Math.max(3, Math.round(value * 2) / 2));

/**
 * Locks a storyboard to the song (in place): cut points snap to the nearest
 * bar line within reach (never inside a word when the next scene is a
 * performance), lyrics come from the real timings, lip sync only where words
 * are sung, and each scene's mode is set.
 */
export function lockToSong<T extends LockableScene>(scenes: T[], context: SongContext): void {
  if (scenes.length === 0) return;
  const beats = context.analysis?.beats.map((beat) => beat - context.songStart).filter((beat) => beat > 0) ?? [];
  const bar = barSeconds(context.analysis);
  const downbeats = bar && beats.length ? beats.filter((_, index) => index % 4 === 0) : beats;
  const inWord = (time: number): boolean => linesIn(context, time - 0.05, time + 0.05).some((line) => line.start - context.songStart < time - 0.1 && line.end - context.songStart > time + 0.1);

  let at = 0;
  for (const [index, scene] of scenes.entries()) {
    let end = at + scene.durationSec;
    // Usually one shot (≤ 10 s); a scene the plan made longer keeps its length (filmed as an extended shot, ≤ 30 s).
    const cap = Math.max(10, Math.min(30, Math.ceil(scene.durationSec + 1)));
    if (index < scenes.length - 1 && downbeats.length) {
      // Nearest downbeat that keeps the scene 3 s to its cap, preferring ones not inside a word.
      const candidates = downbeats.filter((beat) => beat - at >= 3 && beat - at <= cap && Math.abs(beat - end) <= (bar ?? 1) * 0.75);
      const clean = candidates.filter((beat) => !inWord(beat));
      const pick = (clean.length ? clean : candidates).sort((a, b) => Math.abs(a - end) - Math.abs(b - end))[0];
      if (pick !== undefined) end = pick;
    }
    scene.durationSec = index < scenes.length - 1 ? Math.min(cap, Math.max(3, +(end - at).toFixed(2))) : clamp(end - at);
    const words = linesIn(context, at, at + scene.durationSec);
    const sung = sungSeconds(context, at, at + scene.durationSec);
    if (context.lines.length) {
      scene.lyric = words.map((line) => line.text.trim()).join(' / ').slice(0, 300);
      // Nobody sings here: a moving mouth would be wrong.
      if (sung < 0.8) scene.lipSync = false;
    }
    if (scene.lipSync && scene.characterIds.length === 0) scene.lipSync = false;
    scene.mode = scene.lipSync ? 'PERFORMANCE' : scene.characterIds.length ? (scene.mode === 'BROLL' ? 'BROLL' : 'NARRATIVE') : 'BROLL';
    at += scene.durationSec;
  }
}
