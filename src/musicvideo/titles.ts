/**
 * Opening titles for a music video, the way real ones open:
 *
 *   prologue    optional story text cards on black BEFORE the song starts
 *               ("Lagos, 2019. She left without a word…"), words revealed
 *               one by one, then a slow fade
 *   credits     "A XYZ FILMS PRODUCTION" → "XYZ RECORDS PRESENTS" →
 *               ARTIST / "SONG TITLE" (ft. …), letter-spaced, fading in and
 *               out, either over the intro footage or on black before it
 *   write-ups   text cards over the video at chosen moments
 *   end credit  "Directed by …" and the publishing rights over the last seconds
 *
 * Every part is drawn by the text engine (media/textfx.ts): a template for the
 * set (music intro, cinematic, neon…) and per-part tweaks (font, size, weight,
 * colour, glow, entrance / exit animation). The director proposes them in the
 * director's room; the artist edits and switches them on. Rendered with libass
 * at the master with the bundled fonts (no AI, no tokens).
 */
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { assHeader, stamp, TEXT_TEMPLATE_IDS, templateStyle, textEvent, textStyleSchema, type TextFrame, type TextStyle, type TextTemplateId } from '../media/textfx.js';

export const TITLE_STYLES = ['classic', 'minimal', 'typewriter', 'bold'] as const;
export type TitleStyle = (typeof TITLE_STYLES)[number];

const field = (max: number) => z.string().trim().max(max);

export const titlesSchema = z.strictObject({
  enabled: z.boolean(),
  /** e.g. "A Sunset Films production" */
  presenter: field(80),
  /** e.g. "Mavin Records presents" */
  label: field(80),
  artist: field(80),
  song: field(80),
  featuring: field(80),
  /** End credit: "Directed by …" (empty = none). */
  director: field(80),
  /** Story text cards on black before the song. */
  prologue: z.array(z.strictObject({ text: z.string().trim().min(1).max(220), seconds: z.number().min(2).max(10) })).max(5),
  /** The original four looks (kept for titles saved before templates; `template` wins when set). */
  style: z.enum(TITLE_STYLES),
  /** Credits over the intro footage, or on black before the song (after the prologue). */
  placement: z.enum(['over-intro', 'on-black']),
  /** The text template for the whole set (media/textfx.ts): font, colours, glow, animations. */
  template: z.enum(TEXT_TEMPLATE_IDS).optional(),
  /** The artist's own tweaks per part (size, font, colour, entrance…), over the template. */
  looks: z
    .strictObject({
      title: textStyleSchema.optional(),
      credit: textStyleSchema.optional(),
      story: textStyleSchema.optional(),
      end: textStyleSchema.optional(),
      rights: textStyleSchema.optional(),
      writeUp: textStyleSchema.optional(),
    })
    .optional(),
  /** Publishing rights / copyright lines over the last seconds ("℗ 2026 … · © 2026 …"). */
  rights: z.string().trim().max(300).optional(),
  /** Text cards over the video at chosen moments (seconds from the start of the video). */
  writeUps: z.array(z.strictObject({ text: z.string().trim().min(1).max(220), at: z.number().min(0).max(3600), seconds: z.number().min(1.5).max(15) })).max(12).optional(),
});
export type Titles = z.infer<typeof titlesSchema>;

export function defaultTitles(artist: string, song: string): Titles {
  return { enabled: false, presenter: '', label: '', artist, song, featuring: '', director: '', prologue: [], style: 'classic', placement: 'over-intro' };
}

export function parseTitles(value: unknown, artist: string, song: string): Titles {
  const parsed = titlesSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultTitles(artist, song);
}

/* ------------------------------------------------------------------ timing */

/** Seconds of credit cards on black (0 when they sit over the intro). */
function blackCreditSeconds(titles: Titles): number {
  if (titles.placement !== 'on-black') return 0;
  return (titles.presenter ? 3.4 : 0) + (titles.label ? 3.4 : 0) + (titles.artist || titles.song ? 4.6 : 0);
}

/** Total seconds added before the song starts. */
export function openingSeconds(titles: Titles | null): number {
  if (!titles?.enabled) return 0;
  const prologue = titles.prologue.reduce((sum, card) => sum + card.seconds, 0);
  const total = prologue + blackCreditSeconds(titles);
  return total > 0 ? total + 0.6 : 0;
}

/* ------------------------------------------------------------------ looks (media/textfx.ts) */

/** The parts of the title set, each with its own look. */
export const TITLE_ROLES = ['title', 'credit', 'story', 'end', 'rights', 'writeUp'] as const;
export type TitleRole = (typeof TITLE_ROLES)[number];

/** Titles saved before templates existed keep their look. */
const LEGACY_TEMPLATE: Record<TitleStyle, TextTemplateId> = { classic: 'cinematic', minimal: 'minimal', typewriter: 'typewriter', bold: 'impact' };

/** The template in effect: the chosen one, else the one the old style maps to. */
export const titleTemplate = (titles: Pick<Titles, 'template' | 'style'>): TextTemplateId => titles.template ?? LEGACY_TEMPLATE[titles.style];

/**
 * Each part's look: derived from the template (the title in it, credits small and quiet, story
 * cards and write-ups as readable paragraphs, the publishing rights small at the bottom), then the
 * artist's own tweaks per part on top.
 */
export function titleLooks(titles: Pick<Titles, 'template' | 'style' | 'looks'>): Record<TitleRole, TextStyle> {
  const id = titleTemplate(titles);
  const look = templateStyle(id);
  const centred = { position: 'middle', align: 'center' } as const;
  const readable: TextStyle['font'][] = ['cinzel', 'playfair', 'spacemono', 'inter', 'montserrat', 'poppins'];
  const story: TextStyle = { ...templateStyle('write-up'), ...(readable.includes(look.font) ? { font: look.font } : {}), color: look.color, ...centred };
  const credit: TextStyle = {
    ...look,
    ...centred,
    size: Math.max(0.4, +(look.size * 0.42).toFixed(2)),
    glow: +(look.glow * 0.5).toFixed(2),
    in: look.in === 'typewriter' ? 'typewriter' : 'fade',
    out: 'fade',
  };
  const derived: Record<TitleRole, TextStyle> = {
    title: { ...look, ...centred },
    credit,
    story,
    end: { ...credit, position: 'lower-third' },
    rights: templateStyle('publishing-rights'),
    writeUp: { ...story, position: 'lower-third', size: Math.min(story.size, 0.7) },
  };
  for (const role of TITLE_ROLES) {
    const own = titles.looks?.[role];
    if (own) derived[role] = own;
  }
  return derived;
}

/* ------------------------------------------------------------------ ASS */

export type Frame = TextFrame;

const STYLE_NAME: Record<TitleRole, string> = { title: 'Title', credit: 'Credit', story: 'Story', end: 'End', rights: 'Rights', writeUp: 'WriteUp' };

function header(frame: Frame, looks: Record<TitleRole, TextStyle>): string[] {
  return assHeader(
    frame,
    TITLE_ROLES.map((role) => ({ name: STYLE_NAME[role], style: looks[role] })),
  );
}

const line = (role: TitleRole, looks: Record<TitleRole, TextStyle>, frame: Frame, text: string, start: number, seconds: number): string =>
  textEvent({ styleName: STYLE_NAME[role], style: looks[role], text, start, seconds, frame });

function creditEvents(titles: Titles, looks: Record<TitleRole, TextStyle>, frame: Frame, start: number): string[] {
  const events: string[] = [];
  let at = start;
  const card = (role: TitleRole, text: string, seconds: number): void => {
    events.push(line(role, looks, frame, text, at, seconds));
    at += seconds;
  };
  if (titles.presenter) card('credit', titles.presenter, 3.4);
  if (titles.label) card('credit', titles.label, 3.4);
  if (titles.artist || titles.song) {
    const song = titles.song ? (titleTemplate(titles) === 'minimal' ? titles.song : `“${titles.song}”`) : '';
    card('title', [titles.artist, song, titles.featuring ? `ft. ${titles.featuring}` : ''].filter(Boolean).join('\n'), 4.6);
  }
  return events;
}

/**
 * The opening on black: story cards then (when placed on black) the credits. Returns its length,
 * or 0 when there is nothing to put on black.
 */
export async function writeOpeningAss(titles: Titles, file: string, frame: Frame): Promise<number> {
  const seconds = openingSeconds(titles);
  if (seconds === 0) return 0;
  const looks = titleLooks(titles);
  const events: string[] = [];
  let at = 0.3;
  for (const card of titles.prologue) {
    events.push(line('story', looks, frame, card.text, at, card.seconds));
    at += card.seconds;
  }
  if (titles.placement === 'on-black') events.push(...creditEvents(titles, looks, frame, at));
  await writeFile(file, [...header(frame, looks), ...events, ''].join('\n'), 'utf8');
  return seconds;
}

/**
 * Text drawn over the finished video: the credits over the intro (when placed there), the
 * write-ups at their times, the "Directed by" credit and the publishing rights over the last
 * seconds. Returns false when there is nothing to draw.
 */
export async function writeOverlayAss(titles: Titles, file: string, frame: Frame & { total: number }): Promise<boolean> {
  if (!titles.enabled) return false;
  const looks = titleLooks(titles);
  const events: string[] = [];
  if (titles.placement === 'over-intro') {
    // Fit inside the first half of the video for very short cuts.
    const credits = creditEvents(titles, looks, frame, 0.8);
    const scale = Math.min(1, (frame.total * 0.5) / 12);
    events.push(...(scale < 1 ? credits.map((event) => scaleEvent(event, scale)) : credits));
  }
  for (const card of titles.writeUps ?? []) {
    if (card.at >= frame.total - 0.5) continue;
    events.push(line('writeUp', looks, frame, card.text, card.at, Math.min(card.seconds, frame.total - card.at)));
  }
  const tail = Math.min(5.5, frame.total * 0.3);
  if (titles.director && frame.total > 8) events.push(line('end', looks, frame, `Directed by ${titles.director}`, frame.total - tail, tail - 0.3));
  if (titles.rights?.trim() && frame.total > 4) events.push(line('rights', looks, frame, titles.rights.trim(), frame.total - tail, tail - 0.3));
  if (events.length === 0) return false;
  await writeFile(file, [...header(frame, looks), ...events, ''].join('\n'), 'utf8');
  return true;
}

/** Compresses an event's timing (for videos too short for the full sequence). */
function scaleEvent(event: string, scale: number): string {
  return event.replace(/^Dialogue: (\d+),([\d:.]+),([\d:.]+),/, (_, layer: string, a: string, b: string) => `Dialogue: ${layer},${stamp(parse(a) * scale)},${stamp(parse(b) * scale)},`);
}
const parse = (value: string): number => {
  const [h, m, s] = value.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};
