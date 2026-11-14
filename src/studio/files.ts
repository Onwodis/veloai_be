/** Small file helpers for studio jobs. */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ffmpeg } from '../media/ffmpeg.js';

const RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000];

/**
 * Streams a URL (fal.ai output CDN) to disk, retrying through slow or flaky
 * networks (connect timeouts, resets, 5xx): 5 attempts over about 40 s.
 * A generated file has already been paid for, so it is worth waiting for.
 */
export async function downloadUrl(url: string, filePath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (response.status >= 500 || response.status === 429) throw new Error(`HTTP ${response.status}`);
      if (!response.ok || !response.body) throw Object.assign(new Error(`Download failed (HTTP ${response.status}) for a generated file`), { fatal: true });
      await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(filePath));
      return;
    } catch (error) {
      if ((error as { fatal?: boolean }).fatal) throw error;
      lastError = error;
      if (attempt < RETRY_DELAYS.length) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
  throw Object.assign(new Error(`Couldn't download the generated file from fal.ai (${(lastError as Error)?.message ?? 'network error'}). It is saved: press Resume, fal.ai is not charged again.`), {
    resumable: true,
  });
}

/** Scales an image to cover width×height and centre-crops it (lanczos), as PNG. */
export async function conformImage(input: string, output: string, width: number, height: number): Promise<void> {
  await ffmpeg(['-i', input, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`, '-frames:v', '1', output]);
}

/** JPEG poster from ~1 s into a clip (or the first frame of shorter clips). */
export async function thumbnail(video: string, output: string, at = 1): Promise<void> {
  await ffmpeg(['-ss', String(at), '-i', video, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', output]).catch(() =>
    ffmpeg(['-i', video, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', output]),
  );
}
