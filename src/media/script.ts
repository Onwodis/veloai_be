/**
 * Reel script: a tiny line-based language creators write at upload time to
 * steer the cut and add effects. One command per line, `#` starts a comment.
 *
 *   clip  02:10-02:55 "Why pricing matters"   make this exact moment a reel (title optional)
 *   skip  00:00-01:30                          never use this part
 *   zoom  03:12-03:18                          punch-in zoom
 *   shake 05:20-05:21                          camera shake
 *   bw    05:00-05:10                          black and white
 *   blur  06:00-06:04                          blur the picture
 *   vignette 01:00-01:20                       darken the edges
 *   mute  07:00-07:02                          silence the audio (e.g. a swear word)
 *   flash 04:01                                white flash at one moment
 *   text  03:12-03:16 "This changed everything" on-screen text
 *   title 3                                    show each reel's title for its first 3 s
 *
 * Times are positions in the uploaded video: `75`, `1:15`, `1:15.5` or
 * `1:01:15`. Effects and text may instead use `+N` (seconds into every reel),
 * e.g. `zoom +0-+2` zooms the first two seconds of each reel.
 *
 * KEEP IN SYNC with fe/src/utils/reelScript.ts (same grammar, live preview).
 */

export const EFFECTS = ['zoom', 'shake', 'bw', 'blur', 'vignette', 'mute', 'flash'] as const;
export type EffectKind = (typeof EFFECTS)[number];

export interface ScriptEdit {
  kind: EffectKind | 'text';
  from: number;
  to: number;
  /** true: seconds into every reel; false: position in the source video. */
  relative: boolean;
  text?: string;
  line: number;
}

export interface ScriptRange {
  start: number;
  end: number;
  line: number;
}

export interface ReelScript {
  clips: (ScriptRange & { title?: string })[];
  skips: ScriptRange[];
  edits: ScriptEdit[];
  titleSeconds: number | null;
}

export interface ScriptError {
  line: number;
  message: string;
}

export const SCRIPT_LIMITS = { chars: 4000, lines: 200, clipMin: 5, clipMax: 180, effectMax: 60, textMax: 20, textChars: 80, flashSeconds: 0.35 } as const;

const TIME = String.raw`\+?\d+(?:\.\d+)?|\d{1,2}:\d{1,2}(?::\d{1,2})?(?:\.\d+)?`;
const RANGE_RE = new RegExp(String.raw`^(${TIME})\s*-\s*(${TIME})$`);
const POINT_RE = new RegExp(String.raw`^(${TIME})$`);

interface Time {
  seconds: number;
  relative: boolean;
}

function parseTime(raw: string): Time | null {
  const relative = raw.startsWith('+');
  const body = relative ? raw.slice(1) : raw;
  const parts = body.split(':');
  if (parts.length > 3 || parts.some((part) => part === '' || Number.isNaN(Number(part)))) return null;
  if (parts.length > 1 && parts.slice(1).some((part) => Number(part) >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (relative && parts.length > 1) return null;
  return { seconds: +seconds.toFixed(2), relative };
}

/** Splits `cmd args "quoted text"` into the command, the time spec and the quoted text. */
function splitLine(line: string): { command: string; spec: string; text: string | null } | null {
  const match = /^([a-z]+)\s*(.*?)\s*(?:"([^"]*)"|“([^”]*)”)?\s*$/i.exec(line);
  if (!match) return null;
  return { command: match[1]!.toLowerCase(), spec: match[2] ?? '', text: match[3] ?? match[4] ?? null };
}

export const formatClock = (seconds: number): string => {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = +(total % 60).toFixed(1);
  const ss = s < 10 ? `0${s}` : String(s);
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/**
 * Parses and validates a script. `durationSec` (when known) rejects times
 * past the end of the video.
 */
export function parseReelScript(source: string, durationSec?: number): { script: ReelScript; errors: ScriptError[] } {
  const script: ReelScript = { clips: [], skips: [], edits: [], titleSeconds: null };
  const errors: ScriptError[] = [];
  if (source.length > SCRIPT_LIMITS.chars) {
    return { script, errors: [{ line: 0, message: `Scripts can be up to ${SCRIPT_LIMITS.chars} characters` }] };
  }
  const lines = source.split(/\r?\n/);
  if (lines.length > SCRIPT_LIMITS.lines) {
    return { script, errors: [{ line: 0, message: `Scripts can be up to ${SCRIPT_LIMITS.lines} lines` }] };
  }

  const pastEnd = (seconds: number): boolean => durationSec !== undefined && seconds > durationSec + 0.5;

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const fail = (message: string): void => void errors.push({ line: lineNo, message });

    const parts = splitLine(line);
    if (!parts) return fail('Could not read this line');
    const { command, spec, text } = parts;

    if (command === 'title') {
      const seconds = Number(spec);
      if (!spec || Number.isNaN(seconds) || seconds < 1 || seconds > 10) return fail('Use title <seconds>, from 1 to 10, e.g. title 3');
      script.titleSeconds = seconds;
      return;
    }

    const known = command === 'clip' || command === 'skip' || command === 'text' || (EFFECTS as readonly string[]).includes(command);
    if (!known) return fail(`Unknown command "${command}". Use clip, skip, text, title or an effect: ${EFFECTS.join(', ')}`);

    // flash takes a single moment; everything else a range.
    let from: Time | null;
    let to: Time | null;
    if (command === 'flash') {
      const point = POINT_RE.exec(spec);
      from = point ? parseTime(point[1]!) : null;
      if (!from) return fail('Use flash <time>, e.g. flash 04:01 or flash +1');
      to = { seconds: +(from.seconds + SCRIPT_LIMITS.flashSeconds).toFixed(2), relative: from.relative };
    } else {
      const range = RANGE_RE.exec(spec);
      from = range ? parseTime(range[1]!) : null;
      to = range ? parseTime(range[2]!) : null;
      if (!from || !to) return fail(`Use ${command} <start>-<end>, e.g. ${command} 01:05-01:12`);
    }

    if (from.relative !== to.relative) return fail('Use video times (01:05-01:12) or reel times (+0-+3) on both sides, not a mix');
    if (to.seconds <= from.seconds) return fail('The end must be after the start');
    const length = to.seconds - from.seconds;

    if (command === 'clip' || command === 'skip') {
      if (from.relative) return fail(`${command} needs video times like 02:10-02:55, not reel times`);
      if (pastEnd(from.seconds)) return fail(`Starts at ${formatClock(from.seconds)}, after the video ends (${formatClock(durationSec ?? 0)})`);
      const range = { start: from.seconds, end: Math.min(to.seconds, durationSec ?? to.seconds), line: lineNo };
      if (command === 'skip') {
        script.skips.push(range);
        return;
      }
      const clipLength = range.end - range.start;
      if (clipLength < SCRIPT_LIMITS.clipMin || clipLength > SCRIPT_LIMITS.clipMax) return fail(`A clip must be ${SCRIPT_LIMITS.clipMin}-${SCRIPT_LIMITS.clipMax} seconds long`);
      const clash = script.clips.find((other) => range.start < other.end && other.start < range.end);
      if (clash) return fail(`Overlaps the clip on line ${clash.line}`);
      script.clips.push({ ...range, ...(text?.trim() ? { title: text.trim().slice(0, 70) } : {}) });
      return;
    }

    if (!from.relative && pastEnd(from.seconds)) return fail(`Starts at ${formatClock(from.seconds)}, after the video ends (${formatClock(durationSec ?? 0)})`);
    if (command === 'text') {
      if (!text?.trim()) return fail('Put the words in quotes, e.g. text 03:12-03:16 "This changed everything"');
      if (text.trim().length > SCRIPT_LIMITS.textChars) return fail(`On-screen text can be up to ${SCRIPT_LIMITS.textChars} characters`);
      if (length > SCRIPT_LIMITS.textMax) return fail(`On-screen text can stay up to ${SCRIPT_LIMITS.textMax} seconds`);
      script.edits.push({ kind: 'text', from: from.seconds, to: to.seconds, relative: from.relative, text: text.trim(), line: lineNo });
      return;
    }
    if (text) return fail(`${command} doesn't take text in quotes`);
    if (length > SCRIPT_LIMITS.effectMax) return fail(`Effects can last up to ${SCRIPT_LIMITS.effectMax} seconds`);
    script.edits.push({ kind: command as EffectKind, from: from.seconds, to: to.seconds, relative: from.relative, line: lineNo });
  });

  for (const clip of script.clips) {
    const skip = script.skips.find((range) => clip.start < range.end && range.start < clip.end);
    if (skip) errors.push({ line: clip.line, message: `This clip overlaps the skip on line ${skip.line}` });
  }
  return { script, errors };
}

/**
 * Effects and text for one reel cut from [start, end] of the source, with
 * times re-based to the reel (0 = first frame). Reel-relative edits apply to
 * every reel; source-timed ones only where they fall inside the cut.
 */
export function editsForReel(script: ReelScript | undefined, start: number, end: number): ScriptEdit[] {
  if (!script) return [];
  const duration = end - start;
  const out: ScriptEdit[] = [];
  for (const edit of script.edits) {
    const from = edit.relative ? edit.from : edit.from - start;
    const to = edit.relative ? edit.to : edit.to - start;
    const clampedFrom = Math.max(0, from);
    const clampedTo = Math.min(duration, to);
    if (clampedTo - clampedFrom < 0.05) continue;
    out.push({ ...edit, from: +clampedFrom.toFixed(2), to: +clampedTo.toFixed(2) });
  }
  return out;
}
