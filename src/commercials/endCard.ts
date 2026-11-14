/**
 * The ad's end card: over the last few seconds of the master, the picture
 * blurs and dims (tinted with the brand colour), the logo fades in, then the
 * call to action and the website / handle. It sits INSIDE the ad's length
 * (never adds time), and the sound runs on untouched.
 *
 *   resolveEndCard()  the saved settings, or the defaults from the brief and company
 *   applyEndCard()    renders it onto a mastered film (used by the master, see assemble.ts)
 *
 * Text is burned with an ASS overlay (libass); without libass the card still
 * shows the logo over the blurred shot.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canBurnSubtitles, ffmpeg, filterPath } from '../media/ffmpeg.js';
import { downloadToFile } from '../services/storage.service.js';
import { sql } from '../studio/sql.js';
import type { EndCard } from './schemas.js';

interface CardSource {
  endCard: EndCard | null;
  callToAction: string;
  website: string | null;
  brandColours: string[];
  logoKey: string | null;
  productLogoKey: string | null;
}

async function source(projectId: string): Promise<CardSource | null> {
  const [row] = await sql<CardSource[]>`
    SELECT a.end_card, a.call_to_action, c.website, c.brand_colours, c.logo_key,
      (SELECT pa.key FROM product_assets pa WHERE pa.product_id = a.product_id AND pa.kind = 'LOGO' AND pa.status = 'READY' ORDER BY pa.created_at DESC LIMIT 1) AS product_logo_key
    FROM ad_projects a JOIN companies c ON c.id = a.company_id WHERE a.project_id = ${projectId}`;
  return row ?? null;
}

const host = (website: string | null): string => {
  if (!website) return '';
  try {
    return new URL(website).host.replace(/^www\./, '');
  } catch {
    return website;
  }
};

export function defaultEndCard(input: { callToAction: string; website: string | null; brandColours: string[] }): EndCard {
  return { enabled: true, seconds: 3, headline: input.callToAction.slice(0, 60), subline: host(input.website).slice(0, 80), useLogo: true, background: input.brandColours[0] ?? null };
}

/** The settings the next master will use, and whether a logo is available for it. */
export async function resolveEndCard(projectId: string): Promise<{ card: EndCard; logoKey: string | null } | null> {
  const row = await source(projectId);
  if (!row) return null;
  return { card: row.endCard ?? defaultEndCard(row), logoKey: row.logoKey ?? row.productLogoKey };
}

/** ASS dialogue text: braces and backslashes would start override tags. */
const assText = (value: string): string => value.replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ');

async function writeCardAss(file: string, card: EndCard, size: { width: number; height: number; from: number; to: number; logo: boolean }): Promise<boolean> {
  if (!card.headline.trim() && !card.subline.trim()) return false;
  const { width, height } = size;
  const stamp = (seconds: number): string => {
    const cs = Math.max(0, Math.round(seconds * 100));
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const top = size.logo ? 0.66 : 0.42;
  const head = Math.round(Math.min(width, height) / 12);
  const sub = Math.round(head * 0.55);
  // One block (headline, then the smaller subline): a headline that wraps pushes the subline down, never over it.
  const subTags = `{\\fs${sub}\\b0\\bord1.5\\c&HE6E6E6&}`;
  const body = [card.headline.trim() && assText(card.headline.trim()), card.subline.trim() && `${card.headline.trim() ? '\\N' : ''}${subTags}${assText(card.subline.trim())}`]
    .filter(Boolean)
    .join('');
  const lines = [`Dialogue: 0,${stamp(size.from + 0.45)},${stamp(size.to)},Head,,0,0,0,,{\\an8\\pos(${width / 2},${Math.round(height * top)})\\fad(400,0)}${body}`];
  await writeFile(
    file,
    [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      'WrapStyle: 0',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Head,Arial,${head},&H00FFFFFF,&H00FFFFFF,&H80000000,&H64000000,1,0,0,0,100,100,1,0,1,2,2,8,${Math.round(width * 0.06)},${Math.round(width * 0.06)},0,1`,
      `Style: Sub,Arial,${sub},&H00E6E6E6,&H00E6E6E6,&H80000000,&H64000000,0,0,0,0,100,100,2,0,1,1.5,1,8,${Math.round(width * 0.06)},${Math.round(width * 0.06)},0,1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...lines,
      '',
    ].join('\n'),
    'utf8',
  );
  return true;
}

/**
 * Renders the end card onto `film` (a finished master). Returns the new file, or null
 * when the card is off or the ad is too short for it.
 */
export async function applyEndCard(
  projectId: string,
  film: string,
  workDir: string,
  options: { width: number; height: number; total: number; fps: number; signal?: AbortSignal },
): Promise<{ file: string; detail: string } | null> {
  const resolved = await resolveEndCard(projectId);
  if (!resolved?.card.enabled) return null;
  const { card } = resolved;
  const { width, height, total } = options;
  const seconds = Math.min(card.seconds, total / 3);
  if (seconds < 1.5) return null;
  const from = +(total - seconds).toFixed(3);

  let logo: string | null = null;
  if (card.useLogo && resolved.logoKey) {
    logo = join(workDir, 'endcard-logo');
    await downloadToFile(resolved.logoKey, logo).catch(() => {
      logo = null;
    });
  }
  const ass = join(workDir, 'endcard.ass');
  const text = (await writeCardAss(ass, card, { width, height, from, to: total, logo: Boolean(logo) })) && (await canBurnSubtitles(ass).catch(() => false));

  const blur = Math.max(8, Math.round(Math.min(width, height) / 40));
  const tint = card.background ? `,drawbox=x=0:y=0:w=iw:h=ih:color=0x${card.background.slice(1)}@0.5:t=fill` : '';
  const graph = [
    '[0:v]split=2[base][bg]',
    `[bg]boxblur=${blur}:2,eq=brightness=-0.16${tint},format=yuva420p,fade=t=in:st=${from}:d=0.5:alpha=1[card]`,
    `[base][card]overlay=enable='gte(t,${from})'[v1]`,
  ];
  let last = '[v1]';
  if (logo) {
    const box = { w: Math.round(width * 0.42), h: Math.round(height * (text ? 0.26 : 0.34)) };
    const y = text ? `${Math.round(height * 0.62)}-h-${Math.round(height * 0.03)}` : '(H-h)/2';
    graph.push(`[1:v]scale=w=${box.w}:h=${box.h}:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=${(from + 0.2).toFixed(3)}:d=0.5:alpha=1[logo]`);
    graph.push(`${last}[logo]overlay=x=(W-w)/2:y=${y}:enable='gte(t,${from})':shortest=1[v2]`);
    last = '[v2]';
  }
  graph.push(`${last}${text ? `subtitles=${filterPath(ass)},` : ''}format=yuv420p[vout]`);

  const output = join(workDir, 'film-endcard.mp4');
  await ffmpeg(
    [
      '-i', film,
      ...(logo ? ['-loop', '1', '-t', total.toFixed(3), '-i', logo] : []),
      '-filter_complex', graph.join(';'),
      '-map', '[vout]', '-map', '0:a?',
      '-t', total.toFixed(3), '-r', String(options.fps),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', output,
    ],
    options.signal ? { signal: options.signal } : {},
  );
  return { file: output, detail: `${seconds.toFixed(1)} s${logo ? ', logo' : ''}${text ? ', call to action' : ''}${card.background ? `, ${card.background}` : ''}` };
}
