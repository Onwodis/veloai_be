/**
 * Lip sync for music-video performance shots, in four steps:
 *
 *   1. vocalStem()     the acapella of the working mix, separated once per song
 *                      (fal demucs, WAV) and cached in R2 next to the song. Drums,
 *                      bass and pads never reach the lip-sync model, so they can't
 *                      flap the mouth on the beat.
 *   2. vocalSlice()    the stem under this shot, exactly as long as the rendered
 *                      base video, mono 48 kHz, silenced between sung lines.
 *   3. lipSyncInput()  request for sync v2 pro (`sync_mode`) or react-1
 *                      (`lipsync_mode` + emotion/temperature); always `cut_off`
 *                      for frame-exact timing (no looping / bouncing to fit).
 *   4. muxMaster()     the synced picture with the SAME slice of the full stereo
 *                      mix (-c:v copy, -map 0:v:0 -map 1:a:0 -shortest), so the
 *                      take plays the real song, not the acapella, with no drift.
 */
import { join } from 'node:path';
import { ffmpeg, ffmpegLog } from '../media/ffmpeg.js';
import { headObject, readUrl, uploadFile } from '../services/storage.service.js';
import { logger } from '../utils/logger.js';
import { downloadUrl } from './files.js';
import type { StudioModel } from './settings.js';

/** Submits (or resumes) a fal request for a take stage; saved per take, never paid twice. */
export type StageRunner = (stage: string, endpoint: string, input: Record<string, unknown>) => Promise<unknown>;

/** The stem lives beside the mix it came from: a new mix (DAW edit) gets its own stem. */
export const stemKey = (musicKey: string): string => `${musicKey}.vocals.wav`;

/** Takes of the same song rendering at once in this worker share one separation. */
const inflight = new Map<string, Promise<string>>();

/**
 * R2 key of the song's isolated vocal stem, separating it on first use. Returns
 * null when separation is switched off or fails; the caller then falls back
 * to band-passing the full mix, and says so in the take's engine line.
 */
export async function vocalStem(musicKey: string, model: StudioModel, run: StageRunner, workDir: string): Promise<{ key: string; reused: boolean } | null> {
  if (!model.enabled) return null;
  const key = stemKey(musicKey);
  if (await headObject(key).catch(() => null)) return { key, reused: true };

  const pending = inflight.get(key);
  if (pending) {
    const shared = await pending.catch(() => null);
    if (shared) return { key: shared, reused: true };
  }
  const job = (async () => {
    const result = (await run('VOCALS', model.endpoint, { ...model.extra, audio_url: await readUrl(musicKey) })) as { vocals?: { url?: string } };
    const url = result.vocals?.url;
    if (!url) throw new Error(`${model.endpoint} returned no vocals stem`);
    const file = join(workDir, 'vocals-stem.wav');
    await downloadUrl(url, file);
    await uploadFile(key, file, 'audio/wav');
    return key;
  })();
  inflight.set(key, job);
  try {
    return { key: await job, reused: false };
  } catch (error) {
    logger.warn({ err: error, musicKey }, 'vocal stem separation failed; lip sync falls back to the band-passed mix');
    return null;
  } finally {
    inflight.delete(key);
  }
}

/**
 * ffmpeg filter that mutes the lip-sync audio outside the sung lines (with a
 * little lead-in for the breath and a tail for the last syllable). Without
 * lyric timings, or when nothing is sung, nothing is muted.
 */
export function vocalGate(vocals: { start: number; end: number }[] | undefined, seconds: number): string {
  const spans = (vocals ?? [])
    .map((line) => ({ start: Math.max(0, line.start - 0.15), end: Math.min(seconds, line.end + 0.25) }))
    .filter((line) => line.end > line.start && line.start < seconds)
    .sort((a, b) => a.start - b.start);
  if (spans.length === 0) return '';
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    // Gaps under half a second are breaths inside a phrase: keep them open.
    if (last && span.start - last.end < 0.5) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  const sung = merged.map((span) => `between(t,${span.start.toFixed(2)},${span.end.toFixed(2)})`).join('+');
  return `volume=0:enable='not(${sung})'`;
}

/** Loudest sample of the filtered slice, dBFS (ffmpeg volumedetect). */
async function peakDb(input: { source: string; start: number; seconds: number; filters: string }): Promise<number> {
  const log = await ffmpegLog(['-ss', input.start.toFixed(3), '-t', input.seconds.toFixed(3), '-i', input.source, '-vn', '-ac', '1', '-af', `${input.filters},volumedetect`, '-f', 'null', '-']);
  const match = /max_volume:\s*(-?[\d.]+) dB/.exec(log);
  return match ? Number(match[1]) : 0;
}

/**
 * The audio the lip-sync model hears: [start, start + seconds) of `source`, padded
 * with silence to exactly `seconds` (the base video's real length, so cut_off never
 * trims a word or leaves frames without audio). Written as 16-bit WAV: AAC adds
 * ~20-45 ms of encoder priming that some models play as silence, so every mouth
 * shape would land late.
 *
 *  - isolated stem: rumble cut → peak-normalised to -1 dBFS (a quiet stem gives a
 *    timid mouth) → gate driven by the voice itself, sample-exact, so word onsets
 *    are never clipped and reverb tails between phrases don't keep the mouth moving
 *    → gentle downward expansion, so stressed syllables stand out from the rest and
 *    the mouth opens wider on them.
 *  - full mix (fallback, no stem): vocal band, tamed low end, evened-out level, and
 *    the lyric-timed gate (here the drums would otherwise move the mouth).
 */
export async function vocalSlice(input: {
  source: string;
  isolated: boolean;
  start: number;
  seconds: number;
  vocals?: { start: number; end: number }[] | undefined;
  out: string;
  /** Soft passage (hum, low chorus, cool line): no loudness push, no emphasis, so the mouth stays small. */
  soft?: boolean | undefined;
}): Promise<void> {
  let filters: string;
  if (input.isolated) {
    const base = 'highpass=f=70';
    // Soft passages peak at -10 dBFS (a hum boosted to -1 dB reads as belting to the lip-sync model).
    const target = input.soft ? -10 : -1;
    const gain = Math.max(-6, Math.min(input.soft ? 12 : 30, target - (await peakDb({ ...input, filters: base }))));
    filters = [
      base,
      `volume=${gain.toFixed(1)}dB`,
      // Open fast (2 ms) on the consonant, close after 150 ms; between phrases -24 dB, not silence.
      'agate=threshold=0.02:ratio=4:attack=2:release=150:range=0.06',
      // Quiet → quieter (-45 dB in → -53 out), loud unchanged: emphasis on the stressed words.
      // Soft: no extra emphasis, and the peaks are rounded off so no syllable pops the jaw open.
      input.soft ? 'acompressor=threshold=-20dB:ratio=3:attack=5:release=120' : 'compand=attacks=0.003:decays=0.12:points=-90/-90|-45/-53|-24/-25|0/0',
      'apad',
    ].join(',');
  } else {
    filters = ['highpass=f=160,lowpass=f=5500,acompressor=threshold=-22dB:ratio=3:attack=5:release=80,dynaudnorm=f=150:g=7', vocalGate(input.vocals, input.seconds), 'apad']
      .filter(Boolean)
      .join(',');
  }
  await ffmpeg([
    '-ss', input.start.toFixed(3),
    '-t', input.seconds.toFixed(3),
    '-i', input.source,
    '-vn',
    '-ac', '1',
    '-af', filters,
    '-t', input.seconds.toFixed(3),
    '-ar', '48000',
    '-c:a', 'pcm_s16le',
    input.out,
  ]);
}

const REACT_EMOTIONS = ['happy', 'sad', 'angry', 'disgusted', 'surprised', 'neutral'] as const;
type ReactEmotion = (typeof REACT_EMOTIONS)[number];

/**
 * react-1 takes six single-word emotions; the scene's delivery (cinema.ts
 * PERFORMANCE_EMOTIONS) and common direction words map onto them. Tender maps to
 * happy (a warm, soft face), not sad: intensity 1 keeps it gentle.
 */
const EMOTION_ALIASES: Record<string, ReactEmotion> = {
  confident: 'happy',
  joyful: 'happy',
  excited: 'happy',
  playful: 'happy',
  proud: 'happy',
  tender: 'happy',
  heartbroken: 'sad',
  melancholy: 'sad',
  longing: 'sad',
  aggressive: 'angry',
  fierce: 'angry',
  defiant: 'angry',
  intense: 'angry',
  shocked: 'surprised',
  calm: 'neutral',
  cool: 'neutral',
};

/** Scene intensity 1-3 → react-1 temperature (how much the face moves). */
export const intensityTemperature = (intensity: number | null | undefined): number => ({ 1: 0.35, 2: 0.55, 3: 0.75 })[Math.min(3, Math.max(1, Math.round(intensity ?? 2))) as 1 | 2 | 3];

export function reactEmotion(value: unknown): ReactEmotion {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((REACT_EMOTIONS as readonly string[]).includes(word)) return word as ReactEmotion;
  return EMOTION_ALIASES[word] ?? 'neutral';
}

export const isReactLipSync = (endpoint: string): boolean => /\/react-1\b/.test(endpoint);

/** react-1 rejects video or audio over 15 s. */
export const REACT_MAX_SECONDS = 15;

/**
 * Request body for the lip-sync endpoint. Timing is always cut_off: the audio is
 * already exactly the video's length, and loop/bounce/remap would shift words.
 */
export function lipSyncInput(
  model: StudioModel,
  videoUrl: string,
  audioUrl: string,
  performance?: { emotion: string | null; intensity: number } | undefined,
  /** Soft passage: the face moves little (sung under the breath / hummed). */
  soft = false,
): Record<string, unknown> {
  const { sync_mode: _sync, lipsync_mode: _lipsync, ...extra } = model.extra as Record<string, unknown>;
  if (isReactLipSync(model.endpoint)) {
    // The admin's extra wins when set; otherwise the scene's direction decides (soft passages stay small).
    const raw = extra['temperature'];
    const temperature = typeof raw === 'number' ? Math.min(1, Math.max(0, raw)) : soft ? 0.2 : intensityTemperature(performance?.intensity);
    return {
      model_mode: 'face',
      ...extra,
      emotion: reactEmotion(extra['emotion'] ?? performance?.emotion),
      temperature,
      video_url: videoUrl,
      audio_url: audioUrl,
      lipsync_mode: 'cut_off',
    };
  }
  return { ...extra, video_url: videoUrl, audio_url: audioUrl, sync_mode: 'cut_off' };
}

/**
 * Final picture + the mastered stereo mix under it. The video stream is copied
 * untouched; the song slice starts at the shot's place in the mix, and
 * -shortest ends both together, so there is no audio drift.
 */
export async function muxMaster(input: { video: string; song: string; start: number; seconds: number; out: string }): Promise<void> {
  await ffmpeg([
    '-i', input.video,
    '-ss', input.start.toFixed(3),
    '-t', input.seconds.toFixed(3),
    '-i', input.song,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '256k',
    '-ar', '48000',
    '-shortest',
    '-movflags', '+faststart',
    input.out,
  ]);
}
