/**
 * Server-side music analysis for the storyboard editor. The browser never has
 * to download and decode the song (the storage bucket doesn't allow that
 * cross-origin), so the waveform is always the real one.
 *
 *   waveform   1600 min/max peak pairs (mono mix)
 *   tempo      tracked beats, downbeats (bars), per-bar tempo map (see tempo())
 *   key        chroma (FFT → pitch classes) correlated with the
 *              Krumhansl-Schmuckler major/minor profiles, with confidence
 *   loudness   EBU R128 via ffmpeg loudnorm: integrated LUFS, true peak
 *              (dBTP), loudness range (LU); plus sample peak / RMS (dBFS)
 *   sections   energy-based segmentation, labelled intro / verse / chorus /
 *              bridge / outro by position and loudness
 *
 * Results are cached per audio asset (mv_projects.audio_analysis).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, ffmpegLog } from '../media/ffmpeg.js';
import { downloadToFile } from '../services/storage.service.js';

const RATE = 11025;
/** Waveform resolution: enough detail to stay sharp at 4× zoom on a 5-minute song. */
const PEAKS = 8000;
/** Bump when the analysis format changes so cached results are recomputed. */
export const ANALYSIS_VERSION = 3;

export interface AudioAnalysis {
  version?: number;
  duration: number;
  peaks: [number, number][];
  bpm: number | null;
  /** Tracked beats (follow tempo drift), seconds. */
  beats: number[];
  /** Bar starts (beat 1 of each bar), seconds. */
  downbeats: number[];
  /** Local tempo per bar, like a DAW tempo track. */
  tempoMap: { time: number; bpm: number }[];
  /** True when the tempo holds within ±4% (a click-track song); false = live / drifting. */
  steady: boolean;
  /** Beats per bar (4/4 assumed). */
  meter: number;
  key: { tonic: string; mode: 'major' | 'minor'; label: string; camelot: string; confidence: number } | null;
  loudness: { integrated: number | null; truePeak: number | null; lra: number | null; samplePeakDb: number; rmsDb: number };
  /** RMS per 0.5 s, 0-1 (for the energy curve). */
  energy: number[];
  sections: { start: number; end: number; label: string; energy: number }[];
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Camelot wheel codes (DJ mixing notation).
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

const db = (value: number): number => (value > 0 ? +(20 * Math.log10(value)).toFixed(1) : -96);

/** In-place radix-2 FFT (re, im of length 2^n). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

function correlate(a: number[], b: number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let i = 0; i < a.length; i += 1) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    dbb += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * dbb || 1);
}

function detectKey(data: Float32Array): AudioAnalysis['key'] {
  const size = 4096;
  const chroma = new Array<number>(12).fill(0);
  const window = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  // ~1 frame per second is plenty for a song-level key.
  for (let start = 0; start + size < data.length; start += RATE) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i += 1) re[i] = data[start + i]! * window[i]!;
    fft(re, im);
    for (let bin = 1; bin < size / 2; bin += 1) {
      const freq = (bin * RATE) / size;
      if (freq < 55 || freq > 2000) continue;
      const pitch = Math.round(12 * Math.log2(freq / 440)) + 69;
      chroma[((pitch % 12) + 12) % 12]! += Math.hypot(re[bin]!, im[bin]!);
    }
  }
  if (chroma.every((value) => value === 0)) return null;
  let best = { score: -2, tonic: 0, mode: 'major' as 'major' | 'minor' };
  const scores: number[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const rotated = chroma.slice(tonic).concat(chroma.slice(0, tonic));
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const score = correlate(rotated, profile);
      scores.push(score);
      if (score > best.score) best = { score, tonic, mode };
    }
  }
  const sorted = [...scores].sort((a, b) => b - a);
  const confidence = Math.max(0, Math.min(1, (sorted[0]! - sorted[1]!) * 5 + sorted[0]! * 0.5));
  const tonic = NOTES[best.tonic]!;
  return { tonic, mode: best.mode, label: `${tonic} ${best.mode}`, camelot: (best.mode === 'major' ? CAMELOT_MAJOR : CAMELOT_MINOR)[best.tonic]!, confidence: +confidence.toFixed(2) };
}

type Tempo = Pick<AudioAnalysis, 'bpm' | 'beats' | 'downbeats' | 'tempoMap' | 'steady' | 'meter'>;

/**
 * Tempo tracking (what Cubase's tempo detection does): beats that FOLLOW the
 * song, not a fixed grid laid over it.
 *
 *   1. onset strength: log-compressed energy rise per 23 ms frame
 *   2. global tempo: onset autocorrelation weighted toward ~120 BPM
 *      (log-Gaussian prior) so half / double tempo errors lose
 *   3. beats: dynamic programming (Ellis 2007): each beat = strong onset +
 *      the best previous beat about one period back, penalising tempo jumps;
 *      backtracked from the best ending, so the grid bends with live drift
 *   4. downbeats (bar 1s, 4/4): of the 4 phases, the one whose beats carry the
 *      most energy
 *   5. tempo map: local BPM per bar (median of its beat gaps)
 */
export function tempo(data: Float32Array): Tempo {
  const empty: Tempo = { bpm: null, beats: [], downbeats: [], tempoMap: [], steady: false, meter: 4 };
  const hop = 256;
  const frames = Math.floor(data.length / hop);
  if (frames < 64) return empty;
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i += 1) sum += data[i]! * data[i]!;
    env[f] = Math.log1p(1000 * Math.sqrt(sum / hop));
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f += 1) onset[f] = Math.max(0, env[f]! - env[f - 1]!);
  // Normalise so the DP weights mean the same thing on every song.
  let mean = 0;
  for (let f = 0; f < frames; f += 1) mean += onset[f]!;
  mean /= frames;
  let variance = 0;
  for (let f = 0; f < frames; f += 1) variance += (onset[f]! - mean) ** 2;
  const sd = Math.sqrt(variance / frames) || 1;
  for (let f = 0; f < frames; f += 1) onset[f] = onset[f]! / sd;

  const fps = RATE / hop;
  const minLag = Math.floor((fps * 60) / 220);
  const maxLag = Math.ceil((fps * 60) / 50);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag += 1) {
    let sum = 0;
    for (let f = lag; f < frames; f += 1) sum += onset[f]! * onset[f - lag]!;
    ac[lag] = sum / (frames - lag);
  }
  // A peak tolerates a little drift: take the best value within ±3% of the lag.
  const around = (lag: number): number => {
    let value = 0;
    const spread = Math.max(1, Math.round(lag * 0.03));
    for (let l = Math.max(minLag, Math.round(lag) - spread); l <= Math.min(maxLag + 1, Math.round(lag) + spread); l += 1) value = Math.max(value, ac[l]!);
    return value;
  };
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const prior = Math.exp(-0.5 * (Math.log2((fps * 60) / lag / 115) / 0.9) ** 2);
    if (ac[lag]! * prior > best) {
      best = ac[lag]! * prior;
      bestLag = lag;
    }
  }
  if (!bestLag || best <= 0) return empty;
  // Octave check: half / double tempo are the classic errors (off-beat hats, half-time trap).
  // Prefer a candidate in the 78-160 BPM range when its periodicity is nearly as strong.
  const inRange = (lag: number): boolean => {
    const bpm = (fps * 60) / lag;
    return bpm >= 78 && bpm <= 160;
  };
  if (!inRange(bestLag)) {
    const candidates = [bestLag * 2, bestLag / 2].filter((lag) => lag >= minLag && lag <= maxLag && inRange(lag));
    const strongest = candidates.sort((a, b) => around(b) - around(a))[0];
    if (strongest && around(strongest) >= 0.45 * around(bestLag)) bestLag = Math.round(strongest);
  }

  // Dynamic-programming beat tracker.
  const period = bestLag;
  const tightness = 100;
  const score = new Float32Array(frames);
  const back = new Int32Array(frames).fill(-1);
  for (let t = 0; t < frames; t += 1) {
    let bestPrev = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    const from = Math.max(0, t - Math.round(2 * period));
    const to = t - Math.round(period / 2);
    for (let prev = from; prev <= to; prev += 1) {
      const value = score[prev]! - tightness * Math.log((t - prev) / period) ** 2;
      if (value > bestValue) {
        bestValue = value;
        bestPrev = prev;
      }
    }
    score[t] = onset[t]! + (bestPrev >= 0 ? Math.max(0, bestValue) : 0);
    back[t] = bestValue > 0 ? bestPrev : -1;
  }
  // Best ending in the last period, then walk back.
  let end = frames - 1;
  for (let t = Math.max(0, frames - period); t < frames; t += 1) if (score[t]! > score[end]!) end = t;
  const frameBeats: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) {
    frameBeats.push(t);
    if (back[t]! < 0) break;
  }
  frameBeats.reverse();
  if (frameBeats.length < 8) return empty;
  const beats = frameBeats.map((f) => +(f / fps).toFixed(3));

  // Downbeats: the phase (of 4) whose beats carry the most energy.
  let phase = 0;
  let phaseBest = -1;
  for (let p = 0; p < 4; p += 1) {
    let sum = 0;
    for (let i = p; i < frameBeats.length; i += 4) sum += env[frameBeats[i]!]! + onset[frameBeats[i]!]!;
    if (sum > phaseBest) {
      phaseBest = sum;
      phase = p;
    }
  }
  const downbeats = beats.filter((_, index) => index >= phase && (index - phase) % 4 === 0);

  // Tempo map: local BPM per bar.
  const gaps = beats.slice(1).map((beat, index) => beat - beats[index]!);
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  // Measured over a whole bar (4 gaps): single gaps are quantised to the 23 ms frame.
  const tempoMap: Tempo['tempoMap'] = [];
  for (let i = phase; i + 4 < beats.length; i += 4) {
    const gap = (beats[i + 4]! - beats[i]!) / 4;
    if (gap > 0) tempoMap.push({ time: beats[i]!, bpm: Math.round((60 / gap) * 10) / 10 });
  }
  const barGap = median(tempoMap.map((bar) => 60 / bar.bpm)) || median(gaps);
  const spread = gaps.length ? Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - barGap) ** 2, 0) / gaps.length) / barGap : 1;
  const barSpread = tempoMap.length ? Math.max(...tempoMap.map((bar) => Math.abs(60 / bar.bpm - barGap) / barGap)) : 1;
  return { bpm: Math.round((60 / barGap) * 10) / 10, beats, downbeats, tempoMap, steady: spread < 0.08 && barSpread < 0.04, meter: 4 };
}

function segment(energy: number[], duration: number): AudioAnalysis['sections'] {
  // Smooth over ~8 s, then cut where the smoothed energy crosses its median band.
  const smooth = energy.map((_, i) => {
    const from = Math.max(0, i - 8);
    const to = Math.min(energy.length, i + 8);
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += energy[j]!;
    return sum / (to - from);
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const high = sorted[Math.floor(sorted.length * 0.66)] ?? 0.6;
  const low = sorted[Math.floor(sorted.length * 0.33)] ?? 0.3;
  const level = (value: number): number => (value >= high ? 2 : value <= low ? 0 : 1);
  const raw: { start: number; end: number; level: number; energy: number }[] = [];
  for (let i = 0; i < smooth.length; i += 1) {
    const current = level(smooth[i]!);
    const last = raw.at(-1);
    if (last && last.level === current) {
      last.end = (i + 1) * 0.5;
      last.energy = Math.max(last.energy, smooth[i]!);
    } else raw.push({ start: i * 0.5, end: (i + 1) * 0.5, level: current, energy: smooth[i]! });
  }
  // Merge sections shorter than 8 s into their neighbour.
  const merged: typeof raw = [];
  for (const part of raw) {
    const last = merged.at(-1);
    if (last && part.end - part.start < 8) {
      last.end = part.end;
      last.energy = Math.max(last.energy, part.energy);
    } else merged.push({ ...part });
  }
  return merged.map((part, index) => {
    const label =
      index === 0 && part.level < 2 ? 'Intro' : index === merged.length - 1 && part.level < 2 ? 'Outro' : part.level === 2 ? 'Chorus / hook' : part.level === 0 ? (index > merged.length / 2 ? 'Bridge' : 'Breakdown') : 'Verse';
    // NaN energy (silent/normalised-by-zero audio) would be stored as JSON null.
    const energy = Number.isFinite(part.energy) ? part.energy : 0.5;
    return { start: +part.start.toFixed(2), end: +Math.min(duration, part.end).toFixed(2), label, energy: +energy.toFixed(2) };
  });
}

export async function analyseAudio(key: string): Promise<AudioAnalysis> {
  const dir = await mkdtemp(join(tmpdir(), 'mv-analysis-'));
  try {
    const source = join(dir, 'song');
    const pcm = join(dir, 'song.f32');
    await downloadToFile(key, source);
    await ffmpeg(['-i', source, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', pcm]);
    const buffer = await readFile(pcm);
    const data = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
    const duration = data.length / RATE;

    const block = Math.max(1, Math.floor(data.length / PEAKS));
    const peaks: [number, number][] = [];
    let samplePeak = 0;
    let squares = 0;
    for (let bar = 0; bar < PEAKS; bar += 1) {
      let min = 0;
      let max = 0;
      for (let i = bar * block; i < Math.min(data.length, (bar + 1) * block); i += 1) {
        const value = data[i]!;
        if (value < min) min = value;
        if (value > max) max = value;
        squares += value * value;
      }
      samplePeak = Math.max(samplePeak, max, -min);
      peaks.push([+min.toFixed(4), +max.toFixed(4)]);
    }
    const energy: number[] = [];
    const window = RATE / 2;
    for (let start = 0; start < data.length; start += window) {
      let sum = 0;
      const end = Math.min(data.length, start + window);
      for (let i = start; i < end; i += 4) sum += data[i]! * data[i]!;
      energy.push(Math.sqrt(sum / Math.max(1, (end - start) / 4)));
    }
    const top = Math.max(1e-6, ...energy);
    const normalised = energy.map((value) => +(value / top).toFixed(3));

    // EBU R128 loudness on the full-quality file.
    let integrated: number | null = null;
    let truePeak: number | null = null;
    let lra: number | null = null;
    try {
      const log = await ffmpegLog(['-i', source, '-vn', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
      const jsonText = log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1);
      const stats = JSON.parse(jsonText) as { input_i: string; input_tp: string; input_lra: string };
      integrated = Number(stats.input_i);
      truePeak = Number(stats.input_tp);
      lra = Number(stats.input_lra);
    } catch {
      // Loudness is optional; the rest of the analysis still stands.
    }

    const rhythm = tempo(data);
    return {
      version: ANALYSIS_VERSION,
      duration: +duration.toFixed(3),
      peaks,
      ...rhythm,
      key: detectKey(data),
      loudness: { integrated, truePeak, lra, samplePeakDb: db(samplePeak), rmsDb: db(Math.sqrt(squares / Math.max(1, data.length))) },
      energy: normalised,
      sections: segment(normalised, duration),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
