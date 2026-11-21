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
import { assHeader, TEXT_TEMPLATE_IDS, templateStyle, textEvent, textStyleSchema, type TextStyle } from '../media/textfx.js';
import { LOOK_IDS, LOOKS, type Look } from './cinema.js';

export const textOverlaySchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(300),
  start: z.number().min(0).max(60),
  end: z.number().min(0).max(60),
  /** Legacy quick settings (texts saved before the text engine); `look` wins when set. */
  position: z.enum(['top', 'center', 'bottom', 'lower-third']).default('lower-third'),
  size: z.enum(['s', 'm', 'l']).default('m'),
  style: z.enum(['clean', 'bold', 'serif']).default('clean'),
  /** The text engine template this text started from (media/textfx.ts). */
  template: z.enum(TEXT_TEMPLATE_IDS).optional(),
  /** Full look: font, size (any, 30 %-300 %), weight, colour, glow, outline, position, entrance / exit. */
  look: textStyleSchema.optional(),
});
export type TextOverlay = z.infer<typeof textOverlaySchema>;

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
  texts: z.array(textOverlaySchema).max(8).default([]),
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

/**
 * The look a text is drawn with: its own look, else its template's, else the legacy quick settings
 * mapped onto the bundled fonts (the old Arial / Georgia names were never installed on the server,
 * so those texts rendered in a fallback font).
 */
export function overlayLook(text: TextOverlay): TextStyle {
  if (text.look) return text.look;
  if (text.template) return templateStyle(text.template);
  const base = templateStyle('lower-third');
  const font = text.style === 'serif' ? 'playfair' : text.style === 'bold' ? 'anton' : 'inter';
  return {
    ...base,
    font,
    bold: text.style === 'bold',
    uppercase: text.style === 'bold',
    size: text.size === 's' ? 0.55 : text.size === 'l' ? 1.05 : 0.75,
    position: text.position === 'center' ? 'middle' : text.position,
    align: text.position === 'lower-third' ? 'left' : 'center',
    in: 'fade',
    out: 'fade',
    inSec: 0.25,
    outSec: 0.25,
  };
}

/**
 * Writes the clip's texts as an .ass file for the text engine (bundled fonts, animated entrances and
 * exits; burn it with media/ffmpeg.ts subtitlesFilter). Returns false when there is nothing to draw.
 */
export async function writeTextOverlays(edits: ClipEdits, file: string, frame: { width: number; height: number; length: number }): Promise<boolean> {
  const texts = edits.texts.filter((text) => text.end > text.start && text.start < frame.length);
  if (texts.length === 0) return false;
  const looks = texts.map(overlayLook);
  const events = texts.map((text, index) =>
    textEvent({ styleName: `T${index}`, style: looks[index]!, text: text.text, start: text.start, seconds: Math.min(text.end, frame.length) - text.start, frame, layer: index }),
  );
  await writeFile(file, [...assHeader(frame, looks.map((style, index) => ({ name: `T${index}`, style }))), ...events, ''].join('\n'), 'utf8');
  return true;
}
