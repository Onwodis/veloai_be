/**
 * Meta ad flyers for the platform (super admin): one set = the same ad in every Meta placement size.
 *
 *   feed-square    1080 × 1080   Facebook / Instagram feed
 *   feed-portrait  1080 × 1350   Instagram feed (4:5, the most screen)
 *   story          1080 × 1920   Stories and Reels (text kept out of the top 14 % and bottom 20 %
 *                                that Meta covers with the profile bar and the reply box / CTA)
 *   link           1200 × 628    link ads, right column, Audience Network (1.91:1)
 *
 * Two AI backgrounds are made per set (portrait and landscape; no text in them), every size is cut
 * from the one that fits, and the words are typeset with the text engine in the bundled fonts:
 * an optional badge ("NEW", "-30 %"), the headline in a chosen template and accent colour, a line,
 * and the call to action as a button, over a soft scrim for legibility, with the live brand logo.
 * Changing the words re-renders every size without paying for new backgrounds.
 * Platform art: no tokens. State lives in platform_settings ("ad-flyers").
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ffmpeg, ffmpegLog, subtitlesFilter } from '../media/ffmpeg.js';
import { assColor, assEscape, assHeader, fontPx, TEXT_TEMPLATE_IDS, templateStyle, type TextStyle } from '../media/textfx.js';
import { WATERMARK_FILE, watermarkAvailable } from '../media/watermark.js';
import { deleteObject, downloadToFile, readUrl, uploadFile } from '../services/storage.service.js';
import * as fal from '../studio/fal.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { activeLogoKey } from './brandLogo.js';

const KEY = 'ad-flyers';
const MAX_SETS = 30;

export const FLYER_SIZES = {
  'feed-square': { label: 'Feed 1:1', width: 1080, height: 1080, from: 'portrait' },
  'feed-portrait': { label: 'Feed 4:5', width: 1080, height: 1350, from: 'portrait' },
  story: { label: 'Stories / Reels 9:16', width: 1080, height: 1920, from: 'portrait' },
  link: { label: 'Link ad 1.91:1', width: 1200, height: 628, from: 'landscape' },
} as const;
export type FlyerSize = keyof typeof FLYER_SIZES;
const SIZE_IDS = Object.keys(FLYER_SIZES) as [FlyerSize, ...FlyerSize[]];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const flyerWordsSchema = z.strictObject({
  headline: z.string().trim().min(2).max(70),
  subline: z.string().trim().max(140).default(''),
  cta: z.string().trim().max(32).default(''),
  badge: z.string().trim().max(18).default(''),
  template: z.enum(TEXT_TEMPLATE_IDS).default('impact'),
  accent: hex.default('#FF4D8D'),
});
export const newFlyerSchema = flyerWordsSchema.extend({
  /** What the background shows (the scene, the product moment, the mood). */
  brief: z.string().trim().min(5).max(800),
  sizes: z.array(z.enum(SIZE_IDS)).min(1).default(SIZE_IDS),
});
type Words = z.infer<typeof flyerWordsSchema>;

interface FlyerSet extends Words {
  id: string;
  brief: string;
  sizes: FlyerSize[];
  status: 'MAKING' | 'READY' | 'FAILED';
  error: string | null;
  backgrounds: { portrait: string | null; landscape: string | null };
  outputs: Partial<Record<FlyerSize, string>>;
  createdAt: string;
}

async function readSets(): Promise<FlyerSet[]> {
  const [row] = await sql<{ value: { sets?: FlyerSet[] } }[]>`SELECT value FROM platform_settings WHERE key = ${KEY}`;
  return row?.value.sets ?? [];
}
async function writeSets(sets: FlyerSet[], actorId: string | null): Promise<void> {
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES (${KEY}, ${json({ sets })}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
}
async function patchSet(id: string, change: Partial<FlyerSet>): Promise<void> {
  await writeSets((await readSets()).map((set) => (set.id === id ? { ...set, ...change } : set)), null);
}

/* ------------------------------------------------------------------ backgrounds */

async function makeBackground(brief: string, orientation: 'portrait' | 'landscape', file: string): Promise<void> {
  const settings = await getStudioSettings();
  if (!fal.falConfigured() || !settings.models.textToImage.enabled) throw new AppError(503, 'INTERNAL_ERROR', 'Image generation is switched off.');
  const handle = await fal.submit(settings.models.textToImage.endpoint, {
    ...settings.models.textToImage.extra,
    prompt:
      `Advertising key visual for ${env.APP_NAME}, an AI studio that makes music videos, ads and films. ${brief}. ` +
      `Premium, cinematic, high contrast, vivid colour, one clear subject, ${orientation === 'portrait' ? 'subject in the upper half, the lower half calmer and darker' : 'subject on the right third, the left side calmer and darker'} to leave room for text. ` +
      'Photoreal, sharp. No text, no letters, no words, no logos, no watermark, no UI mockup.',
    aspect_ratio: orientation === 'portrait' ? '9:16' : '16:9',
  });
  await downloadUrl(fal.outputUrl(await fal.wait(handle, { timeoutMs: 5 * 60_000 }), 'image'), file);
}

/* ------------------------------------------------------------------ layout */

interface Layout {
  /** Text block: left edge, top of the badge, the width the words may use. */
  x: number;
  y: number;
  textWidth: number;
  headline: number;
  scrim: 'bottom' | 'left';
}

function layoutFor(size: FlyerSize, width: number, height: number): Layout {
  const margin = Math.round(width * 0.07);
  switch (size) {
    case 'story':
      return { x: margin, y: Math.round(height * 0.5), textWidth: width - margin * 2, headline: Math.round(width * 0.1), scrim: 'bottom' };
    case 'feed-portrait':
      return { x: margin, y: Math.round(height * 0.5), textWidth: width - margin * 2, headline: Math.round(width * 0.09), scrim: 'bottom' };
    case 'feed-square':
      return { x: margin, y: Math.round(height * 0.44), textWidth: width - margin * 2, headline: Math.round(width * 0.085), scrim: 'bottom' };
    case 'link':
      return { x: Math.round(width * 0.05), y: Math.round(height * 0.2), textWidth: Math.round(width * 0.52), headline: Math.round(height * 0.12), scrim: 'left' };
  }
}

async function renderSize(set: Words, size: FlyerSize, background: string, logo: string | null, dir: string): Promise<string> {
  const { width, height } = FLYER_SIZES[size];
  const frame = { width, height };
  const layout = layoutFor(size, width, height);
  const base = templateStyle(set.template);
  const short = Math.min(width, height);
  // Sizes are given to the engine relative to the frame (fontPx = short side / 12 × size).
  const sized = (px: number): number => +((px * 12) / short).toFixed(3);
  const headline: TextStyle = { ...base, size: sized(layout.headline), accent: set.accent, align: 'left', position: 'top', in: 'none', out: 'none', glow: Math.min(base.glow, 0.5) };
  const subline: TextStyle = { ...templateStyle('minimal'), font: 'inter', size: sized(layout.headline * 0.38), uppercase: false, spacing: 0, color: '#F2F2F7', align: 'left', position: 'top', in: 'none', out: 'none' };
  const button: TextStyle = { ...subline, font: 'montserrat', bold: true, uppercase: true, spacing: 2, color: '#FFFFFF', size: sized(layout.headline * 0.36) };
  const badge: TextStyle = { ...button, size: sized(layout.headline * 0.26), spacing: 4 };

  const hPx = fontPx(headline, frame);
  const sPx = fontPx(subline, frame);
  const bPx = fontPx(button, frame);
  const gPx = fontPx(badge, frame);
  const rightMargin = width - layout.x - layout.textWidth;
  const event = (style: string, x: number, y: number, text: string): string => `Dialogue: 0,0:00:00.00,0:00:10.00,${style},,${layout.x},${rightMargin},0,,{\\an7\\pos(${x},${y})}${assEscape(text)}`;
  // A box style (BorderStyle 3): the badge and the button sit on a solid pill in the accent colour.
  const boxed = (name: string, style: TextStyle, px: number, fill: string): string => {
    const row = assHeader(frame, [{ name, style }]).find((line) => line.startsWith('Style:'))!.split(',');
    row[5] = assColor(fill); // OutlineColour: the box
    row[6] = assColor('#000000', 'A0'); // BackColour: its shadow
    row[15] = '3'; // BorderStyle
    row[16] = String(Math.round(px * 0.45)); // padding
    row[17] = '0';
    return row.join(',');
  };

  const styles = assHeader(frame, [
    { name: 'Headline', style: headline },
    { name: 'Subline', style: subline },
  ]);
  styles.splice(styles.indexOf('[Events]') - 1, 0, boxed('Button', button, bPx, set.accent), boxed('Badge', badge, gPx, set.accent));

  // Each block is rendered alone first and measured (its real wrapped height, box included), then
  // the blocks are stacked with even gaps: no guessing how many lines a headline takes.
  const blocks: { style: string; x: number; text: string; gapAfter: number }[] = [
    ...(set.badge ? [{ style: 'Badge', x: layout.x + Math.round(gPx * 0.45), text: set.badge.toUpperCase(), gapAfter: Math.round(hPx * 0.45) }] : []),
    { style: 'Headline', x: layout.x, text: set.headline, gapAfter: Math.round(hPx * 0.35) },
    ...(set.subline ? [{ style: 'Subline', x: layout.x, text: set.subline, gapAfter: Math.round(sPx * 1.3) }] : []),
    ...(set.cta ? [{ style: 'Button', x: layout.x + Math.round(bPx * 0.45), text: `${set.cta}  →`, gapAfter: 0 }] : []),
  ];
  const probeY = Math.round(height * 0.25);
  const measured: { top: number; bottom: number }[] = [];
  for (const [index, block] of blocks.entries()) {
    const file = join(dir, `${size}-measure-${index}.ass`);
    await writeFile(file, [...styles, event(block.style, block.x, probeY, block.text), ''].join('\n'), 'utf8');
    const log = await ffmpegLog(['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=0.1`, '-vf', `${subtitlesFilter(file)},format=gray,bbox=min_val=40`, '-frames:v', '1', '-f', 'null', '-']);
    const top = Math.min(...[...log.matchAll(/y1:(\d+)/g)].map((match) => Number(match[1])), probeY);
    const bottom = Math.max(...[...log.matchAll(/y2:(\d+)/g)].map((match) => Number(match[1])), probeY + 10);
    measured.push({ top: top - probeY, bottom: bottom - probeY });
  }
  const total = blocks.reduce((sum, block, index) => sum + (measured[index]!.bottom - measured[index]!.top) + block.gapAfter, 0);
  // Stories: the block ends above the reply bar (bottom 20 %); the link ad centres it; others start at their line.
  const limit = Math.round(height * (size === 'story' ? 0.78 : 0.92));
  let y = size === 'link' ? Math.round((height - total) / 2 + height * 0.06) : Math.min(layout.y, limit - total);
  const events: string[] = [];
  for (const [index, block] of blocks.entries()) {
    const { top, bottom } = measured[index]!;
    events.push(event(block.style, block.x, y - top, block.text));
    y += bottom - top + block.gapAfter;
  }
  const ass = join(dir, `${size}.ass`);
  await writeFile(ass, [...styles, ...events, ''].join('\n'), 'utf8');

  // The scrim: dark where the words go, clear where the subject is.
  const scrim = join(dir, `${size}-scrim.png`);
  const alpha = layout.scrim === 'bottom' ? '215*clip((Y/H-0.3)/0.45,0,1)' : '225*clip(1-X/(W*0.7),0,1)';
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=0.1`, '-frames:v', '1', '-vf', `format=rgba,geq=r=0:g=0:b=0:a='${alpha}'`, scrim]);

  const out = join(dir, `${size}.png`);
  const logoWidth = Math.round(width * (size === 'link' ? 0.2 : 0.3));
  const margin = Math.round(width * 0.06);
  const logoY = size === 'story' ? Math.round(height * 0.15) : margin;
  const graph =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},format=rgba[b];` +
    `[b][1:v]overlay=0:0:format=auto[s];[s]${subtitlesFilter(ass)}[t]` +
    (logo ? `;[2:v]scale=${logoWidth}:-1[l];[t][l]overlay=${margin}:${logoY}:format=auto,format=rgb24[o]` : `;[t]format=rgb24[o]`);
  await ffmpeg(['-i', background, '-i', scrim, ...(logo ? ['-i', logo] : []), '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', out]);
  return out;
}

/** Renders every size of a set from its saved backgrounds. */
async function compose(set: FlyerSet): Promise<Partial<Record<FlyerSize, string>>> {
  const dir = await mkdtemp(join(tmpdir(), 'flyers-'));
  try {
    const files: Record<'portrait' | 'landscape', string | null> = { portrait: null, landscape: null };
    for (const side of ['portrait', 'landscape'] as const) {
      const key = set.backgrounds[side];
      if (!key) continue;
      files[side] = join(dir, `${side}.img`);
      await downloadToFile(key, files[side]!);
    }
    const logoKey = await activeLogoKey();
    let logo: string | null = null;
    if (logoKey) {
      logo = join(dir, 'logo.png');
      await downloadToFile(logoKey, logo);
    } else if (await watermarkAvailable()) logo = WATERMARK_FILE;
    const outputs: Partial<Record<FlyerSize, string>> = {};
    const stamp = Date.now().toString(36);
    for (const size of set.sizes) {
      const background = files[FLYER_SIZES[size].from] ?? files.portrait ?? files.landscape;
      if (!background) continue;
      const file = await renderSize(set, size, background, logo, dir);
      const key = `marketing/flyers/${set.id}/${size}-${stamp}.png`;
      await uploadFile(key, file, 'image/png');
      outputs[size] = key;
    }
    return outputs;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function produce(id: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'flyer-bg-'));
  try {
    const set = (await readSets()).find((item) => item.id === id);
    if (!set) return;
    const needs = new Set(set.sizes.map((size) => FLYER_SIZES[size].from));
    const backgrounds = { ...set.backgrounds };
    for (const side of needs) {
      const file = join(dir, `${side}.img`);
      await makeBackground(set.brief, side, file);
      backgrounds[side] = `marketing/flyers/${id}/background-${side}.png`;
      await uploadFile(backgrounds[side]!, file, 'image/png');
    }
    const outputs = await compose({ ...set, backgrounds });
    await patchSet(id, { backgrounds, outputs, status: 'READY', error: null });
    logger.info({ id, sizes: Object.keys(outputs) }, 'ad flyers made');
  } catch (error) {
    logger.warn({ err: error, id }, 'ad flyers failed');
    await patchSet(id, { status: 'FAILED', error: (error instanceof Error ? error.message : 'The flyers could not be made').slice(0, 300) }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ API */

export async function flyersView() {
  const sets = await readSets();
  const stale = sets.filter((set) => set.status === 'MAKING' && Date.now() - Date.parse(set.createdAt) > 15 * 60_000);
  for (const set of stale) await patchSet(set.id, { status: 'FAILED', error: 'Interrupted (the server restarted). Make it again.' });
  const current = stale.length ? await readSets() : sets;
  return {
    sizes: SIZE_IDS.map((id) => ({ id, ...FLYER_SIZES[id] })),
    templates: TEXT_TEMPLATE_IDS,
    sets: await Promise.all(
      current.map(async (set) => ({
        id: set.id,
        brief: set.brief,
        headline: set.headline,
        subline: set.subline,
        cta: set.cta,
        badge: set.badge,
        template: set.template,
        accent: set.accent,
        sizes: set.sizes,
        status: set.status,
        error: set.error,
        createdAt: set.createdAt,
        outputs: await Promise.all(
          (Object.entries(set.outputs) as [FlyerSize, string][]).map(async ([size, key]) => ({
            size,
            ...FLYER_SIZES[size],
            url: await readUrl(key),
            download: await readUrl(key, `${env.APP_NAME}-${size}-${FLYER_SIZES[size].width}x${FLYER_SIZES[size].height}.png`),
          })),
        ),
      })),
    ),
  };
}

export async function createFlyers(actorId: string, input: z.infer<typeof newFlyerSchema>) {
  const sets = await readSets();
  if (sets.filter((set) => set.status === 'MAKING').length >= 2) throw AppError.conflict('Two sets are already being made. Wait for one to finish.');
  const set: FlyerSet = {
    id: randomUUID(),
    brief: input.brief,
    headline: input.headline,
    subline: input.subline,
    cta: input.cta,
    badge: input.badge,
    template: input.template,
    accent: input.accent,
    sizes: [...new Set(input.sizes)],
    status: 'MAKING',
    error: null,
    backgrounds: { portrait: null, landscape: null },
    outputs: {},
    createdAt: new Date().toISOString(),
  };
  const dropped = sets.slice(MAX_SETS - 1);
  await writeSets([set, ...sets.slice(0, MAX_SETS - 1)], actorId);
  for (const old of dropped) await removeFiles(old);
  void produce(set.id);
  return flyersView();
}

/** New words / look / sizes on the same backgrounds (free, a few seconds). */
export async function rewordFlyers(actorId: string, id: string, input: Words & { sizes?: FlyerSize[] | undefined }) {
  const set = (await readSets()).find((item) => item.id === id);
  if (!set) throw AppError.notFound('Flyer set');
  if (set.status === 'MAKING') throw AppError.conflict('This set is still being made.');
  if (!set.backgrounds.portrait && !set.backgrounds.landscape) throw AppError.badRequest('This set has no background yet. Make it again.');
  const sizes = input.sizes?.length ? [...new Set(input.sizes)] : set.sizes;
  const missing = sizes.some((size) => !set.backgrounds[FLYER_SIZES[size].from]);
  const next: FlyerSet = { ...set, ...input, sizes, status: missing ? 'MAKING' : set.status };
  if (missing) {
    // A size needs the other background (e.g. a link ad added to a portrait-only set): make it.
    await patchSet(id, { ...next, status: 'MAKING' });
    void produce(id);
    return flyersView();
  }
  const previous = Object.values(set.outputs);
  const outputs = await compose(next);
  await patchSet(id, { ...next, outputs, status: 'READY', error: null });
  for (const key of previous) if (!Object.values(outputs).includes(key)) await deleteObject(key).catch(() => undefined);
  void actorId;
  return flyersView();
}

async function removeFiles(set: FlyerSet): Promise<void> {
  for (const key of [...Object.values(set.outputs), set.backgrounds.portrait, set.backgrounds.landscape]) if (key) await deleteObject(key).catch(() => undefined);
}

export async function deleteFlyers(actorId: string, id: string) {
  const sets = await readSets();
  const set = sets.find((item) => item.id === id);
  if (!set) throw AppError.notFound('Flyer set');
  if (set.status === 'MAKING') throw AppError.conflict('This set is still being made.');
  await writeSets(sets.filter((item) => item.id !== id), actorId);
  await removeFiles(set);
  return flyersView();
}

/** For a local render check (no AI): composes a set from given background files. */
export async function renderForCheck(words: Words, sizes: FlyerSize[], portrait: string, landscape: string, outDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const size of sizes) files.push(await renderSize(words, size, FLYER_SIZES[size].from === 'portrait' ? portrait : landscape, (await watermarkAvailable()) ? WATERMARK_FILE : null, outDir));
  return files;
}
