/**
 * Audio quality report for an uploaded song (the "is this file good enough to
 * master a video on?" check), computed once per file and stored in the
 * asset's meta.
 *
 *   format    codec, lossless or lossy, bitrate, sample rate, bit depth, channels
 *   signal    sample peak, clipped samples, DC offset, noise floor, crest factor
 *             (ffmpeg astats on the full-resolution stereo signal)
 *   stereo    width from a mid / side split (side vs mid level); fake stereo
 *             (identical channels) and out-of-phase channels are flagged
 *   verdict   plain-language findings with a severity, plus a 0-100 score
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FFPROBE, ffmpegLog } from '../media/ffmpeg.js';
import { downloadToFile } from '../services/storage.service.js';

const exec = promisify(execFile);

export const QUALITY_VERSION = 1;

export interface QualityFinding {
  level: 'good' | 'info' | 'warn' | 'bad';
  text: string;
}

export interface AudioQuality {
  version: number;
  codec: string | null;
  lossless: boolean;
  bitrateKbps: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number;
  durationSec: number;
  peakDb: number | null;
  clippedSamples: number;
  dcOffset: number | null;
  noiseFloorDb: number | null;
  crestDb: number | null;
  /** Side level relative to mid, dB (−∞ = mono). */
  stereoWidthDb: number | null;
  stereo: 'stereo' | 'narrow' | 'mono' | 'fake-stereo' | 'out-of-phase';
  score: number;
  findings: QualityFinding[];
}

const LOSSLESS = new Set(['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_s24be', 'flac', 'alac', 'wavpack', 'ape', 'tta']);

/** "Overall" numbers from an astats log. */
function overall(log: string): Record<string, number> {
  const section = log.slice(log.lastIndexOf('Overall'));
  const out: Record<string, number> = {};
  for (const match of section.matchAll(/\]\s+([A-Za-z][A-Za-z ()_]+?):\s+(-?[\d.]+|-?inf)/g)) {
    const value = match[2] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[2]);
    if (!(match[1]!.trim() in out)) out[match[1]!.trim()] = value;
  }
  return out;
}

export async function analyseQuality(key: string): Promise<AudioQuality> {
  const dir = await mkdtemp(join(tmpdir(), 'mv-quality-'));
  try {
    const file = join(dir, 'song');
    await downloadToFile(key, file);
    const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', file], { maxBuffer: 4_000_000 });
    const data = JSON.parse(stdout) as {
      format?: { duration?: string; bit_rate?: string };
      streams?: { codec_name?: string; sample_rate?: string; channels?: number; bit_rate?: string; bits_per_raw_sample?: string; bits_per_sample?: number; sample_fmt?: string }[];
    };
    const stream = data.streams?.[0];
    const codec = stream?.codec_name ?? null;
    const lossless = codec ? LOSSLESS.has(codec) : false;
    const channels = stream?.channels ?? 0;
    const sampleRate = stream?.sample_rate ? Number(stream.sample_rate) : null;
    const bitrate = Number(stream?.bit_rate ?? data.format?.bit_rate ?? 0);
    const bitDepth = Number(stream?.bits_per_raw_sample ?? 0) || stream?.bits_per_sample || (stream?.sample_fmt?.startsWith('s16') ? 16 : stream?.sample_fmt?.startsWith('s32') ? 24 : null) || null;
    const durationSec = Number(data.format?.duration ?? 0);

    // Full-resolution signal stats, then the same on a mid / side split.
    const full = overall(await ffmpegLog(['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'astats=measure_perchannel=none', '-f', 'null', '-']));
    const ms =
      channels >= 2
        ? await ffmpegLog([
            '-hide_banner',
            '-nostats',
            '-i',
            file,
            '-vn',
            '-filter_complex',
            '[0:a]pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0-0.5*c1,channelsplit=channel_layout=stereo[m][s];[m]astats=measure_perchannel=none[mo];[s]astats=measure_perchannel=none[so]',
            '-map',
            '[mo]',
            '-f',
            'null',
            '-',
            '-map',
            '[so]',
            '-f',
            'null',
            '-',
          ]).catch(() => '')
        : '';
    // Two astats "Overall" blocks: mid first, then side.
    const blocks = ms.split('Overall').slice(1);
    const rmsOf = (block: string | undefined): number | null => {
      const match = block?.match(/RMS level dB:\s+(-?[\d.]+|-inf)/);
      return match ? (match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])) : null;
    };
    const midRms = rmsOf(blocks[0]);
    const sideRms = rmsOf(blocks[1]);
    const width = midRms !== null && sideRms !== null ? (Number.isFinite(sideRms) ? +(sideRms - midRms).toFixed(1) : Number.NEGATIVE_INFINITY) : null;

    const peakDb = Number.isFinite(full['Peak level dB']) ? +full['Peak level dB']!.toFixed(2) : null;
    const clipped = Math.round((full['Peak count'] ?? 0) > 2 && (peakDb ?? -99) >= -0.05 ? full['Peak count']! : 0);
    const dc = full['DC offset'] ?? null;
    const noise = Number.isFinite(full['Noise floor dB']) ? +full['Noise floor dB']!.toFixed(1) : null;
    const crest = full['Crest factor'] ? +(20 * Math.log10(full['Crest factor']!)).toFixed(1) : null;

    let stereo: AudioQuality['stereo'] = 'stereo';
    if (channels < 2) stereo = 'mono';
    else if (width === Number.NEGATIVE_INFINITY || (width !== null && width < -45)) stereo = 'fake-stereo';
    else if (width !== null && width > 2) stereo = 'out-of-phase';
    else if (width !== null && width < -20) stereo = 'narrow';

    const findings: QualityFinding[] = [];
    let score = 100;
    const add = (level: QualityFinding['level'], text: string, cost = 0): void => {
      findings.push({ level, text });
      score -= cost;
    };
    if (lossless) add('good', `Lossless ${codec?.toUpperCase()}${bitDepth ? ` · ${bitDepth}-bit` : ''}${sampleRate ? ` · ${(sampleRate / 1000).toFixed(1)} kHz` : ''}: master quality.`);
    else if (bitrate && bitrate < 160_000) add('bad', `Low-bitrate ${codec?.toUpperCase() ?? 'audio'} (${Math.round(bitrate / 1000)} kbps): highs will sound smeared. Upload the WAV / FLAC or a 320 kbps file.`, 30);
    else if (bitrate && bitrate < 256_000) add('warn', `${codec?.toUpperCase() ?? 'Lossy'} at ${Math.round(bitrate / 1000)} kbps: usable, but a WAV or 320 kbps file sounds better.`, 12);
    else add('info', `${codec?.toUpperCase() ?? 'Lossy'}${bitrate ? ` at ${Math.round(bitrate / 1000)} kbps` : ''}: good for video. A WAV master is still best.`, 4);
    if (sampleRate && sampleRate < 44_100) add('bad', `Sample rate ${(sampleRate / 1000).toFixed(1)} kHz is below CD quality (44.1 kHz).`, 20);
    if (bitDepth && bitDepth < 16) add('bad', `${bitDepth}-bit audio: audible noise / grain.`, 20);
    if (clipped > 0) add(clipped > 200 ? 'bad' : 'warn', `${clipped.toLocaleString()} samples hit full scale (clipping): distortion on loud parts.`, clipped > 200 ? 20 : 8);
    else if (peakDb !== null && peakDb > -0.3) add('warn', `Peaks at ${peakDb} dBFS: no headroom. The master will be limited to -1 dBTP.`, 4);
    if (dc !== null && Math.abs(dc) > 0.005) add('warn', `DC offset ${dc.toFixed(4)}: the waveform sits off-centre (wastes headroom, can click on cuts). It is corrected on render.`, 5);
    if (noise !== null && noise > -60) add('warn', `Noise floor ${noise} dBFS: hiss or room noise is audible in quiet parts.`, 8);
    if (crest !== null && crest < 8) add('warn', `Crest factor ${crest} dB: heavily limited / squashed. Louder isn't better for streaming.`, 6);
    if (stereo === 'mono') add('info', 'Mono file: fine for vocals-only demos; a stereo mix sounds wider in the video.', 4);
    if (stereo === 'fake-stereo') add('warn', 'Both channels are identical (mono saved as stereo): no stereo width.', 6);
    if (stereo === 'out-of-phase') add('bad', 'Channels are out of phase: the song nearly vanishes on phone speakers (mono). Flip one channel’s polarity.', 25);
    if (stereo === 'narrow') add('info', 'Narrow stereo image.', 2);
    if (findings.every((finding) => finding.level === 'good' || finding.level === 'info')) add('good', 'No clipping, noise or phase problems found.');

    return {
      version: QUALITY_VERSION,
      codec,
      lossless,
      bitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
      sampleRate,
      bitDepth,
      channels,
      durationSec,
      peakDb,
      clippedSamples: clipped,
      dcOffset: dc,
      noiseFloorDb: noise,
      crestDb: crest,
      stereoWidthDb: width === Number.NEGATIVE_INFINITY ? null : width,
      stereo,
      score: Math.max(0, Math.min(100, score)),
      findings,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
