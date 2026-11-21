/**
 * Speech-to-text with word-level timestamps.
 *
 * Engine: any OpenAI-compatible `POST /audio/transcriptions` endpoint that
 * supports `response_format=verbose_json` + `timestamp_granularities[]=word`
 * (OpenAI Whisper `whisper-1`, Groq `whisper-large-v3-turbo`, …). Which key
 * and model run is chosen by the super admin on the Models page
 * (services/ai.service.ts); .env keys appear there as "From .env".
 *
 * Audio is extracted as 16 kHz mono MP3 (speech-optimised, ~0.5 MB/min) and
 * split into 20-minute chunks so each request stays under the 25 MB limit;
 * chunk word times are shifted onto one timeline.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedEngine } from '../services/ai.service.js';
import { reportAiError } from '../services/aiAlerts.js';
import { ffmpeg, mediaDuration } from './ffmpeg.js';

export interface Word {
  /** text */
  w: string;
  /** start seconds */
  s: number;
  /** end seconds */
  e: number;
}

export interface Transcript {
  words: Word[];
  text: string;
  language: string | null;
  audioSeconds: number;
  engine: string;
}

const CHUNK_SECONDS = 20 * 60;

/** Extracts speech-optimised audio and returns chunk files in order. */
export async function extractAudio(source: string, workDir: string): Promise<{ chunks: string[]; audioFile: string }> {
  const audioFile = join(workDir, 'audio.mp3');
  await ffmpeg(['-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-af', 'highpass=f=60,lowpass=f=8000', audioFile]);
  const durationSec = await mediaDuration(audioFile).catch(() => 0);
  if (durationSec <= CHUNK_SECONDS) return { chunks: [audioFile], audioFile };
  await ffmpeg(['-i', audioFile, '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-c', 'copy', join(workDir, 'chunk_%03d.mp3')]);
  const chunks = (await readdir(workDir)).filter((name) => /^chunk_\d{3}\.mp3$/.test(name)).sort().map((name) => join(workDir, name));
  return { chunks, audioFile };
}

interface VerboseJson {
  text?: string;
  language?: string;
  duration?: number;
  words?: { word: string; start: number; end: number }[];
  segments?: { start: number; end: number; text: string }[];
}

async function transcribeChunk(file: string, engine: ResolvedEngine, signal?: AbortSignal, prompt?: string): Promise<VerboseJson> {
  const form = new FormData();
  form.append('file', new Blob([await readFile(file)], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', engine.model);
  // Whisper-style engines copy the vocabulary and spelling of the prompt (pidgin, slang, names).
  if (prompt?.trim()) form.append('prompt', prompt.trim().slice(-800));
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${engine.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${engine.apiKey}` },
        body: form,
        signal: signal ?? AbortSignal.timeout(10 * 60_000),
      });
      if (response.status === 429 || response.status >= 500) throw new Error(`Transcription HTTP ${response.status}`);
      if (!response.ok) throw Object.assign(new Error(`Transcription failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`), { fatal: true });
      return (await response.json()) as VerboseJson;
    } catch (error) {
      if ((error as { fatal?: boolean }).fatal) {
        reportAiError({ service: 'Transcription', endpoint: engine.model, error: (error as Error).message, where: 'transcribing audio' });
        throw error;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  reportAiError({ service: 'Transcription', endpoint: engine.model, error: (lastError as Error)?.message ?? 'failed after 3 tries', where: 'transcribing audio' });
  throw lastError;
}

export async function transcribe(chunks: string[], engine: ResolvedEngine | null, signal?: AbortSignal, prompt?: string): Promise<Transcript> {
  if (!engine) {
    throw new Error('No transcription engine is set. A super admin can add an OpenAI or Groq key on the Models page (or set TRANSCRIPTION_API_KEY in the API .env).');
  }
  const words: Word[] = [];
  let offset = 0;
  let language: string | null = null;
  const texts: string[] = [];
  for (const chunk of chunks) {
    const result = await transcribeChunk(chunk, engine, signal, prompt);
    language ??= result.language ?? null;
    texts.push(result.text?.trim() ?? '');
    if (result.words?.length) {
      for (const word of result.words) words.push({ w: word.word.trim(), s: +(word.start + offset).toFixed(2), e: +(word.end + offset).toFixed(2) });
    } else {
      // Engines without word timing: spread each segment's words evenly.
      for (const segment of result.segments ?? []) {
        const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
        const step = (segment.end - segment.start) / Math.max(1, tokens.length);
        tokens.forEach((token, index) => words.push({ w: token, s: +(segment.start + offset + index * step).toFixed(2), e: +(segment.start + offset + (index + 1) * step).toFixed(2) }));
      }
    }
    offset += result.duration ?? (await mediaDuration(chunk));
  }
  return { words: words.filter((word) => word.w.length > 0), text: texts.join(' ').trim(), language, audioSeconds: offset, engine: engine.label };
}
