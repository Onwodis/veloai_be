/**
 * Renders one reel with FFmpeg, as an edit (not just a trim):
 *
 *   cut       the clip, with pauses removed (jump cuts, see edit.ts)
 *   frame     original: keeps the source aspect ratio and size (≤1920 long side)
 *             fit:      9:16, whole frame over a blurred fill of itself
 *             crop:     9:16, centre crop (talking heads)
 *   enhance   light temporal denoise, colour look, gentle sharpening
 *   effects   hook open, rhythmic punch-ins, flashpoints (auto) + the
 *             creator's reel-script effects
 *   text      hook headline, flashpoint words, animated captions (libass)
 *   audio     voice cleanup (rumble cut, FFT denoise, compression),
 *             −14 LUFS loudness, script mutes; or no audio at all (muted)
 *   encode    H.264 High CRF 19 / AAC 192k, +faststart, plus a thumbnail
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOOKS, type Look } from '../studio/cinema.js';
import type { Canvas, CaptionStyle, Overlay } from './captions.js';
import { buildAss } from './captions.js';
import { planEdit, type ReelPlan } from './edit.js';
import { ffmpeg } from './ffmpeg.js';
import type { EffectKind, ScriptEdit } from './script.js';
import type { Word } from './transcribe.js';

export type Framing = 'original' | 'fit' | 'crop';

/** How the reel is finished. Every field has a default (see DEFAULT_STYLE). */
export interface EditStyle {
  /** Export without sound. */
  muted: boolean;
  look: Look | 'none';
  /** Remove pauses between sentences. */
  jumpCuts: boolean;
  /** Clean up voice noise (and light video denoise). */
  denoise: boolean;
  /** Hook open, punch-ins, flashpoints, hook headline. */
  autoEffects: boolean;
}

export const DEFAULT_STYLE: EditStyle = { muted: false, look: 'natural', jumpCuts: true, denoise: true, autoEffects: true };

export interface RenderInput {
  source: string;
  workDir: string;
  reelId: string;
  start: number;
  end: number;
  words: Word[];
  framing: Framing;
  captionStyle: CaptionStyle | 'none';
  hasAudio: boolean;
  /** Source frame size (after rotation), for 'original' framing. */
  sourceSize: { width: number; height: number };
  style: EditStyle;
  /** The AI's hook headline and flashpoints for this reel. */
  plan?: ReelPlan | undefined;
  /** Effects and on-screen text from the reel script, in clip time (before jump cuts). */
  edits?: ScriptEdit[];
  /** Script `title N`: show this text for the first N seconds (replaces the hook headline). */
  title?: { text: string; seconds: number } | undefined;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

export function outputCanvas(framing: Framing, source: { width: number; height: number }): Canvas {
  if (framing !== 'original' || !source.width || !source.height) return { width: 1080, height: 1920 };
  const scale = Math.min(1, 1920 / Math.max(source.width, source.height));
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

/** `between(t,a,b)+between(t,c,d)`: non-zero while any range is active. */
function activeExpr(ranges: ScriptEdit[]): string {
  return ranges.map((range) => `between(t,${range.from},${range.to})`).join('+');
}

/**
 * Video effects as filter-graph steps from [in] to [out]. Each effect is
 * gated with `enable` (or an `if()` on t), so frames outside its ranges pass
 * through untouched.
 */
export function effectGraph(edits: ScriptEdit[], input: string, output: string, canvas: Canvas = { width: 1080, height: 1920 }): string[] {
  const { width: W, height: H } = canvas;
  const of = (kind: EffectKind): ScriptEdit[] => edits.filter((edit) => edit.kind === kind);
  const steps: string[] = [];
  let label = input;
  let n = 0;
  const next = (): string => `fx${(n += 1)}`;

  const zoom = of('zoom');
  if (zoom.length) {
    const [a, b, z, out] = [next(), next(), next(), next()];
    steps.push(`[${label}]split=2[${a}][${b}]`, `[${b}]crop=iw/1.18:ih/1.18,scale=${W}:${H}:flags=lanczos,setsar=1[${z}]`, `[${a}][${z}]overlay=0:0:enable='${activeExpr(zoom)}'[${out}]`);
    label = out;
  }

  const shake = of('shake');
  if (shake.length) {
    // Oversize by 6 %, then move the crop window on two out-of-phase sines.
    const on = activeExpr(shake);
    const [ow, oh] = [even(W * 1.06), even(H * 1.06)];
    const [cx, cy] = [Math.floor((ow - W) / 2), Math.floor((oh - H) / 2)];
    const amp = Math.max(4, Math.floor(Math.min(cx, cy) * 0.8));
    const [a, b, s, out] = [next(), next(), next(), next()];
    steps.push(
      `[${label}]split=2[${a}][${b}]`,
      `[${b}]scale=${ow}:${oh},crop=${W}:${H}:x='${cx}+if(${on},${amp}*sin(t*43),0)':y='${cy}+if(${on},${amp}*cos(t*37),0)'[${s}]`,
      `[${a}][${s}]overlay=0:0:enable='${on}'[${out}]`,
    );
    label = out;
  }

  const simple: string[] = [];
  const bw = of('bw');
  if (bw.length) simple.push(`hue=s=0:enable='${activeExpr(bw)}'`);
  const blur = of('blur');
  if (blur.length) simple.push(`boxblur=22:2:enable='${activeExpr(blur)}'`);
  const vignette = of('vignette');
  if (vignette.length) simple.push(`vignette=angle=PI/3.5:enable='${activeExpr(vignette)}'`);
  const flash = of('flash');
  if (flash.length) {
    // Brightness spikes to +0.85 and decays linearly over the flash.
    const terms = flash.map((range) => `if(between(t,${range.from},${range.to}),0.85*(1-(t-${range.from})/${Math.max(0.05, range.to - range.from)}),0)`);
    simple.push(`eq=brightness='min(1,${terms.join('+')})':eval=frame`);
  }

  if (simple.length) {
    const out = next();
    steps.push(`[${label}]${simple.join(',')}[${out}]`);
    label = out;
  }

  if (label === input) steps.push(`[${input}]null[${output}]`);
  else steps[steps.length - 1] = steps[steps.length - 1]!.replace(new RegExp(String.raw`\[${label}\]$`), `[${output}]`);
  return steps;
}

export async function renderReel(input: RenderInput): Promise<{ video: string; thumb: string; durationSec: number; cuts: number; effects: number }> {
  const { style } = input;
  const clipLength = +(input.end - input.start).toFixed(3);
  const video = join(input.workDir, `${input.reelId}.mp4`);
  const thumb = join(input.workDir, `${input.reelId}.jpg`);
  const assName = `${input.reelId}.ass`;
  const canvas = outputCanvas(input.framing, input.sourceSize);
  const withAudio = input.hasAudio && !style.muted;

  /* EDIT DECISIONS ------------------------------------------------------ */
  const plan = planEdit({ words: input.words, start: input.start, end: input.end, jumpCuts: style.jumpCuts, autoEffects: style.autoEffects, plan: input.plan });
  const duration = +plan.duration.toFixed(3);
  // The creator's script effects are in clip time: move them onto the cut timeline.
  const scriptEdits = (input.edits ?? []).map((edit) => {
    const from = plan.map(edit.from);
    return { ...edit, from: +from.toFixed(3), to: +Math.max(from + 0.05, plan.map(edit.to)).toFixed(3) };
  });
  const edits = [...plan.edits, ...scriptEdits];

  /* TEXT ------------------------------------------------------------------ */
  const headline = input.title?.text ?? plan.hookText;
  const overlays: Overlay[] = [
    ...(headline ? [{ text: headline, s: 0, e: Math.min(duration, input.title?.seconds ?? 3) }] : []),
    // Auto flashpoint words (line 0) pop in the centre; script text is a top callout.
    ...edits.filter((edit) => edit.kind === 'text' && edit.text).map((edit) => ({ text: edit.text!, s: edit.from, e: edit.to, kind: edit.line === 0 ? ('pop' as const) : ('callout' as const) })),
  ];
  const wantCaptions = input.captionStyle !== 'none' && plan.words.length > 0;
  const subtitles = wantCaptions || overlays.length > 0;
  if (subtitles) await writeFile(join(input.workDir, assName), buildAss(wantCaptions ? plan.words : [], wantCaptions ? input.captionStyle : 'none', duration, overlays, canvas), 'utf8');
  // libass is given a bare file name (ffmpeg runs with cwd = workDir) to avoid
  // Windows drive-letter escaping in the filter graph.
  const subs = subtitles ? `ass=${assName}` : 'null';

  /* CUT ------------------------------------------------------------------- */
  const graph: string[] = [];
  const segments = plan.segments;
  const trimmed = segments.length > 1 || segments[0]!.from > 0.01 || segments[0]!.to < clipLength - 0.01;
  if (trimmed) {
    segments.forEach((segment, index) => {
      const length = segment.to - segment.from;
      graph.push(`[0:v]trim=start=${segment.from.toFixed(3)}:end=${segment.to.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`);
      // 15-20 ms fades stop clicks at every cut.
      if (withAudio) graph.push(`[0:a]atrim=start=${segment.from.toFixed(3)}:end=${segment.to.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.015,afade=t=out:st=${Math.max(0, length - 0.02).toFixed(3)}:d=0.02[a${index}]`);
    });
    graph.push(`${segments.map((_, index) => (withAudio ? `[v${index}][a${index}]` : `[v${index}]`)).join('')}concat=n=${segments.length}:v=1:a=${withAudio ? 1 : 0}[vc]${withAudio ? '[ac]' : ''}`);
  } else {
    graph.push('[0:v]null[vc]');
    if (withAudio) graph.push('[0:a]anull[ac]');
  }

  /* FRAME ----------------------------------------------------------------- */
  const { width: W, height: H } = canvas;
  if (input.framing === 'original') {
    graph.push(`[vc]fps=30,scale=${W}:${H}:flags=lanczos,setsar=1[base]`);
  } else if (input.framing === 'crop') {
    graph.push(`[vc]fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1[base]`);
  } else {
    // The blurred fill is built at quarter size and scaled back up: it looks the
    // same (it's a blur) and costs ~1/16 of a full-resolution boxblur.
    const [qw, qh] = [even(W / 4), even(H / 4)];
    graph.push(
      `[vc]fps=30,split=2[pa][pb]`,
      `[pa]scale=${qw}:${qh}:force_original_aspect_ratio=increase,crop=${qw}:${qh},boxblur=7:2,eq=brightness=-0.12:saturation=1.15,scale=${W}:${H}:flags=bicubic[bg]`,
      `[pb]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
    );
  }

  /* ENHANCE + EFFECTS + TEXT ---------------------------------------------- */
  const enhance = [
    ...(style.denoise ? ['hqdn3d=1.5:1.2:5:5'] : []),
    ...(style.look !== 'none' ? [LOOKS[style.look]] : []),
    'unsharp=5:5:0.45:5:5:0',
  ];
  graph.push(`[base]${enhance.join(',')}[graded]`);
  // A short fade up from black and down at the end: reels open and close like a
  // finished edit instead of hard-starting mid-frame.
  const fadeIn = Math.min(0.3, duration / 10);
  const fadeOut = Math.min(0.45, duration / 8);
  const fades = `fade=t=in:st=0:d=${fadeIn.toFixed(2)},fade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(2)}`;
  graph.push(...effectGraph(edits, 'graded', 'fx', canvas), `[fx]${subs},${fades},format=yuv420p[v]`);

  /* AUDIO ----------------------------------------------------------------- */
  if (withAudio) {
    const mutes = scriptEdits.filter((edit) => edit.kind === 'mute');
    const chain = [
      ...(style.denoise ? ['highpass=f=80', 'afftdn=nr=12:nf=-30:tn=1', 'lowpass=f=15000'] : []),
      'acompressor=threshold=-21dB:ratio=3:attack=5:release=120:makeup=2',
      'loudnorm=I=-14:TP=-1.5:LRA=11',
      ...(mutes.length ? [`volume=0:enable='${activeExpr(mutes)}'`] : []),
      'aresample=48000',
      `afade=t=in:st=0:d=${Math.min(0.15, duration / 20).toFixed(2)}`,
      `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(2)}`,
    ];
    graph.push(`[ac]${chain.join(',')}[aout]`);
  }

  await ffmpeg(
    [
      '-ss', String(input.start),
      '-t', String(clipLength),
      '-i', input.source,
      '-filter_complex', graph.join(';'),
      '-map', '[v]',
      ...(withAudio ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      video,
    ],
    {
      cwd: input.workDir,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: (seconds: number) => input.onProgress?.(Math.min(1, seconds / Math.max(0.1, duration))) } : {}),
    },
  );

  await ffmpeg(['-ss', String(Math.min(1.5, duration / 3)), '-i', video, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', thumb], { cwd: input.workDir });
  return { video, thumb, durationSec: duration, cuts: segments.length - 1, effects: plan.edits.length };
}
