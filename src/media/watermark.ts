/**
 * The platform watermark: the VideoSmith AI wordmark, bottom-right, about a
 * sixth of the frame wide, semi-transparent, on every video the platform
 * renders, until the project's owner pays to remove it (studio_projects.
 * watermark_removed_at). Re-renders after that are clean.
 *
 * The logo ships with the API in data/brand/watermark.png (light wordmark on
 * transparent, readable over footage).
 */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../studio/sql.js';
import { ffmpeg } from './ffmpeg.js';

export const WATERMARK_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'brand', 'watermark.png');

let available: boolean | null = null;

/** Whether the logo file is present (a missing file never fails a render). */
export async function watermarkAvailable(): Promise<boolean> {
  if (available === null) available = await access(WATERMARK_FILE).then(() => true, () => false);
  return available;
}

/** True unless the super admin switched watermarking off, or the project's watermark was paid off. */
export async function projectWatermarked(projectId: string): Promise<boolean> {
  const { getWatermarkSettings } = await import('../billing/watermarkRemoval.js');
  if (!(await getWatermarkSettings()).enabled) return false;
  const [row] = await sql<{ watermarkRemovedAt: Date | null }[]>`SELECT watermark_removed_at FROM studio_projects WHERE id = ${projectId}`;
  return !row?.watermarkRemovedAt;
}

/**
 * Stamps a finished file in place of a render that has no filter graph of its
 * own (engine-made images and clips). Video: re-encoded at near-lossless
 * quality, audio copied. Image: written as PNG. Returns the stamped file, or
 * the input untouched when the logo is missing or stamping fails (a creation
 * is never lost to its watermark).
 */
export async function stampFile(input: string, output: string, kind: 'video' | 'image', size: { width: number; height: number }): Promise<string> {
  if (!(await watermarkAvailable())) return input;
  const mark = watermarkFilters('[0:v]', 1, size, 'out');
  try {
    if (kind === 'video') {
      await ffmpeg(['-i', input, '-loop', '1', '-i', WATERMARK_FILE, '-filter_complex', mark.graph.join(';'), '-map', mark.label, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', output]);
    } else {
      const graph = [mark.graph[0], `[0:v][wm_logo]overlay=x=W-w-${Math.round(Math.min(size.width, size.height) * 0.035)}:y=H-h-${Math.round(Math.min(size.width, size.height) * 0.035)}:format=auto[out]`];
      await ffmpeg(['-i', input, '-i', WATERMARK_FILE, '-filter_complex', graph.join(';'), '-map', '[out]', '-frames:v', '1', output]);
    }
    return output;
  } catch {
    return input;
  }
}

/**
 * filter_complex pieces that lay the logo over `videoLabel`. `logoInput` is
 * the ffmpeg input index of WATERMARK_FILE (added with `-loop 1 -i`).
 * Returns the label of the watermarked stream.
 */
export function watermarkFilters(videoLabel: string, logoInput: number, size: { width: number; height: number }, out = 'wm_out'): { graph: string[]; label: string } {
  const logoWidth = Math.round(Math.min(size.width, size.height * 1.4) * 0.17);
  const margin = Math.round(Math.min(size.width, size.height) * 0.035);
  return {
    graph: [
      `[${logoInput}:v]scale=${logoWidth}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=0.6[wm_logo]`,
      `${videoLabel}[wm_logo]overlay=x=W-w-${margin}:y=H-h-${margin}:shortest=1:format=auto,format=yuv420p[${out}]`,
    ],
    label: `[${out}]`,
  };
}
