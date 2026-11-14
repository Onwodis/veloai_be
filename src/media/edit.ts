/**
 * The auto-editor: turns a picked clip into an edit decision list.
 *
 *   Jump cuts   pauses between words longer than 0.5 s are cut out (with a
 *               little air kept either side), so the reel moves.
 *   Hook open   flash + punch-in on the first second, and the hook headline
 *               on screen for the first ~3 s.
 *   Rhythm      every other jump-cut segment is punched in (the classic
 *               talking-head "zoom cut"); without cuts, alternating windows.
 *   Flashpoints emphasis beats from the AI (or, without it, numbers / power
 *               words / exclamations): punch-ins, shakes, white flashes,
 *               black-and-white hits and pop-up key words.
 *
 * All output times are on the *edited* timeline (after jump cuts).
 */
import type { ScriptEdit } from './script.js';
import type { Word } from './transcribe.js';

export type BeatKind = 'zoom' | 'flash' | 'shake' | 'bw' | 'text';

/** An emphasis moment, in source-video seconds (as the AI returns it). */
export interface Beat {
  t: number;
  kind: BeatKind;
  text?: string | undefined;
}

/** What the hook picker decided for one reel, kept for re-renders. */
export interface ReelPlan {
  hookText: string;
  beats: Beat[];
}

export interface Segment {
  /** Seconds relative to the clip start. */
  from: number;
  to: number;
}

export interface EditPlan {
  segments: Segment[];
  duration: number;
  /** Clip-relative time → edited-timeline time. */
  map: (t: number) => number;
  edits: ScriptEdit[];
  hookText: string | null;
  /** Clip words re-timed onto the edited timeline (for captions). */
  words: Word[];
}

const GAP = 0.5;
const PAD = 0.12;
const POWER = /\b(secret|mistake|never|always|truth|crazy|insane|best|worst|stop|biggest|nobody|everyone|money|million|billion|free|hack|lesson|wrong|now|today|must|only|first|last|huge|massive|win|lose|fail|real)\b/i;

const edit = (kind: ScriptEdit['kind'], from: number, to: number, text?: string): ScriptEdit => ({ kind, from: +from.toFixed(3), to: +to.toFixed(3), relative: true, line: 0, ...(text ? { text } : {}) });

/** Speech segments of the clip with long pauses removed. */
export function speechSegments(words: Word[], start: number, end: number, jumpCuts: boolean): Segment[] {
  const length = end - start;
  const inside = words.filter((word) => word.e > start && word.s < end).map((word) => ({ s: Math.max(0, word.s - start), e: Math.min(length, word.e - start) }));
  if (!jumpCuts || inside.length < 2) return [{ from: 0, to: length }];
  const segments: Segment[] = [];
  let from = Math.max(0, inside[0]!.s - PAD * 1.5);
  for (let i = 0; i < inside.length - 1; i += 1) {
    const gap = inside[i + 1]!.s - inside[i]!.e;
    if (gap > GAP) {
      segments.push({ from, to: Math.min(length, inside[i]!.e + PAD * 2) });
      from = Math.max(0, inside[i + 1]!.s - PAD);
    }
  }
  segments.push({ from, to: Math.min(length, inside[inside.length - 1]!.e + 0.35) });
  // Drop slivers and merge overlaps from the padding.
  const merged: Segment[] = [];
  for (const segment of segments.filter((item) => item.to - item.from >= 0.25)) {
    const last = merged[merged.length - 1];
    if (last && segment.from <= last.to + 0.05) last.to = Math.max(last.to, segment.to);
    else merged.push({ ...segment });
  }
  return merged.length ? merged : [{ from: 0, to: length }];
}

function mapper(segments: Segment[]): (t: number) => number {
  return (t: number): number => {
    let offset = 0;
    for (const segment of segments) {
      if (t < segment.from) return offset; // in a removed gap: snap to the next kept frame
      if (t <= segment.to) return offset + (t - segment.from);
      offset += segment.to - segment.from;
    }
    return offset;
  };
}

/** Heuristic flashpoints when no AI plan exists: numbers, power words, exclamations. */
export function heuristicBeats(words: Word[], start: number, end: number): Beat[] {
  const beats: Beat[] = [];
  for (const word of words) {
    if (word.s < start + 1.5 || word.s > end - 0.5) continue;
    const clean = word.w.replace(/[^\p{L}\p{N}!?'%$]/gu, '');
    if (/!$/.test(word.w)) beats.push({ t: word.s, kind: 'shake' });
    else if (/\d/.test(clean)) beats.push({ t: word.s, kind: 'zoom', text: clean.toUpperCase() });
    else if (POWER.test(clean)) beats.push({ t: word.s, kind: 'zoom' });
  }
  // Space them out: at most one beat every 2.5 s.
  const spaced: Beat[] = [];
  for (const beat of beats) if (!spaced.some((other) => Math.abs(other.t - beat.t) < 2.5)) spaced.push(beat);
  // The two strongest (numbers first) also get a flash.
  spaced
    .filter((beat) => beat.text)
    .slice(0, 2)
    .forEach((beat) => spaced.push({ t: beat.t, kind: 'flash' }));
  return spaced.slice(0, 10);
}

export interface PlanInput {
  words: Word[];
  start: number;
  end: number;
  jumpCuts: boolean;
  autoEffects: boolean;
  plan?: ReelPlan | undefined;
}

export function planEdit(input: PlanInput): EditPlan {
  const segments = speechSegments(input.words, input.start, input.end, input.jumpCuts);
  const map = mapper(segments);
  const duration = segments.reduce((sum, segment) => sum + (segment.to - segment.from), 0);
  const words = input.words
    .filter((word) => word.e > input.start && word.s < input.end)
    .map((word) => ({ w: word.w, s: +map(word.s - input.start).toFixed(3), e: +Math.min(duration, map(word.e - input.start)).toFixed(3) }))
    .filter((word) => word.e > word.s);

  const edits: ScriptEdit[] = [];
  const hookText = input.plan?.hookText?.trim() || null;
  if (input.autoEffects) {
    // Hook open.
    edits.push(edit('flash', 0, Math.min(0.3, duration)), edit('zoom', 0, Math.min(1.1, duration)));

    // Rhythm: punch in on every other jump-cut segment.
    let at = 0;
    if (segments.length >= 3) {
      segments.forEach((segment, index) => {
        const length = segment.to - segment.from;
        if (index % 2 === 1 && at > 1.2) edits.push(edit('zoom', at, at + length));
        at += length;
      });
    } else {
      for (let t = 3.5; t < duration - 1; t += 5) edits.push(edit('zoom', t, Math.min(duration, t + 2)));
    }

    // Flashpoints.
    const beats = input.plan?.beats?.length ? input.plan.beats : heuristicBeats(input.words, input.start, input.end);
    let flashes = 0;
    for (const beat of beats) {
      if (beat.t < input.start || beat.t > input.end) continue;
      const t = map(beat.t - input.start);
      if (t < 1 || t > duration - 0.3) continue;
      if (beat.kind === 'zoom') edits.push(edit('zoom', t, Math.min(duration, t + 0.8)));
      if (beat.kind === 'shake') edits.push(edit('shake', t, Math.min(duration, t + 0.35)));
      if (beat.kind === 'bw') edits.push(edit('bw', t, Math.min(duration, t + 1.2)));
      if (beat.kind === 'flash' && flashes < 3) {
        flashes += 1;
        edits.push(edit('flash', t, Math.min(duration, t + 0.3)));
      }
      const text = beat.text?.trim();
      if (text && text.length <= 24) edits.push(edit('text', t, Math.min(duration, t + 1.4), text));
    }
  }
  return { segments, duration, map, edits, hookText, words };
}
