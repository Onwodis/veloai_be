/**
 * The platform logo: the built-in lockup (fe/public/images/velo-nav-*.png) unless the super admin
 * makes and switches to a generated one, and they can always switch back.
 *
 *   generate   an AI emblem (text-to-image on plain white, no letters) → its background cut out →
 *              set beside the app name in a chosen font, twice: pale letters for dark screens and
 *              navy for light ones. Lettering is typeset, never drawn by the model, so the name is
 *              always spelt right. Both PNGs (transparent) go to R2 under site/brand/.
 *   use        a finished logo becomes the site's logo (every <Logo> on every page)
 *   default    back to the built-in lockup (generated logos are kept to switch to again)
 * Platform art: no tokens are charged. State lives in platform_settings ("brand-logo").
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { ffmpeg, ffmpegLog, subtitlesFilter } from '../media/ffmpeg.js';
import { FONTS, FONT_IDS, assColor, assEscape, type FontId } from '../media/textfx.js';
import { deleteObject, readUrl, uploadFile } from '../services/storage.service.js';
import * as fal from '../studio/fal.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

const KEY = 'brand-logo';
/** Cut-out model (transparent PNG of the subject). */
const CUTOUT = 'fal-ai/birefnet';
const HEIGHT = 510;
const MARK = 430;
const PAD = 40;
const TEXT_PX = 290;
const DARK_TEXT = '#F4F2FF';
const LIGHT_TEXT = '#0B1033';

export { FONT_IDS as LOGO_FONTS };

export interface BrandLogo {
  id: string;
  brief: string;
  font: FontId;
  status: 'MAKING' | 'READY' | 'FAILED';
  error: string | null;
  darkKey: string | null;
  lightKey: string | null;
  width: number;
  height: number;
  createdAt: string;
}
interface BrandState {
  activeId: string | null;
  logos: BrandLogo[];
}

async function readState(): Promise<BrandState> {
  const [row] = await sql<{ value: BrandState }[]>`SELECT value FROM platform_settings WHERE key = ${KEY}`;
  return { activeId: row?.value.activeId ?? null, logos: row?.value.logos ?? [] };
}
async function writeState(state: BrandState, actorId: string | null): Promise<void> {
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES (${KEY}, ${json(state)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  cached = null;
}
async function patchLogo(id: string, change: Partial<BrandLogo>): Promise<void> {
  const state = await readState();
  state.logos = state.logos.map((logo) => (logo.id === id ? { ...logo, ...change } : logo));
  await writeState(state, null);
}

/** Width of the lockup: the mark, a gap, then the name (estimated from the letters; a little spare). */
const widthFor = (name: string, font: FontId): number => {
  const narrow = font === 'bebas' || font === 'oswald' || font === 'anton';
  return Math.round(PAD + MARK + PAD * 2 + name.length * TEXT_PX * (narrow ? 0.48 : 0.66) + PAD);
};

/** The emblem on a transparent background, saved to `file`. */
async function makeMark(brief: string, file: string): Promise<void> {
  const settings = await getStudioSettings();
  if (!fal.falConfigured() || !settings.models.textToImage.enabled) throw new AppError(503, 'INTERNAL_ERROR', 'Image generation is switched off.');
  const run = async (endpoint: string, body: Record<string, unknown>): Promise<string> => fal.outputUrl(await fal.wait(await fal.submit(endpoint, body), { timeoutMs: 4 * 60_000 }), 'image');
  const art = await run(settings.models.textToImage.endpoint, {
    ...settings.models.textToImage.extra,
    prompt:
      `A single logo emblem for "${env.APP_NAME}", an AI video and music-video studio. ${brief}. ` +
      'One bold, simple, memorable symbol, flat vector style with clean edges, centred, filling most of the square, ' +
      'on a pure solid white background. No text, no letters, no words, no mockup, no paper, no frame, no drop shadow.',
    aspect_ratio: '1:1',
  });
  const cut = await run(CUTOUT, { image_url: art, model: 'General Use (Light)', operating_resolution: '1024x1024', output_format: 'png' });
  await downloadUrl(cut, file);
}

/** Mark + name on a transparent canvas (PNG at `out`), the name in `color`. Returns the width. */
export async function renderLockup(mark: string, name: string, font: FontId, color: string, out: string): Promise<number> {
  const width = widthFor(name, font);
  const dir = await mkdtemp(join(tmpdir(), 'brand-ass-'));
  try {
    const wide = join(dir, 'wide.png');
    await lockup(mark, name, font, color, width, dir, wide);
    // Trim the spare room after the name (the width above is a generous estimate).
    const log = await ffmpegLog(['-i', wide, '-vf', 'alphaextract,bbox=min_val=24', '-f', 'null', '-']);
    const right = Math.max(...[...log.matchAll(/x2:(\d+)/g)].map((match) => Number(match[1])), 0);
    const trimmed = right > MARK ? Math.min(width, right + PAD) : width;
    await ffmpeg(['-y', '-i', wide, '-vf', `crop=${trimmed}:${HEIGHT}:0:0`, '-frames:v', '1', out]);
    return trimmed;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function lockup(mark: string, name: string, font: FontId, color: string, width: number, dir: string, out: string): Promise<void> {
  const ass = join(dir, `${color.slice(1)}.ass`);
  const face = FONTS[font];
  const family = 'boldFamily' in face ? face.boldFamily : face.family;
  await writeFile(
    ass,
    [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${width}`,
      `PlayResY: ${HEIGHT}`,
      'WrapStyle: 2',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      // White on black: the letters become the alpha mask for the colour fill (libass leaves alpha alone).
      `Style: Name,${family},${TEXT_PX},${assColor('#FFFFFF')},${assColor('#FFFFFF')},${assColor('#000000', 'FF')},${assColor('#000000', 'FF')},${'boldFamily' in face ? 0 : -1},0,0,0,100,100,2,0,1,0,0,4,0,0,0,1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      `Dialogue: 0,0:00:00.00,0:00:05.00,Name,,0,0,0,,{\\an4\\pos(${PAD + MARK + PAD * 2},${Math.round(HEIGHT / 2)})}${assEscape(name)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  const size = `${width}x${HEIGHT}`;
  const hex = color.replace('#', '0x');
  await ffmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${size}:d=1,format=rgba`,
    '-f', 'lavfi', '-i', `color=c=black:s=${size}:d=1`,
    '-f', 'lavfi', '-i', `color=c=${hex}:s=${size}:d=1`,
    '-i', mark,
    '-filter_complex',
    `[1:v]${subtitlesFilter(ass)},format=gray[mask];[2:v]format=rgba[fill];[fill][mask]alphamerge[text];` +
      `[3:v]format=rgba,scale=${MARK}:${MARK}:force_original_aspect_ratio=decrease[m];` +
      `[0:v][text]overlay=0:0:format=auto[t];[t][m]overlay=${PAD}:(H-h)/2:format=auto,format=rgba[o]`,
    '-map', '[o]', '-frames:v', '1', out,
  ]);
}

async function produce(id: string, brief: string, font: FontId): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'brand-logo-'));
  try {
    const mark = join(dir, 'mark.png');
    await makeMark(brief, mark);
    let width = 0;
    const keys = { darkKey: `site/brand/${id}-dark.png`, lightKey: `site/brand/${id}-light.png` };
    for (const [tone, color] of [['dark', DARK_TEXT], ['light', LIGHT_TEXT]] as const) {
      const file = join(dir, `${tone}.png`);
      width = Math.max(width, await renderLockup(mark, env.APP_NAME, font, color, file));
      await uploadFile(tone === 'dark' ? keys.darkKey : keys.lightKey, file, 'image/png');
    }
    await patchLogo(id, { status: 'READY', ...keys, width, height: HEIGHT });
    logger.info({ id }, 'brand logo made');
  } catch (error) {
    logger.warn({ err: error, id }, 'brand logo failed');
    await patchLogo(id, { status: 'FAILED', error: (error instanceof Error ? error.message : 'The logo could not be made').slice(0, 300) }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Starts a logo (it is made in the background; the admin page polls). */
export async function generateLogo(actorId: string, input: { brief: string; font: FontId }): Promise<BrandView> {
  const state = await readState();
  if (state.logos.some((logo) => logo.status === 'MAKING')) throw AppError.conflict('A logo is already being made. Wait for it to finish.');
  const logo: BrandLogo = { id: randomUUID(), brief: input.brief, font: input.font, status: 'MAKING', error: null, darkKey: null, lightKey: null, width: 0, height: HEIGHT, createdAt: new Date().toISOString() };
  state.logos = [logo, ...state.logos].slice(0, 24);
  await writeState(state, actorId);
  void produce(logo.id, input.brief, input.font);
  return brandView();
}

/** Switches the site to a finished logo, or back to the built-in one (null). */
export async function useLogo(actorId: string, id: string | null): Promise<BrandView> {
  const state = await readState();
  if (id && state.logos.find((logo) => logo.id === id)?.status !== 'READY') throw AppError.badRequest('That logo isn’t finished.');
  state.activeId = id;
  await writeState(state, actorId);
  return brandView();
}

export async function deleteLogo(actorId: string, id: string): Promise<BrandView> {
  const state = await readState();
  const logo = state.logos.find((item) => item.id === id);
  if (!logo) throw AppError.notFound('Logo');
  if (logo.status === 'MAKING') throw AppError.conflict('This logo is still being made.');
  state.logos = state.logos.filter((item) => item.id !== id);
  if (state.activeId === id) state.activeId = null;
  await writeState(state, actorId);
  for (const key of [logo.darkKey, logo.lightKey]) if (key) await deleteObject(key).catch(() => undefined);
  return brandView();
}

export interface PublicLogo {
  dark: string;
  light: string;
  width: number;
  height: number;
}
const urls = async (logo: BrandLogo): Promise<PublicLogo | null> =>
  logo.darkKey && logo.lightKey ? { dark: await readUrl(logo.darkKey), light: await readUrl(logo.lightKey), width: logo.width, height: logo.height } : null;

export type BrandView = Awaited<ReturnType<typeof brandView>>;
/** For the admin page: every logo (with previews) and which one is live. */
export async function brandView() {
  const state = await readState();
  // A logo stuck MAKING after a restart (its job died with the process) is marked failed.
  const stale = state.logos.filter((logo) => logo.status === 'MAKING' && Date.now() - Date.parse(logo.createdAt) > 15 * 60_000);
  for (const logo of stale) await patchLogo(logo.id, { status: 'FAILED', error: 'Interrupted (the server restarted). Make it again.' });
  const logos = stale.length ? (await readState()).logos : state.logos;
  return {
    activeId: state.activeId,
    appName: env.APP_NAME,
    fonts: FONT_IDS.map((id) => ({ id, label: FONTS[id].label })),
    logos: await Promise.all(logos.map(async (logo) => ({ id: logo.id, brief: logo.brief, font: logo.font, status: logo.status, error: logo.error, createdAt: logo.createdAt, preview: await urls(logo) }))),
  };
}

/** Storage key of the live logo's pale version (for dark artwork), or null when the built-in one is live. */
export async function activeLogoKey(): Promise<string | null> {
  const state = await readState();
  return state.logos.find((logo) => logo.id === state.activeId && logo.status === 'READY')?.darkKey ?? null;
}

let cached: { value: PublicLogo | null; at: number } | null = null;
/** The live logo for the site (null = the built-in one). Cached a minute. */
export async function publicLogo(): Promise<PublicLogo | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const state = await readState();
  const active = state.activeId ? state.logos.find((logo) => logo.id === state.activeId && logo.status === 'READY') : undefined;
  const value = active ? await urls(active) : null;
  cached = { value, at: Date.now() };
  return value;
}
