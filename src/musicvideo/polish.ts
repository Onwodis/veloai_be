/**
 * The AI polish pass, run before stitching a music video (free, no AI calls):
 *
 *   Tempo     the mix's tracked analysis (beats that follow drift + real bar
 *             lines), moved onto the video timeline (minus the song start).
 *   Beat sync each cut between two locked scenes moves onto the nearest bar
 *             line (±0.35 s) or beat (±0.25 s). Cuts next to lip-synced shots
 *             never move, and cut points (not lengths) are snapped, so shifts
 *             never accumulate and the picture stays on the song's timeline.
 *   Transitions  scenes left on "AI decides": hard cut on the beat by default
 *             (how real videos are cut); dip to black on a big drop; one-beat
 *             crossfade only in slow, smooth passages. Never zoom / whip / flash.
 *   Flops     every locked take is checked with ffmpeg: mostly black, mostly
 *             frozen, or far shorter than its scene → flagged with the reason
 *             so it can be regenerated in one click.
 *
 * Only locked scenes take part. The report is saved on the project.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, ffmpegLog, probe } from '../media/ffmpeg.js';
import { downloadToFile } from '../services/storage.service.js';
import { json, sql } from '../studio/sql.js';
import type { SceneRow } from '../studio/types.js';
import type { Transition } from '../studio/cinema.js';
import { songContext } from './songmap.js';
import { syncPlan, type ShotSync, type SyncPlan } from './sync.js';

const RATE = 11025;
const HOP = 256;

export interface PolishReport {
  at: string;
  bpm: number | null;
  beatCount: number;
  scenes: number;
  snapped: { sceneId: string; position: number; from: number; to: number }[];
  transitions: { sceneId: string; position: number; transition: Transition; reason: string }[];
  flops: { sceneId: string; position: number; takeId: string; reason: string }[];
  totalSeconds: number;
  /** Song sync check: which slice of the song each shot plays; left-out parts. */
  sync?: {
    continuous: boolean;
    lipSyncShots: number;
    /** Lip-synced shots that keep the exact words their take was synced to. */
    lipSyncLocked: number;
    shots: Pick<ShotSync, 'sceneId' | 'position' | 'lipSync' | 'songFrom' | 'drift' | 'source' | 'note'>[];
    skipped: SyncPlan['skipped'];
  };
}

interface SongAnalysis {
  bpm: number | null;
  beats: number[];
  /** Bar starts (beat 1), from the tempo tracker. */
  downbeats: number[];
  /** Section starts (verse → chorus…), seconds. */
  sectionStarts: number[];
  /** RMS energy per 0.5 s window, normalised 0-1. */
  energy: number[];
}

/**
 * The song on the VIDEO timeline: the tracked analysis of the working mix
 * (beats that follow tempo drift, real downbeats), shifted by the song start so
 * beat times line up with scene cuts. Falls back to a fixed-grid estimate.
 */
async function songOnTimeline(projectId: string, songKey: string, dir: string): Promise<SongAnalysis> {
  const context = await songContext(projectId).catch(() => null);
  const analysis = context?.analysis;
  if (analysis && analysis.beats.length >= 8) {
    const shift = context.songStart;
    const onVideo = (times: number[]): number[] => times.map((time) => +(time - shift).toFixed(3)).filter((time) => time >= 0);
    // Energy windows are 0.5 s; drop the ones before the song start.
    const skip = Math.round(shift / 0.5);
    return {
      bpm: analysis.bpm,
      beats: onVideo(analysis.beats),
      downbeats: onVideo(analysis.downbeats ?? []),
      sectionStarts: onVideo(analysis.sections.slice(1).map((section) => section.start)),
      energy: analysis.energy.slice(skip),
    };
  }
  const fallback = await analyseSong(songKey, dir);
  return { ...fallback, downbeats: fallback.beats.filter((_, index) => index % 4 === 0), sectionStarts: [] };
}

async function analyseSong(songKey: string, dir: string): Promise<Omit<SongAnalysis, 'downbeats' | 'sectionStarts'>> {
  const song = join(dir, 'song');
  const pcm = join(dir, 'song.f32');
  await downloadToFile(songKey, song);
  await ffmpeg(['-i', song, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', pcm]);
  const buffer = await readFile(pcm);
  const data = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));

  const frames = Math.floor(data.length / HOP);
  const envelope = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let at = frame * HOP; at < (frame + 1) * HOP; at += 1) sum += data[at]! * data[at]!;
    envelope[frame] = Math.sqrt(sum / HOP);
  }
  const onset = new Float32Array(frames);
  for (let frame = 1; frame < frames; frame += 1) onset[frame] = Math.max(0, envelope[frame]! - envelope[frame - 1]!);

  // Energy curve (0.5 s windows) for transition choices.
  const window = Math.round((RATE * 0.5) / HOP);
  const energy: number[] = [];
  for (let frame = 0; frame < frames; frame += window) {
    let sum = 0;
    for (let at = frame; at < Math.min(frames, frame + window); at += 1) sum += envelope[at]!;
    energy.push(sum / window);
  }
  const top = Math.max(1e-6, ...energy);
  const normalised = energy.map((value) => value / top);

  const fps = RATE / HOP;
  let bestLag = 0;
  let best = 0;
  for (let lag = Math.floor((fps * 60) / 180); lag <= Math.ceil((fps * 60) / 70); lag += 1) {
    let sum = 0;
    for (let frame = lag; frame < frames; frame += 1) sum += onset[frame]! * onset[frame - lag]!;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  if (!bestLag) return { bpm: null, beats: [], energy: normalised };
  // Beat phase: the offset whose beat positions collect the most onset energy.
  let bestPhase = 0;
  let phaseScore = -1;
  for (let phase = 0; phase < bestLag; phase += 1) {
    let sum = 0;
    for (let frame = phase; frame < frames; frame += bestLag) sum += onset[frame]!;
    if (sum > phaseScore) {
      phaseScore = sum;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let frame = bestPhase; frame < frames; frame += bestLag) beats.push(+(frame / fps).toFixed(3));
  return { bpm: Math.round((fps * 60) / bestLag), beats, energy: normalised };
}

export async function checkTake(videoKey: string, expected: number, dir: string, name: string): Promise<string | null> {
  const file = join(dir, `${name}.mp4`);
  await downloadToFile(videoKey, file);
  const { durationSec } = await probe(file);
  if (durationSec < expected * 0.6) return `Only ${durationSec.toFixed(1)} s of footage for a ${expected} s scene`;
  const log = await ffmpegLog(['-i', file, '-vf', 'blackdetect=d=0.3:pix_th=0.08,freezedetect=n=0.003:d=0.8', '-an', '-f', 'null', '-']);
  const black = [...log.matchAll(/black_duration:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  const frozen = [...log.matchAll(/freeze_duration: ([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  if (black / durationSec > 0.4) return `${Math.round((black / durationSec) * 100)}% of the take is black`;
  if (frozen / durationSec > 0.5) return `${Math.round((frozen / durationSec) * 100)}% of the take is frozen (no motion)`;
  return null;
}

/**
 * What a real music-video editor would do at this cut. Hard cuts on the beat
 * are the default (that's how real videos are cut); blends are used sparingly
 * and only where the music itself blends. No zooms, whips or flashes from the
 * AI: those read as "AI cinematic" (the artist can still pick one by hand).
 */
function chooseTransition(before: number, after: number, bpm: number | null, intoSection: boolean): { transition: Transition; reason: string } {
  const delta = after - before;
  if (delta > 0.25) return { transition: 'cut', reason: `the song lifts ${Math.round(delta * 100)}%${intoSection ? ' into a new section' : ''}: hard cut on the downbeat` };
  if (delta < -0.3) return { transition: 'dip-black', reason: `the song drops ${Math.round(-delta * 100)}%: short dip to black, timed in beats` };
  if (bpm && bpm < 90 && Math.abs(delta) < 0.12) return { transition: 'crossfade', reason: `slow, smooth passage (${Math.round(bpm)} BPM): one-beat crossfade` };
  return { transition: 'cut', reason: intoSection ? 'section change: hard cut on the downbeat' : 'hard cut on the beat' };
}

/** Runs the polish pass for a music video and saves the report. */
export async function polishProject(projectId: string, songKey: string): Promise<PolishReport> {
  const dir = await mkdtemp(join(tmpdir(), 'mv-polish-'));
  try {
    const scenes = await sql<(SceneRow & { takeKey: string | null; transitionMode: string })[]>`
      SELECT s.*, t.video_key AS take_key FROM studio_scenes s
      LEFT JOIN studio_takes t ON t.id = s.selected_take_id AND t.status = 'READY'
      WHERE s.project_id = ${projectId} AND s.shot_approved_at IS NOT NULL ORDER BY s.position`;
    const song = await songOnTimeline(projectId, songKey, dir);
    const report: PolishReport = { at: new Date().toISOString(), bpm: song.bpm, beatCount: song.beats.length, scenes: scenes.length, snapped: [], transitions: [], flops: [], totalSeconds: 0 };

    // Beat sync: snap absolute cut points (never lengths, so nothing drifts).
    const cuts: number[] = [];
    let at = 0;
    for (const scene of scenes) {
      at += scene.durationSec;
      cuts.push(at);
    }
    const durations = scenes.map((scene) => scene.durationSec);
    for (let index = 0; index < scenes.length - 1; index += 1) {
      if (scenes[index]!.lipSync || scenes[index + 1]!.lipSync || !song.beats.length) continue;
      // A scene left out between them: the song jumps there, so there is no shared cut to move.
      if (scenes[index + 1]!.position !== scenes[index]!.position + 1) continue;
      const cut = cuts[index]!;
      const closest = (times: number[]): number | null => (times.length ? times.reduce((bestBeat, beat) => (Math.abs(beat - cut) < Math.abs(bestBeat - cut) ? beat : bestBeat), times[0]!) : null);
      // A bar line (beat 1) within ±0.35 s wins; otherwise the nearest beat within ±0.25 s.
      const bar = closest(song.downbeats);
      const beat = closest(song.beats);
      const nearest = bar !== null && Math.abs(bar - cut) <= 0.35 ? bar : beat;
      if (nearest === null || Math.abs(nearest - cut) > 0.35 || Math.abs(nearest - cut) < 1 / 48) continue;
      if (nearest !== bar && Math.abs(nearest - cut) > 0.25) continue;
      const shift = nearest - cut;
      if (durations[index]! + shift < 2 || durations[index + 1]! - shift < 2) continue;
      durations[index] = +(durations[index]! + shift).toFixed(3);
      durations[index + 1] = +(durations[index + 1]! - shift).toFixed(3);
      cuts[index] = nearest;
      report.snapped.push({ sceneId: scenes[index]!.id, position: scenes[index]!.position, from: +cut.toFixed(2), to: +nearest.toFixed(2) });
    }
    for (const [index, scene] of scenes.entries()) {
      if (durations[index] !== scene.durationSec) await sql`UPDATE studio_scenes SET duration_sec = ${durations[index]!} WHERE id = ${scene.id}`;
    }

    // AI transitions from the music at each cut.
    for (let index = 0; index < scenes.length - 1; index += 1) {
      const scene = scenes[index]!;
      if (scene.transitionMode !== 'AI') continue;
      const window = Math.floor(cuts[index]! / 0.5);
      const before = song.energy[Math.max(0, window - 2)] ?? 0.5;
      const after = song.energy[Math.min(song.energy.length - 1, window + 2)] ?? 0.5;
      const intoSection = song.sectionStarts.some((start) => Math.abs(start - cuts[index]!) <= 1.5);
      const pick = chooseTransition(before, after, song.bpm, intoSection);
      await sql`UPDATE studio_scenes SET transition = ${pick.transition} WHERE id = ${scene.id}`;
      report.transitions.push({ sceneId: scene.id, position: scene.position, ...pick });
    }

    // Flops: black, frozen or short takes.
    for (const [index, scene] of scenes.entries()) {
      if (!scene.takeKey || !scene.selectedTakeId) {
        report.flops.push({ sceneId: scene.id, position: scene.position, takeId: scene.selectedTakeId ?? '', reason: 'No finished take is picked' });
        continue;
      }
      const reason = await checkTake(scene.takeKey, durations[index]!, dir, `take-${index}`).catch(() => null);
      if (reason) report.flops.push({ sceneId: scene.id, position: scene.position, takeId: scene.selectedTakeId, reason });
    }
    report.totalSeconds = +durations.reduce((sum, value) => sum + value, 0).toFixed(2);

    // Song sync check (after the snaps were saved): every shot's slice of the song, lip sync first.
    const context = await songContext(projectId, { analyse: false }).catch(() => null);
    const plan = await syncPlan(projectId, songKey, context?.songStart ?? 0);
    report.sync = {
      continuous: plan.continuous,
      lipSyncShots: plan.shots.filter((shot) => shot.lipSync).length,
      lipSyncLocked: plan.shots.filter((shot) => shot.source === 'lip-sync take').length,
      shots: plan.shots.map((shot) => ({ sceneId: shot.sceneId, position: shot.position, lipSync: shot.lipSync, songFrom: shot.songFrom, drift: shot.drift, source: shot.source, note: shot.note })),
      skipped: plan.skipped,
    };
    await sql`UPDATE mv_projects SET polish = ${json(report)}, updated_at = now() WHERE project_id = ${projectId}`;
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
