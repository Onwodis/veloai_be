/**
 * FFmpeg / FFprobe runner. Uses the binaries bundled by `ffmpeg-static` and
 * `ffprobe-static`, so the API needs no system install. Override with
 * FFMPEG_PATH / FFPROBE_PATH to use a system build (e.g. one with NVENC).
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export const FFMPEG = process.env['FFMPEG_PATH'] ?? (ffmpegStatic as unknown as string | null) ?? 'ffmpeg';
export const FFPROBE = process.env['FFPROBE_PATH'] ?? ffprobeStatic.path ?? 'ffprobe';

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

interface RunOptions {
  cwd?: string;
  /** Called with seconds of output processed, parsed from `-progress`. */
  onProgress?: (seconds: number) => void;
  signal?: AbortSignal;
}

function run(binary: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, windowsHide: true, signal: options.signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onProgress) {
        const match = /out_time_ms=(\d+)/g.exec(text);
        if (match?.[1]) options.onProgress(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new FfmpegError(`${binary.split(/[\\/]/).pop()} exited with code ${code}`, stderr.slice(-1500)));
    });
  });
}

/** Runs ffmpeg and returns its log (stderr): analysis filters such as blackdetect / freezedetect report there. */
export function ffmpegLog(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-200_000);
    });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr.slice(-1500)))));
  });
}

export function ffmpeg(args: string[], options?: RunOptions): Promise<string> {
  return run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...(options?.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args], options);
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string | null;
  rotation: number;
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const data = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
  };
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  if (!video) throw new FfmpegError('No video stream found in the upload', '');
  const rotation = Math.abs(Number(video.tags?.rotate ?? video.side_data_list?.find((side) => side.rotation !== undefined)?.rotation ?? 0)) % 180;
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  return {
    durationSec: Number(data.format?.duration ?? video.duration ?? 0),
    // Phone videos are often stored landscape with a 90° rotation flag.
    width: rotation === 90 ? height : width,
    height: rotation === 90 ? width : height,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? null,
    rotation,
  };
}

let subtitleSupport: Promise<boolean> | null = null;
/** True when this ffmpeg build can burn subtitles (libass). Checked once. */
export function canBurnSubtitles(probeFile: string): Promise<boolean> {
  subtitleSupport ??= run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2', '-vf', `subtitles=${filterPath(probeFile)}`, '-f', 'null', '-'])
    .then(() => true)
    .catch(() => false);
  return subtitleSupport;
}

/** A file path quoted for use inside an ffmpeg filter graph (Windows drive colons escaped). */
export const filterPath = (file: string): string => `'${file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;

/**
 * The app's bundled fonts (data/fonts: Montserrat, Bebas Neue, Cinzel… see media/textfx.ts). The
 * runtime image has only DejaVu and Noto installed, so a title asking for any other family would
 * silently fall back; libass is pointed at this folder instead (works in dev and in Docker alike).
 */
export const FONTS_DIR = resolve(process.cwd(), 'data/fonts');

/** The `subtitles` filter for an .ass file, with the bundled fonts available to it. */
export const subtitlesFilter = (assFile: string): string => `subtitles=${filterPath(assFile)}:fontsdir=${filterPath(FONTS_DIR)}`;

/** Duration of any media file (audio-only included: no video stream needed). */
export async function mediaDuration(file: string): Promise<number> {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const data = JSON.parse(out) as { format?: { duration?: string }; streams?: { duration?: string }[] };
  const duration = Number(data.format?.duration ?? data.streams?.find((stream) => stream.duration)?.duration ?? 0);
  return Number.isFinite(duration) ? duration : 0;
}

export async function versions(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const [ff, fp] = await Promise.all([run(FFMPEG, ['-version']).catch(() => ''), run(FFPROBE, ['-version']).catch(() => '')]);
  const first = (text: string): string =>
    text
      .split('\n')[0]
      ?.replace(/ Copyright.*/, '')
      .trim() || 'not found';
  return { ffmpeg: first(ff), ffprobe: first(fp) };
}
