/**
 * Song sync: where each locked shot belongs in the song.
 *
 * The final cut only holds locked scenes (approved, with a finished video), so
 * when a scene is left out the picture is shorter than the storyboard. Playing
 * the song straight through would then slide every later shot earlier against
 * the music, and lip-synced shots would sing the wrong words.
 *
 * Instead every locked shot carries its own piece of the song:
 *   lip-synced shot  the exact slice its mouth was synced to (saved on the take
 *                    when it was generated, plus any trim-in), so the words
 *                    always match even after scenes were moved or resized;
 *   any other shot   its place on the full storyboard (Σ lengths before it).
 * Shots whose pieces follow each other form one continuous run of the song;
 * a left-out scene starts a new run (the song jumps with the picture, with a
 * short fade so there's no click). No gaps → the song plays untouched.
 */
import { sql } from '../studio/sql.js';
import { parseEdits } from '../studio/clipEdits.js';
import type { TakeSpec } from '../studio/types.js';

/** Seconds two pieces may be apart and still play as one continuous run (~half a frame). */
const JOIN = 0.02;

export interface ShotSync {
  sceneId: string;
  position: number;
  lipSync: boolean;
  /** Seconds after the song start where this shot's audio begins. */
  songFrom: number;
  /** Where the storyboard places it (Σ lengths of every scene before it). */
  planned: number;
  /** songFrom − planned: how far the shot's own audio sits from its storyboard slot. */
  drift: number;
  source: 'lip-sync take' | 'storyboard';
  note: string | null;
}

export interface SongRun {
  /** Seconds after the song start. */
  songFrom: number;
  /** Index range [first, last] into the locked shots. */
  first: number;
  last: number;
}

export interface SyncPlan {
  shots: ShotSync[];
  /** True when the song simply plays from its start (nothing left out, nothing moved). */
  continuous: boolean;
  /** Parts of the song (seconds after the song start) skipped because their scenes are left out. */
  skipped: { from: number; to: number; positions: number[] }[];
}

/**
 * The sync plan for the shots assembly will use (locked scenes with a finished
 * take, in order). `songKey` is the song the master plays (the current mix).
 */
export async function syncPlan(projectId: string, songKey: string | null, songStart: number): Promise<SyncPlan> {
  const rows = await sql<
    { id: string; position: number; durationSec: number; lipSync: boolean; locked: boolean; edits: unknown; spec: TakeSpec | null; ready: boolean }[]
  >`
    SELECT s.id, s.position, s.duration_sec, s.lip_sync, (s.shot_approved_at IS NOT NULL) AS locked, s.edits, t.spec,
      (t.status = 'READY' AND t.video_key IS NOT NULL) AS ready
    FROM studio_scenes s LEFT JOIN studio_takes t ON t.id = s.selected_take_id
    WHERE s.project_id = ${projectId} ORDER BY s.position`;

  const shots: ShotSync[] = [];
  const skipped: SyncPlan['skipped'] = [];
  let planned = 0;
  for (const row of rows) {
    const length = Number(row.durationSec);
    const used = row.locked && row.ready;
    if (!used) {
      const last = skipped.at(-1);
      if (last && Math.abs(last.to - planned) < JOIN) {
        last.to = planned + length;
        last.positions.push(row.position + 1);
      } else skipped.push({ from: planned, to: planned + length, positions: [row.position + 1] });
      planned += length;
      continue;
    }
    const edits = parseEdits(row.edits);
    const music = row.spec?.music;
    let songFrom = planned;
    let source: ShotSync['source'] = 'storyboard';
    let note: string | null = null;
    if (row.lipSync && music) {
      if (!songKey || music.key === songKey) {
        // The words the mouth sings: the slice the take was synced to, shifted by any trim-in.
        songFrom = Math.max(0, music.start - songStart + edits.trimIn * edits.speed);
        source = 'lip-sync take';
        if (edits.speed !== 1) note = `Speed is ${edits.speed}×: the mouth no longer matches the song. Set the speed back to 1× for this lip-synced shot.`;
      } else {
        note = 'This take was lip-synced to an earlier version of the song (the audio was edited since). Regenerate it if the words drift.';
      }
    }
    const drift = +(songFrom - planned).toFixed(3);
    if (source === 'lip-sync take' && Math.abs(drift) >= 0.05 && !note) {
      note = `The scene moved ${Math.abs(drift).toFixed(2)} s ${drift > 0 ? 'earlier' : 'later'} on the storyboard after this take was made: it keeps the words it was synced to.`;
    }
    shots.push({ sceneId: row.id, position: row.position, lipSync: row.lipSync, songFrom: +songFrom.toFixed(3), planned: +planned.toFixed(3), drift, source, note });
    planned += length;
  }
  // Skipped ranges after the last used shot don't matter (the film simply ends there).
  const end = shots.length ? Math.max(...shots.map((shot, index) => shot.songFrom + Number(rows.find((row) => row.id === shots[index]!.sceneId)!.durationSec))) : 0;
  const inside = skipped.filter((range) => range.from < end - JOIN);
  const continuous = shots.every((shot, index) => {
    const before = shots.slice(0, index).reduce((sum, item) => sum + Number(rows.find((row) => row.id === item.sceneId)!.durationSec), 0);
    return Math.abs(shot.songFrom - before) < JOIN;
  });
  return { shots, continuous, skipped: inside.map((range) => ({ from: +range.from.toFixed(2), to: +range.to.toFixed(2), positions: range.positions })) };
}

/** A shot kept by a mastering range: how much of its head is cut, how long it plays, where its song starts. */
export interface RangeCut {
  index: number;
  head: number;
  length: number;
  songFrom: number;
}

/**
 * Master only part of the song (the start / end markers on the master page):
 * keeps the shots whose song slice overlaps [start, end), cutting the first
 * one's head and the last one's tail exactly at the markers. Slivers under
 * half a second are dropped. No range → every shot, whole.
 */
export function cutToRange(lengths: number[], songFroms: number[], range: { start: number; end: number } | null | undefined): RangeCut[] {
  return lengths.flatMap((length, index) => {
    const from = songFroms[index] ?? 0;
    if (!range) return [{ index, head: 0, length, songFrom: from }];
    const start = Math.max(from, range.start);
    const end = Math.min(from + length, range.end);
    if (end - start < 0.5) return [];
    return [{ index, head: +(start - from).toFixed(3), length: +(end - start).toFixed(3), songFrom: +start.toFixed(3) }];
  });
}

/**
 * Groups shots into continuous runs of the song, given each shot's frame-exact
 * start and length on the video (seconds). A run continues while the next
 * shot's audio follows on from the previous one.
 */
export function songRuns(plan: SyncPlan, lengths: number[]): SongRun[] {
  const runs: SongRun[] = [];
  plan.shots.forEach((shot, index) => {
    const run = runs.at(-1);
    if (run) {
      const runLength = lengths.slice(run.first, index).reduce((sum, value) => sum + value, 0);
      if (Math.abs(run.songFrom + runLength - shot.songFrom) < JOIN) {
        run.last = index;
        return;
      }
    }
    runs.push({ songFrom: shot.songFrom, first: index, last: index });
  });
  return runs;
}
