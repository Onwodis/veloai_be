/**
 * Audio + media helpers for the music-video director.
 *
 *   renderMix       the DAW: applies the artist's edit list to the original
 *                   song and writes the working mix (lip sync and the final
 *                   cut both use it, so the picture always matches the sound)
 *                     gain   ±dB on a region (20 ms ramps, no clicks)
 *                     cut    remove a region (the song closes up)
 *                     swap   exchange two regions (e.g. move a hook earlier)
 *                     layers background effect audio under the song
 *                            (offset, trim, level, fades)
 *   transcribeSong  sung lyrics with word timings (for story beats + lip sync)
 *   videoFrames     stills pulled from a character's video, as references
 *
 * Loudness is NOT normalised here: the master is normalised once, at the
 * very end, to the artist's LUFS target (default -14).
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, mediaDuration, probe } from '../media/ffmpeg.js';
import { sentences } from '../media/hooks.js';
import { transcribe } from '../media/transcribe.js';
import { resolveEngine } from '../services/ai.service.js';
import { downloadToFile, uploadFile } from '../services/storage.service.js';
import { AppError } from '../utils/AppError.js';

export interface Region {
  id: string;
  op: 'gain' | 'cut' | 'swap' | 'fadein' | 'fadeout';
  start: number;
  end: number;
  /** gain: level change in dB (-24…+12). */
  gainDb?: number;
  /** swap: the other region, exchanged with this one. */
  swapWith?: { start: number; end: number };
}

export interface Layer {
  id: string;
  assetId: string;
  /** Where the layer starts on the edited song (seconds). */
  at: number;
  gainDb: number;
  trimStart: number;
  /** 0 = to the end of the effect file. */
  trimEnd: number;
  fadeIn: number;
  fadeOut: number;
  /** The imported audio track this event sits on (storyboard). */
  track?: string;
  muted?: boolean;
}

/** An imported audio track under the song (named by the artist; level + mute for the whole track). */
export interface AudioTrack {
  id: string;
  name: string;
  gainDb: number;
  muted?: boolean;
}

/**
 * An audio event on the storyboard's music track (Cubase-style): a slice of
 * the ORIGINAL song placed on the mix timeline. Events can be split, moved,
 * copied, trimmed, faded, muted and have their own gain. Where events overlap,
 * the later one in the list is "in front" and is the one heard (as in Cubase).
 */
export interface Clip {
  id: string;
  /** Start inside the original song (seconds). */
  src: number;
  /** Length (seconds). */
  len: number;
  /** Position on the mix timeline (seconds). */
  at: number;
  /** Event volume, dB (-60…+12). */
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  muted?: boolean;
}

export interface AudioEdits {
  regions: Region[];
  layers: Layer[];
  /** Whole-track level (the volume line on the timeline), dB. */
  gainDb?: number;
  /**
   * The storyboard arrangement. When present it REPLACES the regions: the mix
   * is these events, rendered on the timeline (gaps are silence).
   */
  clips?: Clip[];
  /** Imported audio tracks (their events are the layers with `track` set). */
  tracks?: AudioTrack[];
}

interface Piece {
  from: number;
  to: number;
}

/** A piece of the original song as heard in the mix: [from, to) of the song, starting at `at` on the mix. */
export interface MixPiece extends Piece {
  at: number;
  /** Set when the piece comes from an event (its gain / fades / offset inside the event). */
  clip?: Clip;
  offset?: number;
}

/**
 * Front-wins resolution of overlapping events: the visible (audible) parts of
 * each event, in time order. Muted events still hide what is behind them
 * (Cubase behaviour); they are dropped from the result after resolution.
 */
export function resolveClips(clips: Clip[]): MixPiece[] {
  const edges = [...new Set(clips.flatMap((clip) => [clip.at, clip.at + clip.len]).map((value) => +value.toFixed(4)))].sort((a, b) => a - b);
  const out: MixPiece[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const a = edges[index]!;
    const b = edges[index + 1]!;
    if (b - a < 0.0005) continue;
    // Topmost = last in the list covering this span.
    let top: Clip | undefined;
    for (const clip of clips) if (clip.at <= a + 0.0001 && clip.at + clip.len >= b - 0.0001) top = clip;
    if (!top) continue;
    const previous = out[out.length - 1];
    if (previous && previous.clip === top && Math.abs(previous.at + (previous.to - previous.from) - a) < 0.0005) {
      previous.to += b - a;
      continue;
    }
    const offset = a - top.at;
    out.push({ at: a, from: top.src + offset, to: top.src + offset + (b - a), clip: top, offset });
  }
  return out.filter((piece) => !piece.clip?.muted);
}

/** The mix as pieces of the original song, placed on the mix timeline. */
export function mixPieces(duration: number, edits: AudioEdits | null | undefined): MixPiece[] {
  if (edits?.clips?.length) return resolveClips(edits.clips);
  let at = 0;
  return arrange(duration, edits?.regions ?? []).map((piece) => {
    const placed = { ...piece, at };
    at += piece.to - piece.from;
    return placed;
  });
}

/** Mix length: the end of the last sounding event (or the edited song). */
export function mixDuration(duration: number, edits: AudioEdits | null | undefined): number {
  if (edits?.clips?.length) return edits.clips.reduce((end, clip) => Math.max(end, clip.at + clip.len), 0);
  return editedDuration(duration, edits?.regions ?? []);
}

/** Every place an original-song time is heard in the mix (a copied chorus is heard twice). */
export function mixPositions(pieces: MixPiece[], time: number): number[] {
  return pieces.filter((piece) => time >= piece.from && time < piece.to).map((piece) => piece.at + (time - piece.from));
}

/** True when the events are just the untouched song (no render needed). */
export function isIdentityArrangement(duration: number, clips: Clip[] | undefined): boolean {
  if (!clips?.length) return true;
  if (clips.length !== 1) return false;
  const [clip] = clips as [Clip];
  return !clip.muted && Math.abs(clip.at) < 0.001 && Math.abs(clip.src) < 0.001 && Math.abs(clip.len - duration) < 0.02 && clip.gainDb === 0 && clip.fadeIn === 0 && clip.fadeOut === 0;
}

/** The edited timeline as pieces of the original song, in play order. */
export function arrange(duration: number, regions: Region[]): Piece[] {
  let pieces: Piece[] = [{ from: 0, to: duration }];
  const splitAt = (time: number): void => {
    pieces = pieces.flatMap((piece) => (time > piece.from + 0.001 && time < piece.to - 0.001 ? [{ from: piece.from, to: time }, { from: time, to: piece.to }] : [piece]));
  };
  const inside = (piece: Piece, range: { start: number; end: number }): boolean => piece.from >= range.start - 0.001 && piece.to <= range.end + 0.001;

  for (const region of regions.filter((item) => item.op === 'swap' && item.swapWith)) {
    const a = { start: region.start, end: region.end };
    const b = region.swapWith!;
    if (a.start < b.end && b.start < a.end) throw AppError.badRequest('Swapped sections must not overlap.');
    [a.start, a.end, b.start, b.end].forEach(splitAt);
    const groupA = pieces.filter((piece) => inside(piece, a));
    const groupB = pieces.filter((piece) => inside(piece, b));
    if (groupA.length === 0 || groupB.length === 0) continue;
    // The block that plays first moves to where the other one was, and vice versa.
    const [first, second] = pieces.indexOf(groupA[0]!) < pieces.indexOf(groupB[0]!) ? [groupA, groupB] : [groupB, groupA];
    const s1 = pieces.indexOf(first[0]!);
    const e1 = s1 + first.length;
    const s2 = pieces.indexOf(second[0]!);
    const e2 = s2 + second.length;
    pieces = [...pieces.slice(0, s1), ...second, ...pieces.slice(e1, s2), ...first, ...pieces.slice(e2)];
  }
  for (const region of regions.filter((item) => item.op === 'cut')) {
    [region.start, region.end].forEach(splitAt);
    pieces = pieces.filter((piece) => !inside(piece, region));
  }
  return pieces.filter((piece) => piece.to - piece.from > 0.01);
}

export const editedDuration = (duration: number, regions: Region[]): number => arrange(duration, regions).reduce((sum, piece) => sum + (piece.to - piece.from), 0);

/** Renders the edit list to an AAC mix and uploads it to `destKey`. Returns the mix length. */
export async function renderMix(songKey: string, edits: AudioEdits, layerKeys: Map<string, string>, destKey: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'mv-mix-'));
  try {
    const song = join(dir, 'song');
    await downloadToFile(songKey, song);
    const durationSec = await mediaDuration(song);
    const inputs = ['-i', song];
    const graph: string[] = [];
    if (edits.clips?.length) {
      const total = await clipGraph(durationSec, edits, graph);
      return await finishMix(dir, inputs, graph, edits, layerKeys, total, destKey);
    }
    const pieces = arrange(durationSec, edits.regions);
    if (pieces.length === 0) throw AppError.badRequest('The edits remove the whole song.');

    // 1. Gain regions on the original timeline (short ramps avoid clicks).
    const gains = [
      ...edits.regions
        .filter((region) => region.op === 'gain' && region.gainDb)
        .map((region) => `volume=enable='between(t,${region.start.toFixed(3)},${region.end.toFixed(3)})':volume=${Math.min(12, Math.max(-60, region.gainDb!)).toFixed(1)}dB:eval=frame`),
      // Fades: a linear ramp across the region (in: 0 → 1, out: 1 → 0).
      ...edits.regions
        .filter((region) => region.op === 'fadein' || region.op === 'fadeout')
        .map((region) => {
          const a = region.start.toFixed(3);
          const b = region.end.toFixed(3);
          const span = Math.max(0.01, region.end - region.start).toFixed(3);
          const ramp = region.op === 'fadein' ? `(t-${a})/${span}` : `(${b}-t)/${span}`;
          return `volume='if(between(t,${a},${b}),${ramp},1)':eval=frame`;
        }),
      ...(edits.gainDb ? [`volume=${Math.min(12, Math.max(-24, edits.gainDb)).toFixed(1)}dB`] : []),
    ];
    graph.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo${gains.length ? `,${gains.join(',')}` : ''},asplit=${pieces.length}${pieces.map((_, index) => `[p${index}]`).join('')}`);
    // 2. Re-order / drop pieces (cuts and swaps), with 15 ms fades at each join.
    pieces.forEach((piece, index) => {
      const length = piece.to - piece.from;
      const fade = Math.min(0.015, length / 4);
      graph.push(`[p${index}]atrim=${piece.from.toFixed(3)}:${piece.to.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fade.toFixed(3)},afade=t=out:st=${(length - fade).toFixed(3)}:d=${fade.toFixed(3)}[q${index}]`);
    });
    graph.push(`${pieces.map((_, index) => `[q${index}]`).join('')}concat=n=${pieces.length}:v=0:a=1[song]`);
    const total = pieces.reduce((sum, piece) => sum + (piece.to - piece.from), 0);
    return await finishMix(dir, inputs, graph, edits, layerKeys, total, destKey);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The event arrangement as a filter graph ending in [song]: each audible
 * piece is trimmed from the original, given its event gain + fades (on the
 * event's own clock, so a piece in the middle of a faded event fades right),
 * de-clicked at its edges, delayed to its place and summed. (Exported for tests.)
 */
export async function clipGraph(durationSec: number, edits: AudioEdits, graph: string[]): Promise<number> {
  const pieces = resolveClips(edits.clips ?? []).filter((piece) => piece.from < durationSec && piece.to - piece.from > 0.005);
  const total = mixDuration(durationSec, edits);
  if (pieces.length === 0 || total <= 0.05) throw AppError.badRequest('The arrangement has no sound: unmute or add an event.');
  const master = edits.gainDb ? `,volume=${Math.min(12, Math.max(-24, edits.gainDb)).toFixed(1)}dB` : '';
  graph.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=${pieces.length}${pieces.map((_, index) => `[p${index}]`).join('')}`);
  pieces.forEach((piece, index) => {
    const clip = piece.clip!;
    const to = Math.min(piece.to, durationSec);
    const length = to - piece.from;
    const declick = Math.min(0.01, length / 4).toFixed(3);
    const offset = (piece.offset ?? 0).toFixed(4);
    const fades: string[] = [];
    // Event fades on the event's clock: local time = t + offset.
    if (clip.fadeIn > 0.001) fades.push(`min(1,(t+${offset})/${clip.fadeIn.toFixed(4)})`);
    if (clip.fadeOut > 0.001) fades.push(`min(1,max(0,(${clip.len.toFixed(4)}-(t+${offset}))/${clip.fadeOut.toFixed(4)}))`);
    const fadeFilter = fades.length ? `,volume='${fades.join('*')}':eval=frame` : '';
    const delayMs = Math.round(piece.at * 1000);
    graph.push(
      `[p${index}]atrim=${piece.from.toFixed(4)}:${to.toFixed(4)},asetpts=PTS-STARTPTS,volume=${Math.min(12, Math.max(-60, clip.gainDb)).toFixed(2)}dB${fadeFilter}` +
        `,afade=t=in:d=${declick},afade=t=out:st=${Math.max(0, length - Number(declick)).toFixed(4)}:d=${declick},adelay=${delayMs}|${delayMs}[q${index}]`,
    );
  });
  if (pieces.length === 1) graph.push(`[q0]apad${master}[song]`);
  else graph.push(`${pieces.map((_, index) => `[q${index}]`).join('')}amix=inputs=${pieces.length}:duration=longest:normalize=0:dropout_transition=0,apad${master}[song]`);
  return total;
}

/** Layers under [song], encode to AAC, upload. */
async function finishMix(dir: string, inputs: string[], graph: string[], edits: AudioEdits, layerKeys: Map<string, string>, total: number, destKey: string): Promise<number> {
  {
    // 3. Background effect layers under the song.
    // Muted events / tracks are left out; a track's level adds to each of its events.
    const trackOf = new Map((edits.tracks ?? []).map((track) => [track.id, track]));
    const layers = edits.layers
      .filter((layer) => layerKeys.has(layer.assetId) && layer.at < total && !layer.muted && !(layer.track && trackOf.get(layer.track)?.muted))
      .map((layer) => ({ ...layer, gainDb: layer.gainDb + (layer.track ? (trackOf.get(layer.track)?.gainDb ?? 0) : 0) }));
    for (const [index, layer] of layers.entries()) {
      const file = join(dir, `layer-${index}`);
      await downloadToFile(layerKeys.get(layer.assetId)!, file);
      inputs.push('-i', file);
      const trim = layer.trimEnd > layer.trimStart ? `atrim=${layer.trimStart.toFixed(3)}:${layer.trimEnd.toFixed(3)},` : `atrim=start=${layer.trimStart.toFixed(3)},`;
      const delayMs = Math.round(layer.at * 1000);
      graph.push(
        `[${index + 1}:a]aresample=48000,aformat=channel_layouts=stereo,${trim}asetpts=PTS-STARTPTS,volume=${Math.min(12, Math.max(-60, layer.gainDb)).toFixed(1)}dB` +
          `${layer.fadeIn > 0 ? `,afade=t=in:d=${layer.fadeIn.toFixed(2)}` : ''}${layer.fadeOut > 0 ? `,areverse,afade=t=in:d=${layer.fadeOut.toFixed(2)},areverse` : ''},adelay=${delayMs}|${delayMs}[l${index}]`,
      );
    }
    const output = join(dir, 'mix.m4a');
    if (layers.length) graph.push(`[song]${layers.map((_, index) => `[l${index}]`).join('')}amix=inputs=${layers.length + 1}:duration=first:normalize=0:dropout_transition=0[out]`);
    else graph.push('[song]anull[out]');
    await ffmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', '-t', total.toFixed(3), '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', output]);
    await uploadFile(destKey, output, 'audio/mp4');
    return total;
  }
}

export interface Lyrics {
  text: string;
  lines: { start: number; end: number; text: string }[];
  language: string | null;
  /** Detected by the director (languages mixed in, pidgin). */
  languages?: { primary: string; others: string[]; pidgin: boolean; note: string } | null;
  engine: string;
}

/**
 * Prompt for the speech model: the artist's own lines (they teach it the
 * spelling / pidgin / names) plus a pidgin + ad-lib vocabulary.
 */
export function transcriptionPrompt(hint: string | undefined, languages: Lyrics['languages']): string {
  const vocabulary = 'Song lyrics. Pidgin and English mixed: dem be, dem say, I go do am later, wetin, abeg, no wahala, e don do, na so. Ehn! Oya! Chai! Haba! Yeah!';
  const language = languages ? `Languages: ${[languages.primary, ...languages.others].join(', ')}.` : '';
  // The artist's lines go last: speech models weigh the end of the prompt most.
  return [language, vocabulary, hint?.trim().slice(0, 500) ?? ''].filter(Boolean).join('\n');
}

export interface LyricsProgress {
  fraction: number;
  lines: Lyrics['lines'];
}

/**
 * Sung lyrics with timings, in 30-second pieces so progress (and the lines
 * heard so far) can be shown live. Music under the voice makes this
 * approximate; the artist corrects it afterwards.
 */
export async function transcribeSong(songKey: string, onProgress?: (progress: LyricsProgress) => void | Promise<void>, prompt?: string): Promise<Lyrics & { seconds: number }> {
  const engine = await resolveEngine('transcription');
  if (!engine) throw new Error('No transcription engine is set. A super admin can add an OpenAI or Groq key on the AI models page.');
  const dir = await mkdtemp(join(tmpdir(), 'mv-lyrics-'));
  try {
    const song = join(dir, 'song');
    await downloadToFile(songKey, song);
    // Voice band, mono 16 kHz: what speech models expect.
    const voice = join(dir, 'voice.mp3');
    await ffmpeg(['-i', song, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-af', 'highpass=f=90,lowpass=f=7500,dynaudnorm', voice]);
    const durationSec = await mediaDuration(voice);
    await ffmpeg(['-i', voice, '-f', 'segment', '-segment_time', '30', '-c', 'copy', join(dir, 'piece_%03d.mp3')]);
    const pieces = (await readdir(dir)).filter((name) => /^piece_\d{3}\.mp3$/.test(name)).sort();
    const words: { w: string; s: number; e: number }[] = [];
    const texts: string[] = [];
    let language: string | null = null;
    let offset = 0;
    for (const [index, piece] of pieces.entries()) {
      // Each piece also sees the end of the previous one, so the style carries through the song.
      const result = await transcribe([join(dir, piece)], engine, undefined, [texts.at(-1)?.slice(-300), prompt].filter(Boolean).join('\n'));
      language ??= result.language;
      texts.push(result.text);
      for (const word of result.words) words.push({ w: word.w, s: +(word.s + offset).toFixed(2), e: +(word.e + offset).toFixed(2) });
      offset += result.audioSeconds || 30;
      const lines = sentences(words).map((line) => ({ start: +line.start.toFixed(2), end: +line.end.toFixed(2), text: line.text }));
      await onProgress?.({ fraction: Math.min(0.99, (index + 1) / pieces.length), lines });
    }
    const lines = sentences(words).map((line) => ({ start: +line.start.toFixed(2), end: +line.end.toFixed(2), text: line.text }));
    return { text: texts.join(' ').trim(), lines, language, engine: engine.label, seconds: durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Uploads `count` stills from a video (spread across it) and returns their keys. */
export async function videoFrames(videoKey: string, keyFor: (index: number) => string, count = 3): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'mv-frames-'));
  try {
    const video = join(dir, 'video');
    await downloadToFile(videoKey, video);
    const { durationSec } = await probe(video);
    const out: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const at = durationSec > 1 ? (durationSec * (index + 1)) / (count + 1) : 0;
      const frame = join(dir, `frame-${index}.jpg`);
      await ffmpeg(['-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-vf', "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease", '-q:v', '3', frame]);
      const key = keyFor(index);
      await uploadFile(key, frame, 'image/jpeg');
      out.push(key);
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
