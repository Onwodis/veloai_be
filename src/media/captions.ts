/**
 * Animated word-level captions as an ASS subtitle file, burned in by libass
 * during render. Times are relative to the clip start.
 *
 * Styles
 *   pop      - 2-3 word lines, bold caps; the spoken word turns accent green
 *              and pops (scale 115%) as it is said
 *   karaoke  - full line visible; words fill with colour as they are spoken
 *   minimal  - small sentence-case lines, no animation
 */
import type { Word } from './transcribe.js';

export type CaptionStyle = 'pop' | 'karaoke' | 'minimal';

const ACCENT = '&H0081B910&'; // #10B981 in ASS BGR order
const WHITE = '&H00FFFFFF&';
/** Callout box colour: brand violet #8B5CF6 in ASS BGR order, slightly translucent. */
const CALLOUT_EDGE = '&H20F65C8B&';

function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total - Math.floor(total)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const clean = (text: string): string => text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();

function groupWords(words: Word[], maxWords: number, maxChars: number): Word[][] {
  const groups: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    const length = current.reduce((sum, item) => sum + item.w.length + 1, 0) + word.w.length;
    const last = current[current.length - 1];
    const gap = last ? word.s - last.e : 0;
    if (current.length && (current.length >= maxWords || length > maxChars || gap > 0.6 || /[.!?,;:]$/.test(last?.w ?? ''))) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Text placed on screen by the creator's reel script (or the reel title). */
export interface Overlay {
  text: string;
  s: number;
  e: number;
  /** callout: top headline (default) · pop: big centre word for flashpoints. */
  kind?: 'callout' | 'pop';
}

export interface Canvas {
  width: number;
  height: number;
}

/**
 * Builds the subtitle file: spoken-word captions (unless style is 'none')
 * plus script overlays, drawn top-centre in a bold "callout" style that
 * pops in and fades out.
 */
export function buildAss(clipWords: Word[], style: CaptionStyle | 'none', clipDuration: number, overlays: Overlay[] = [], canvas: Canvas = { width: 1080, height: 1920 }): string {
  // Sizes are designed for 1080×1920 and scaled to the output's short side.
  const unit = Math.min(canvas.width, canvas.height) / 1080;
  const vertical = canvas.height > canvas.width;
  const px = (value: number): number => Math.max(1, Math.round(value * unit));
  const fontSize = px(style === 'minimal' ? 58 : 86);
  const captionMargin = vertical ? Math.round(canvas.height * 0.29) : Math.round(canvas.height * 0.1);
  const calloutMargin = vertical ? Math.round(canvas.height * 0.135) : Math.round(canvas.height * 0.07);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 2 = bottom centre; MarginV keeps captions above platform UI.
    `Style: Main,Arial,${fontSize},${WHITE},${ACCENT},&H00000000&,&H80000000&,${style === 'minimal' ? 0 : -1},0,0,0,100,100,1,0,1,${px(style === 'minimal' ? 4 : 7)},${px(2)},2,${px(90)},${px(90)},${captionMargin},1`,
    // Alignment 8 = top centre, below the platforms' top bar.
    `Style: Callout,Arial,${px(84)},${WHITE},${WHITE},${CALLOUT_EDGE},&H90000000&,-1,0,0,0,100,100,1,0,3,${px(10)},0,8,${px(80)},${px(80)},${calloutMargin},1`,
    // Alignment 5 = dead centre: flashpoint words.
    `Style: Pop,Arial,${px(150)},${ACCENT},${WHITE},&H00000000&,&H80000000&,-1,0,0,0,100,100,2,0,1,${px(9)},${px(4)},5,${px(60)},${px(60)},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  for (const overlay of overlays) {
    const s = Math.max(0, overlay.s);
    const e = Math.min(clipDuration, overlay.e);
    const text = clean(overlay.text);
    if (e - s < 0.1 || !text) continue;
    if (overlay.kind === 'pop') {
      // Slams in from 160 %, settles, fades.
      events.push(`Dialogue: 2,${assTime(s)},${assTime(e)},Pop,,0,0,0,,{\\fad(40,200)\\fscx160\\fscy160\\t(0,140,\\fscx95\\fscy95)\\t(140,240,\\fscx100\\fscy100)}${text.toUpperCase()}`);
      continue;
    }
    // Layer 1 so callouts sit above captions; scale pop-in, then fade.
    events.push(`Dialogue: 1,${assTime(s)},${assTime(e)},Callout,,0,0,0,,{\\fad(120,160)\\fscx80\\fscy80\\t(0,160,\\fscx106\\fscy106)\\t(160,260,\\fscx100\\fscy100)}${text}`);
  }
  if (style === 'none') return `${[...header, ...events].join('\n')}\n`;

  const groups = groupWords(clipWords, style === 'minimal' ? 7 : 3, style === 'minimal' ? 34 : 18);

  groups.forEach((group, groupIndex) => {
    const groupStart = group[0]?.s ?? 0;
    const nextStart = groups[groupIndex + 1]?.[0]?.s;
    // Hold each line until the next starts (max 0.6 s gap) so text doesn't flicker.
    const groupEnd = Math.min(clipDuration, nextStart !== undefined ? Math.min(nextStart, (group[group.length - 1]?.e ?? groupStart) + 0.6) : (group[group.length - 1]?.e ?? groupStart) + 0.6);
    const text = (word: Word): string => (style === 'minimal' ? clean(word.w) : clean(word.w).toUpperCase());

    if (style === 'minimal') {
      events.push(`Dialogue: 0,${assTime(groupStart)},${assTime(groupEnd)},Main,,0,0,0,,{\\fad(80,80)}${group.map(text).join(' ')}`);
      return;
    }
    if (style === 'karaoke') {
      const body = group.map((word) => `{\\kf${Math.max(1, Math.round((word.e - word.s) * 100))}}${text(word)}`).join(' ');
      events.push(`Dialogue: 0,${assTime(groupStart)},${assTime(groupEnd)},Main,,0,0,0,,{\\1c${ACCENT}\\2c${WHITE}}${body}`);
      return;
    }
    // pop: one event per spoken word, re-drawing the line with that word lit.
    group.forEach((word, wordIndex) => {
      const start = wordIndex === 0 ? groupStart : word.s;
      const end = wordIndex === group.length - 1 ? groupEnd : (group[wordIndex + 1]?.s ?? word.e);
      if (end <= start) return;
      const line = group
        .map((other, otherIndex) =>
          otherIndex === wordIndex ? `{\\1c${ACCENT}\\fscx108\\fscy108\\t(0,90,\\fscx115\\fscy115)\\t(90,180,\\fscx108\\fscy108)}${text(other)}{\\1c${WHITE}\\fscx100\\fscy100}` : text(other),
        )
        .join(' ');
      const intro = wordIndex === 0 ? '{\\fad(60,0)}' : '';
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Main,,0,0,0,,${intro}${line}`);
    });
  });

  return `${[...header, ...events].join('\n')}\n`;
}
