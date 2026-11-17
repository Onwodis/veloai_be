/**
 * Opening titles for a music video, the way real ones open:
 *
 *   prologue    optional story text cards on black BEFORE the song starts
 *               ("Lagos, 2019. She left without a word…"), words revealed
 *               one by one, then a slow fade
 *   credits     "A XYZ FILMS PRODUCTION" → "XYZ RECORDS PRESENTS" →
 *               ARTIST / "SONG TITLE" (ft. …), letter-spaced, fading in and
 *               out, either over the intro footage or on black before it
 *   end credit  "Directed by …" over the last seconds
 *
 * The director proposes them in the director's room; the artist edits and
 * switches them on. Rendered with libass at the master (no AI, no tokens).
 */
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

export const TITLE_STYLES = ['classic', 'minimal', 'typewriter', 'bold'] as const;
export type TitleStyle = (typeof TITLE_STYLES)[number];

const line = (max: number) => z.string().trim().max(max);

export const titlesSchema = z.strictObject({
  enabled: z.boolean(),
  /** e.g. "A Sunset Films production" */
  presenter: line(80),
  /** e.g. "Mavin Records presents" */
  label: line(80),
  artist: line(80),
  song: line(80),
  featuring: line(80),
  /** End credit: "Directed by …" (empty = none). */
  director: line(80),
  /** Story text cards on black before the song. */
  prologue: z.array(z.strictObject({ text: z.string().trim().min(1).max(220), seconds: z.number().min(2).max(10) })).max(5),
  style: z.enum(TITLE_STYLES),
  /** Credits over the intro footage, or on black before the song (after the prologue). */
  placement: z.enum(['over-intro', 'on-black']),
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

/* ------------------------------------------------------------------ ASS */

const FONT: Record<TitleStyle, { small: string; big: string; spacing: number; bold: boolean }> = {
  classic: { small: 'Georgia', big: 'Georgia', spacing: 6, bold: false },
  minimal: { small: 'Arial', big: 'Arial', spacing: 9, bold: false },
  typewriter: { small: 'Courier New', big: 'Courier New', spacing: 3, bold: false },
  bold: { small: 'Arial', big: 'Arial Black', spacing: 3, bold: true },
};

const stamp = (seconds: number): string => {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360_000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

export interface Frame {
  width: number;
  height: number;
}

export function header(frame: Frame, style: TitleStyle): string[] {
  const font = FONT[style];
  const unit = Math.min(frame.width, frame.height);
  const small = Math.round(unit / 30);
  const big = Math.round(unit / (style === 'bold' ? 9 : 11));
  const story = Math.round(unit / 22);
  const margin = Math.round(frame.width / 12);
  const row = (name: string, fontName: string, size: number, bold: boolean, spacing: number, align: number, marginV: number): string =>
    `Style: ${name},${fontName},${size},&H00FFFFFF,&H00FFFFFF,&H80000000,&H00000000,${bold ? -1 : 0},0,0,0,100,100,${spacing},0,1,${Math.max(1, Math.round(size / 40))},0,${align},${margin},${margin},${marginV},1`;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    row('Credit', font.small, small, false, font.spacing, 5, 0),
    row('Artist', font.small, Math.round(small * 1.25), font.bold, font.spacing + 2, 5, 0),
    row('Song', font.big, big, font.bold, Math.max(1, Math.round(font.spacing / 2)), 5, 0),
    row('Story', style === 'typewriter' ? 'Courier New' : font.small, story, false, 1, 5, 0),
    row('End', font.small, Math.round(small * 0.9), false, font.spacing, 2, Math.round(frame.height / 10)),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
}

const upper = (value: string, style: TitleStyle): string => (style === 'minimal' ? value.toLowerCase() : value.toUpperCase());

/** Words appear one after another (typewriter-like), then the card fades out. */
export function revealWords(text: string, start: number, seconds: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const window = Math.max(0.6, Math.min(seconds * 0.55, words.length * 0.28));
  const per = (window * 1000) / Math.max(1, words.length);
  const body = words.map((word, index) => `{\\alpha&HFF&\\t(${Math.round(index * per)},${Math.round(index * per + 260)},\\alpha&H00&)}${escape(word)}`).join(' ');
  return `Dialogue: 0,${stamp(start)},${stamp(start + seconds)},Story,,0,0,0,,{\\fad(0,700)}${body}`;
}

function creditEvents(titles: Titles, start: number): string[] {
  const events: string[] = [];
  let at = start;
  const card = (styleName: string, text: string, seconds: number, extra = ''): void => {
    events.push(`Dialogue: 0,${stamp(at)},${stamp(at + seconds)},${styleName},,0,0,0,,{\\fad(700,700)${extra}}${text}`);
    at += seconds;
  };
  if (titles.presenter) card('Credit', escape(upper(titles.presenter, titles.style)), 3.4);
  if (titles.label) card('Credit', escape(upper(titles.label, titles.style)), 3.4);
  if (titles.artist || titles.song) {
    const featuring = titles.featuring ? `\\N{\\rCredit}${escape(upper(`ft. ${titles.featuring}`, titles.style))}` : '';
    const artist = titles.artist ? `{\\rArtist}${escape(upper(titles.artist, titles.style))}\\N` : '';
    const song = titles.song ? `{\\rSong}${escape(titles.style === 'minimal' ? titles.song.toLowerCase() : `“${titles.song.toUpperCase()}”`)}` : '';
    // Slow push: the title grows ~4% while it is on screen.
    card('Song', `${artist}${song}${featuring}`, 4.6, '\\fscx100\\fscy100\\t(\\fscx104\\fscy104)');
  }
  return events;
}

/**
 * The opening on black: prologue cards then (when placed on black) the
 * credits. Returns its length, or 0 when there is nothing to put on black.
 */
export async function writeOpeningAss(titles: Titles, file: string, frame: Frame): Promise<number> {
  const seconds = openingSeconds(titles);
  if (seconds === 0) return 0;
  const events: string[] = [];
  let at = 0.3;
  for (const card of titles.prologue) {
    events.push(revealWords(card.text, at, card.seconds));
    at += card.seconds;
  }
  if (titles.placement === 'on-black') events.push(...creditEvents(titles, at));
  await writeFile(file, [...header(frame, titles.style), ...events, ''].join('\n'), 'utf8');
  return seconds;
}

/**
 * Titles drawn over the finished video: the credits over the intro (when
 * placed there) and the end credit over the last seconds. Returns false when
 * there is nothing to draw.
 */
export async function writeOverlayAss(titles: Titles, file: string, frame: Frame & { total: number }): Promise<boolean> {
  if (!titles.enabled) return false;
  const events: string[] = [];
  if (titles.placement === 'over-intro') {
    // Fit inside the first half of the video for very short cuts.
    const credits = creditEvents(titles, 0.8);
    const scale = Math.min(1, (frame.total * 0.5) / 12);
    events.push(...(scale < 1 ? credits.map((event) => scaleEvent(event, scale)) : credits));
  }
  if (titles.director && frame.total > 8) {
    const start = Math.max(0, frame.total - 4.5);
    events.push(`Dialogue: 0,${stamp(start)},${stamp(frame.total - 0.3)},End,,0,0,0,,{\\fad(600,500)}${escape(upper(`Directed by ${titles.director}`, titles.style))}`);
  }
  if (events.length === 0) return false;
  await writeFile(file, [...header(frame, titles.style), ...events, ''].join('\n'), 'utf8');
  return true;
}

/** Compresses an event's timing (for videos too short for the full sequence). */
function scaleEvent(event: string, scale: number): string {
  return event.replace(/^Dialogue: 0,([\d:.]+),([\d:.]+),/, (_, a: string, b: string) => `Dialogue: 0,${stamp(parse(a) * scale)},${stamp(parse(b) * scale)},`);
}
const parse = (value: string): number => {
  const [h, m, s] = value.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};
