/**
 * CapCut-style per-clip edits (studio_scenes.edits, migration studio/016),
 * rendered at assembly in each clip's conform pass:
 *
 *   trimIn     start the take later (seconds)
 *   speed      0.5×-2× (no frame interpolation: real footage speed-ramps)
 *   reverse    play backwards
 *   look       a per-clip grade from LOOKS (on top of the film's finish)
 *   adjust     brightness / contrast / saturation / warmth
 *   zoom       a slow push-in or pull-out over the clip ("Ken Burns", subtle)
 *   texts      titles / captions: text, timing within the clip, position, size
 *
 * The browser previews the same edits with CSS filters and playbackRate, so
 * the timeline looks like the export.
 */
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { LOOK_IDS, LOOKS, type Look } from './cinema.js';

export const textOverlaySchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(140),
  start: z.number().min(0).max(30),
  end: z.number().min(0).max(30),
  position: z.enum(['top', 'center', 'bottom', 'lower-third']).default('lower-third'),
  size: z.enum(['s', 'm', 'l']).default('m'),
  style: z.enum(['clean', 'bold', 'serif']).default('clean'),
});

export const clipEditsSchema = z.strictObject({
  trimIn: z.number().min(0).max(9).default(0),
  speed: z.number().min(0.5).max(2).default(1),
  reverse: z.boolean().default(false),
  look: z.enum(LOOK_IDS).nullable().default(null),
  adjust: z
    .strictObject({
      brightness: z.number().min(-0.3).max(0.3).default(0),
      contrast: z.number().min(0.7).max(1.4).default(1),
      saturation: z.number().min(0).max(2).default(1),
      warmth: z.number().min(-1).max(1).default(0),
    })
    .default({ brightness: 0, contrast: 1, saturation: 1, warmth: 0 }),
  zoom: z.enum(['none', 'in', 'out']).default('none'),
  texts: z.array(textOverlaySchema).max(6).default([]),
});
export type ClipEdits = z.infer<typeof clipEditsSchema>;

export const NO_EDITS: ClipEdits = clipEditsSchema.parse({});

export function parseEdits(value: unknown): ClipEdits {
  const parsed = clipEditsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : NO_EDITS;
}

/** Seconds of the source the clip needs to fill `length` on screen. */
export const sourceSecondsFor = (edits: ClipEdits, length: number): number => length * edits.speed;

/**
 * ffmpeg pieces for one clip. `input` goes before -i (trim-in seek);
 * `early` runs on the source frames (reverse, speed); `late` runs on the
 * conformed frame (zoom, grade, adjust).
 */
export function clipFilters(edits: ClipEdits, frame: { width: number; height: number; fps: number; length: number }): { input: string[]; early: string[]; late: string[] } {
  const input = edits.trimIn > 0 ? ['-ss', edits.trimIn.toFixed(3)] : [];
  const early: string[] = [];
  if (edits.reverse) early.push('reverse');
  if (edits.speed !== 1) early.push(`setpts=PTS/${edits.speed.toFixed(3)}`);

  const late: string[] = [];
  if (edits.zoom !== 'none') {
    // Gentle 6% over the clip; zoompan works per output frame (d=1) at the film's frame size.
    const frames = Math.max(1, Math.round(frame.length * frame.fps));
    const z = edits.zoom === 'in' ? `1+0.06*on/${frames}` : `1.06-0.06*on/${frames}`;
    late.push(`zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${frame.width}x${frame.height}:fps=${frame.fps}`);
  }
  if (edits.look) late.push(LOOKS[edits.look as Look]);
  const { brightness, contrast, saturation, warmth } = edits.adjust;
  if (brightness !== 0 || contrast !== 1 || saturation !== 1) late.push(`eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`);
  if (warmth !== 0) {
    const amount = (warmth * 0.08).toFixed(3);
    const cool = (-warmth * 0.08).toFixed(3);
    late.push(`colorbalance=rm=${amount}:rh=${amount}:bm=${cool}:bh=${cool}`);
  }
  return { input, early, late };
}

const ASS_ALIGN = { top: 8, center: 5, bottom: 2, 'lower-third': 1 } as const;
const ASS_FONT = { clean: 'Arial', bold: 'Arial Black', serif: 'Georgia' } as const;

/** Writes the clip's text overlays as an .ass file (libass); returns false when there is nothing to draw. */
export async function writeTextOverlays(edits: ClipEdits, file: string, frame: { width: number; height: number; length: number }): Promise<boolean> {
  const texts = edits.texts.filter((text) => text.end > text.start && text.start < frame.length);
  if (texts.length === 0) return false;
  const base = Math.round(frame.height / 18);
  const sizes = { s: Math.round(base * 0.7), m: base, l: Math.round(base * 1.45) };
  const stamp = (seconds: number): string => {
    const cs = Math.max(0, Math.round(seconds * 100));
    return `${Math.floor(cs / 360_000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const styles = texts.map(
    (text, index) =>
      `Style: T${index},${ASS_FONT[text.style]},${sizes[text.size]},&H00FFFFFF,&H00FFFFFF,&H90000000,&H64000000,${text.style === 'clean' ? 0 : -1},0,0,0,100,100,0,0,1,${Math.max(1, Math.round(sizes[text.size] / 22))},1,${ASS_ALIGN[text.position]},${Math.round(frame.width / 14)},${Math.round(frame.width / 14)},${text.position === 'lower-third' ? Math.round(frame.height / 5) : Math.round(frame.height / 14)},1`,
  );
  const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
  const events = texts.map((text, index) => `Dialogue: 0,${stamp(text.start)},${stamp(Math.min(text.end, frame.length))},T${index},,0,0,0,{\\fad(200,200)},${escape(text.text)}`);
  await writeFile(
    file,
    [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${frame.width}`,
      `PlayResY: ${frame.height}`,
      'WrapStyle: 0',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      ...styles,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...events,
      '',
    ].join('\n'),
    'utf8',
  );
  return true;
}
