/**
 * Animated text for every video the app renders (music-video titles, write-ups and publishing
 * rights, the cold open's on-screen text, and later ads / YouTube): one style model, one set of
 * animations, ready-made templates, all drawn by libass (ffmpeg `subtitles`), so text costs no
 * tokens and is pixel-sharp at any resolution.
 *
 *   style      font (bundled, data/fonts), size, weight, italic, case, letter spacing, colour,
 *              accent (glow / splash colour), outline, shadow, glow, position, alignment
 *   in / out   none, fade, glow, zoom in, zoom out, typewriter, word by word, slide, colour
 *              splash, pop, blur — each with its own length
 *   templates  presets for the common jobs (music intro, write-up, publishing rights, lower
 *              third, quote, neon, cinematic…), which the artist then tweaks
 *
 * KEEP IN SYNC with fe/src/utils/textStyles.ts (ids, labels, templates, the preview).
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ fonts */

/**
 * family:     the name libass matches (the name inside the .ttf)
 * boldFamily: a separate family for the heavy cut (static instances name it that way); absent =
 *             the family's own Bold face, or libass's emboldening when the font has one weight
 */
export const FONTS = {
  montserrat: { label: 'Montserrat · modern', family: 'Montserrat', boldFamily: 'Montserrat ExtraBold' },
  inter: { label: 'Inter · clean', family: 'Inter', boldFamily: 'Inter ExtraBold' },
  poppins: { label: 'Poppins · friendly', family: 'Poppins' },
  oswald: { label: 'Oswald · condensed', family: 'Oswald' },
  bebas: { label: 'Bebas Neue · poster', family: 'Bebas Neue' },
  anton: { label: 'Anton · impact', family: 'Anton' },
  cinzel: { label: 'Cinzel · cinematic', family: 'Cinzel' },
  playfair: { label: 'Playfair Display · elegant', family: 'Playfair Display' },
  spacemono: { label: 'Space Mono · typewriter', family: 'Space Mono' },
  righteous: { label: 'Righteous · retro neon', family: 'Righteous' },
  pacifico: { label: 'Pacifico · script', family: 'Pacifico' },
  greatvibes: { label: 'Great Vibes · signature', family: 'Great Vibes' },
} as const satisfies Record<string, { label: string; family: string; boldFamily?: string }>;
export type FontId = keyof typeof FONTS;
export const FONT_IDS = Object.keys(FONTS) as [FontId, ...FontId[]];

/* ------------------------------------------------------------------ style */

export const TEXT_IN = ['none', 'fade', 'glow', 'zoom-in', 'zoom-out', 'typewriter', 'words', 'slide-up', 'slide-left', 'splash', 'pop', 'blur'] as const;
export const TEXT_OUT = ['none', 'fade', 'glow', 'zoom-in', 'zoom-out', 'slide-down', 'blur'] as const;
export type TextIn = (typeof TEXT_IN)[number];
export type TextOut = (typeof TEXT_OUT)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Use a colour like #FFD166' });

export const textStyleSchema = z.strictObject({
  font: z.enum(FONT_IDS),
  /** Relative to the frame: 1 = a normal title line. */
  size: z.number().min(0.3).max(3),
  bold: z.boolean(),
  italic: z.boolean(),
  uppercase: z.boolean(),
  /** Extra space between letters (pixels at 1080p). */
  spacing: z.number().min(-4).max(30),
  color: hex,
  /** The glow, splash and outline-light colour. */
  accent: hex,
  /** 0-1: a soft halo around the letters in the accent colour. */
  glow: z.number().min(0).max(1),
  /** Outline and drop shadow, 0-8 (relative to the size). */
  outline: z.number().min(0).max(8),
  shadow: z.number().min(0).max(8),
  position: z.enum(['top', 'middle', 'lower-third', 'bottom']),
  /** Dragged on the screen: the text's centre as fractions of the frame (0-1). Wins over `position`. */
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  align: z.enum(['left', 'center', 'right']),
  in: z.enum(TEXT_IN),
  out: z.enum(TEXT_OUT),
  /** Seconds the entrance / exit takes. */
  inSec: z.number().min(0.1).max(4),
  outSec: z.number().min(0.1).max(4),
});
export type TextStyle = z.infer<typeof textStyleSchema>;

const base: TextStyle = {
  font: 'montserrat',
  size: 1,
  bold: false,
  italic: false,
  uppercase: true,
  spacing: 4,
  color: '#FFFFFF',
  accent: '#FFD166',
  glow: 0,
  outline: 1,
  shadow: 1,
  position: 'middle',
  align: 'center',
  in: 'fade',
  out: 'fade',
  inSec: 0.7,
  outSec: 0.7,
};

/* ------------------------------------------------------------------ templates */

export const TEXT_TEMPLATES = {
  'music-intro': {
    label: 'Music intro',
    use: 'Artist and song title, big and bold, glowing in',
    style: { ...base, font: 'bebas', size: 1.6, spacing: 8, accent: '#FF4D8D', glow: 0.6, in: 'glow', out: 'zoom-in', inSec: 1.2, outSec: 0.8 },
  },
  cinematic: {
    label: 'Cinematic title',
    use: 'Film-style credits: wide letters, slow fade',
    style: { ...base, font: 'cinzel', size: 1.15, spacing: 14, glow: 0.15, accent: '#F5E6C8', in: 'fade', out: 'fade', inSec: 1.4, outSec: 1.2 },
  },
  'write-up': {
    label: 'Write-up',
    use: 'A story card or paragraph, word by word',
    style: { ...base, font: 'playfair', size: 0.75, uppercase: false, spacing: 0, in: 'words', out: 'fade', inSec: 2, outSec: 0.8 },
  },
  'publishing-rights': {
    label: 'Publishing rights',
    use: '℗ / © lines and credits, small at the bottom',
    style: { ...base, font: 'inter', size: 0.42, uppercase: false, spacing: 1, outline: 0.5, shadow: 0.5, position: 'bottom', in: 'fade', out: 'fade', inSec: 0.6, outSec: 0.6 },
  },
  'lower-third': {
    label: 'Lower third',
    use: 'A name or place, sliding in at the lower left',
    style: { ...base, font: 'oswald', size: 0.8, bold: true, spacing: 3, position: 'lower-third', align: 'left', in: 'slide-left', out: 'fade', inSec: 0.6, outSec: 0.5 },
  },
  neon: {
    label: 'Neon glow',
    use: 'Club-light letters that flicker on',
    style: { ...base, font: 'righteous', size: 1.2, uppercase: false, spacing: 2, color: '#FDF7FF', accent: '#00E5FF', glow: 1, outline: 2, in: 'glow', out: 'glow', inSec: 1, outSec: 0.8 },
  },
  impact: {
    label: 'Impact',
    use: 'One loud word or line that pops',
    style: { ...base, font: 'anton', size: 1.8, spacing: 2, outline: 3, shadow: 3, in: 'pop', out: 'zoom-out', inSec: 0.45, outSec: 0.5 },
  },
  splash: {
    label: 'Colour splash',
    use: 'Colour sweeps across the words',
    style: { ...base, font: 'poppins', size: 1.1, bold: true, spacing: 2, accent: '#FF6B35', in: 'splash', out: 'fade', inSec: 1.2, outSec: 0.6 },
  },
  quote: {
    label: 'Quote',
    use: 'A line from the song, elegant and slow',
    style: { ...base, font: 'playfair', size: 0.95, italic: true, uppercase: false, spacing: 1, in: 'blur', out: 'blur', inSec: 1.2, outSec: 1 },
  },
  typewriter: {
    label: 'Typewriter',
    use: 'Place and year, typed letter by letter',
    style: { ...base, font: 'spacemono', size: 0.7, spacing: 3, position: 'lower-third', align: 'left', in: 'typewriter', out: 'fade', inSec: 1.5, outSec: 0.6 },
  },
  signature: {
    label: 'Signature',
    use: 'A handwritten name or sign-off',
    style: { ...base, font: 'greatvibes', size: 2, uppercase: false, spacing: 0, glow: 0.2, in: 'zoom-out', out: 'fade', inSec: 1.2, outSec: 1 },
  },
  minimal: {
    label: 'Minimal',
    use: 'Small, quiet, lower case',
    style: { ...base, font: 'inter', size: 0.6, uppercase: false, spacing: 6, outline: 0, shadow: 0.5, in: 'fade', out: 'fade' },
  },
} as const satisfies Record<string, { label: string; use: string; style: TextStyle }>;
export type TextTemplateId = keyof typeof TEXT_TEMPLATES;
export const TEXT_TEMPLATE_IDS = Object.keys(TEXT_TEMPLATES) as [TextTemplateId, ...TextTemplateId[]];
export const templateStyle = (id: TextTemplateId): TextStyle => ({ ...TEXT_TEMPLATES[id].style });

/* ------------------------------------------------------------------ ASS */

export interface TextFrame {
  width: number;
  height: number;
}

/** "#RRGGBB" → ASS "&HBBGGRR&" (with an optional alpha byte, 00 = opaque). */
export function assColor(color: string, alpha = '00'): string {
  const value = color.replace('#', '');
  return `&H${alpha}${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`.toUpperCase();
}
export const stamp = (seconds: number): string => {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360_000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
export const assEscape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

/** Font size in pixels for a style on this frame. */
export const fontPx = (style: TextStyle, frame: TextFrame): number => Math.max(8, Math.round((Math.min(frame.width, frame.height) / 12) * style.size));

const ALIGN = { left: 0, center: 1, right: 2 } as const;
/** ASS numpad alignment: 1-3 bottom, 4-6 middle, 7-9 top. */
function anchor(style: TextStyle): number {
  // Dragged text is anchored on its centre (the point the user placed).
  if (style.x !== undefined && style.y !== undefined) return 5;
  const column = ALIGN[style.align] + 1;
  return style.position === 'top' ? 6 + column : style.position === 'middle' ? 3 + column : column;
}
/** Where the text sits (the \pos point for its anchor). */
function point(style: TextStyle, frame: TextFrame): { x: number; y: number } {
  if (style.x !== undefined && style.y !== undefined) return { x: Math.round(frame.width * style.x), y: Math.round(frame.height * style.y) };
  const marginX = Math.round(frame.width * 0.08);
  const x = style.align === 'left' ? marginX : style.align === 'right' ? frame.width - marginX : Math.round(frame.width / 2);
  const y =
    style.position === 'top' ? Math.round(frame.height * 0.1) : style.position === 'middle' ? Math.round(frame.height / 2) : style.position === 'lower-third' ? Math.round(frame.height * 0.78) : Math.round(frame.height * 0.92);
  return { x, y };
}

/** One [V4+ Styles] row (the animations add to it per line). */
export function assStyleRow(name: string, style: TextStyle, frame: TextFrame): string {
  const font = FONTS[style.font];
  const heavy = style.bold && 'boldFamily' in font;
  const size = fontPx(style, frame);
  const scale = size / 60;
  return [
    `Style: ${name}`,
    heavy ? (font as { boldFamily: string }).boldFamily : font.family,
    size,
    assColor(style.color),
    assColor(style.accent),
    assColor(style.glow > 0 ? style.accent : '#000000', style.glow > 0 ? '00' : '40'),
    assColor('#000000', '80'),
    style.bold && !heavy ? -1 : 0,
    style.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    +(style.spacing * (frame.height / 1080)).toFixed(1),
    0,
    1,
    +(style.outline * scale + style.glow * 3 * scale).toFixed(1),
    +(style.shadow * scale).toFixed(1),
    anchor(style),
    Math.round(frame.width * 0.08),
    Math.round(frame.width * 0.08),
    Math.round(frame.height * 0.06),
    1,
  ].join(',');
}

/** The file's head: script info, the given styles, the events header. */
export function assHeader(frame: TextFrame, styles: { name: string; style: TextStyle }[]): string[] {
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
    ...styles.map(({ name, style }) => assStyleRow(name, style, frame)),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
}

const ms = (seconds: number): number => Math.round(seconds * 1000);

/**
 * One animated line (or block: \n breaks lines) from `start` for `seconds`, in the named style.
 * The entrance and exit are override tags on the line; the glow halo is the style's blurred border.
 */
export function textEvent(input: { styleName: string; style: TextStyle; text: string; start: number; seconds: number; frame: TextFrame; layer?: number }): string {
  const { style, frame } = input;
  const seconds = Math.max(0.4, input.seconds);
  const inMs = Math.min(ms(style.inSec), ms(seconds * 0.6));
  const outMs = style.out === 'none' ? 0 : Math.min(ms(style.outSec), ms(seconds * 0.4));
  const end = ms(seconds);
  const at = point(style, frame);
  const raw = style.uppercase ? input.text.toUpperCase() : input.text;
  const glowBlur = style.glow > 0 ? `\\blur${+(2 + style.glow * 10).toFixed(1)}` : '';
  const tags: string[] = [`\\an${anchor(style)}`];
  let body = assEscape(raw);

  // Entrance.
  switch (style.in) {
    case 'fade':
      tags.push(`\\pos(${at.x},${at.y})`);
      break;
    case 'glow':
      tags.push(`\\pos(${at.x},${at.y})`, `\\alpha&HFF&\\blur24\\t(0,${inMs},\\alpha&H00&${glowBlur || '\\blur0'})`);
      break;
    case 'zoom-in':
      tags.push(`\\pos(${at.x},${at.y})`, `\\fscx45\\fscy45\\t(0,${inMs},0.7,\\fscx100\\fscy100)`);
      break;
    case 'zoom-out':
      tags.push(`\\pos(${at.x},${at.y})`, `\\fscx170\\fscy170\\t(0,${inMs},0.6,\\fscx100\\fscy100)`);
      break;
    case 'pop':
      tags.push(`\\pos(${at.x},${at.y})`, `\\fscx40\\fscy40\\t(0,${Math.round(inMs * 0.65)},\\fscx115\\fscy115)\\t(${Math.round(inMs * 0.65)},${inMs},\\fscx100\\fscy100)`);
      break;
    case 'blur':
      tags.push(`\\pos(${at.x},${at.y})`, `\\blur30\\t(0,${inMs},${glowBlur || '\\blur0'})`);
      break;
    case 'slide-up': {
      const rise = Math.round(frame.height * 0.06);
      tags.push(`\\move(${at.x},${at.y + rise},${at.x},${at.y},0,${inMs})`);
      break;
    }
    case 'slide-left': {
      const run = Math.round(frame.width * 0.12);
      tags.push(`\\move(${style.align === 'right' ? at.x + run : at.x - run},${at.y},${at.x},${at.y},0,${inMs})`);
      break;
    }
    case 'splash':
      // Karaoke fill: each letter starts in the accent colour (secondary) and is swept to the
      // text colour left to right, with a small scale settle.
      tags.push(`\\pos(${at.x},${at.y})`, `\\fscx108\\fscy108\\t(0,${inMs},\\fscx100\\fscy100)`);
      body = `{\\kf${Math.max(1, Math.round(inMs / 10))}}${body}`;
      break;
    case 'typewriter': {
      tags.push(`\\pos(${at.x},${at.y})`);
      const letters = [...raw];
      const per = inMs / Math.max(1, letters.filter((char) => char.trim()).length);
      let shown = 0;
      body = letters
        .map((char) => {
          if (char === '\n') return '\\N';
          if (!char.trim()) return char;
          const t = Math.round(shown++ * per);
          return `{\\alpha&HFF&\\t(${t},${t + 1},\\alpha&H00&)}${assEscape(char)}`;
        })
        .join('');
      break;
    }
    case 'words': {
      tags.push(`\\pos(${at.x},${at.y})`);
      const lines = raw.split(/\r?\n/);
      const total = lines.reduce((sum, line) => sum + line.split(/\s+/).filter(Boolean).length, 0);
      const per = inMs / Math.max(1, total);
      let index = 0;
      body = lines
        .map((line) =>
          line
            .split(/\s+/)
            .filter(Boolean)
            .map((word) => {
              const t = Math.round(index++ * per);
              return `{\\alpha&HFF&\\t(${t},${t + 280},\\alpha&H00&)}${assEscape(word)}`;
            })
            .join(' '),
        )
        .join('\\N');
      break;
    }
    default:
      tags.push(`\\pos(${at.x},${at.y})`);
  }
  // A steady glow (when the entrance didn't already settle on it).
  if (glowBlur && !['glow', 'blur'].includes(style.in)) tags.push(glowBlur);

  // Fades: always a short alpha ramp so nothing pops on or off, longer for fade-style moves.
  const fadeIn = style.in === 'none' || style.in === 'typewriter' || style.in === 'words' || style.in === 'glow' ? 0 : style.in === 'fade' || style.in === 'blur' ? inMs : Math.min(inMs, 250);
  const fadeOut = outMs;
  if (fadeIn || fadeOut) tags.push(`\\fad(${fadeIn},${fadeOut})`);

  // Exit.
  const from = Math.max(0, end - outMs);
  switch (style.out) {
    case 'glow':
      tags.push(`\\t(${from},${end},\\blur24)`);
      break;
    case 'zoom-in':
      tags.push(`\\t(${from},${end},\\fscx135\\fscy135)`);
      break;
    case 'zoom-out':
      tags.push(`\\t(${from},${end},\\fscx60\\fscy60)`);
      break;
    case 'blur':
      tags.push(`\\t(${from},${end},\\blur30)`);
      break;
    case 'slide-down':
      // \move and \pos can't both be on a line: the slide-down exit sinks it with a vertical scale.
      tags.push(`\\t(${from},${end},\\fscy40\\frx60)`);
      break;
    default:
      break;
  }

  return `Dialogue: ${input.layer ?? 0},${stamp(input.start)},${stamp(input.start + seconds)},${input.styleName},,0,0,0,,{${tags.join('')}}${body}`;
}
