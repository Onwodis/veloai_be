/**
 * Hook detection: choose the moments worth turning into reels.
 *
 * Engine (chosen by the super admin on the Models page):
 *   - Anthropic Claude: structured outputs via the SDK, adaptive thinking,
 *     server-side refusal fallback on models that support it
 *   - OpenAI / Groq / any OpenAI-compatible model: Chat Completions with a
 *     strict JSON schema (JSON mode as a fallback), validated with zod
 *   - none: a transparent heuristic scorer (questions, numbers, direct
 *     address, speech energy)
 * The engine log on each project records which one ran.
 *
 * Either way, every pick is snapped to sentence boundaries, clamped to the
 * target length and de-overlapped before rendering.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { recordLlmUsage } from '../launch/wallet.js';
import type { ResolvedEngine } from '../services/ai.service.js';
import { logger } from '../utils/logger.js';
import type { Beat, BeatKind } from './edit.js';
import type { Word } from './transcribe.js';

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

export interface ClipPick {
  start: number;
  end: number;
  title: string;
  hook: string;
  score: number;
  caption: string;
  hashtags: string[];
  /** On-screen hook headline for the first seconds. */
  hookText: string;
  /** Flashpoints (source seconds), resolved to exact word times. */
  beats: Beat[];
}

export interface HookResult {
  clips: ClipPick[];
  engine: string;
  llmInputTokens: number;
  llmOutputTokens: number;
}

/** Groups words into sentences on terminal punctuation or pauses > 0.9 s. */
export function sentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let current: Word[] = [];
  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) out.push({ start: first.s, end: last.e, text: current.map((word) => word.w).join(' ') });
    current = [];
  };
  words.forEach((word, index) => {
    current.push(word);
    const next = words[index + 1];
    const pause = next ? next.s - word.e : 0;
    if (/[.!?…]["')\]]?$/.test(word.w) || pause > 0.9 || current.length >= 40) flush();
  });
  flush();
  return out;
}

/* ------------------------------------------------------------------ shared brief */

const ClipSchema = z.object({
  clips: z.array(
    z.object({
      start: z.number().describe('Clip start in seconds; must be the start time of a listed sentence'),
      end: z.number().describe('Clip end in seconds; must be the end time of a listed sentence'),
      title: z.string().describe('Punchy on-screen title, max 70 characters'),
      hook: z.string().describe('One sentence: why the first 3 seconds stop the scroll'),
      score: z.number().int().describe('Predicted hook strength 0-100'),
      caption: z.string().describe('Post caption for TikTok/Reels/Shorts, max 220 characters, no hashtags'),
      hashtags: z.array(z.string()).describe('3-6 relevant hashtags without the # sign'),
      hookText: z.string().describe('On-screen hook headline shown over the first 3 seconds: max 7 words, curiosity or a bold claim, not a summary'),
      beats: z
        .array(
          z.object({
            t: z.number().describe('Approximate time in seconds of the emphasised word (inside the clip)'),
            word: z.string().describe('The emphasised word exactly as spoken'),
            kind: z
              .enum(['zoom', 'flash', 'shake', 'bw', 'text'])
              .describe('zoom: punch-in on a key word; flash: white flash on a reveal or punchline; shake: impact/energy; bw: dramatic black-and-white hit; text: pop the word(s) big on screen'),
            text: z.string().describe('For kind=text: 1-3 words to show (a number, key term). Otherwise empty.'),
          }),
        )
        .describe('4-10 flashpoints across the clip: key claims, numbers, punchlines, emotional peaks. Not in the first second.'),
    }),
  ),
});

const SYSTEM = [
  'You are a senior short-form video editor. You pick moments from long recordings that will perform as standalone vertical reels on TikTok, Instagram Reels and YouTube Shorts.',
  'A strong clip opens with a hook in its first sentence (a bold claim, a surprising number, a question, conflict, or a story beat), stays on one idea, and ends on a payoff rather than mid-thought.',
  'Each clip must make sense to someone who has not seen the rest of the recording.',
  'Use only the timestamps of the listed sentences: a clip starts at some sentence start and ends at some sentence end. Clips must not overlap.',
  'Write titles, captions, hook headlines and hashtags in the language of the transcript.',
  'You also direct the edit: give each clip a scroll-stopping hook headline and mark its flashpoints (the exact words to punch in on, flash, shake or pop on screen), like a professional editor cutting for retention.',
].join(' ');

/** Everything a picker needs besides the sentences. */
interface PickRequest {
  count: number;
  targetSeconds: number;
  language: string | null;
  /** The creator's free-text directions, if any. */
  directions?: string | undefined;
}

function brief(all: Sentence[], request: PickRequest): string {
  const { count, targetSeconds, language, directions } = request;
  const transcript = all.map((sentence) => `[${sentence.start.toFixed(1)}-${sentence.end.toFixed(1)}] ${sentence.text}`).join('\n');
  // The creator's text is data inside tags: it steers taste, never the output rules.
  const steer = directions?.trim()
    ? `\n\nThe creator gave these directions for their reels. Follow them when choosing moments and writing titles and captions, as long as they don't conflict with the timestamp and format rules:\n<creator_directions>\n${directions.trim()}\n</creator_directions>`
    : '';
  return `Transcript (${language ?? 'unknown language'}), one sentence per line as [start-end] text, times in seconds:\n\n${transcript}${steer}\n\nPick the ${count} best clips, each about ${targetSeconds} seconds long (acceptable range ${Math.round(targetSeconds * 0.5)}-${Math.round(targetSeconds * 1.6)} seconds). Order them from strongest to weakest.`;
}

const cleanTags = (clips: ClipPick[]): ClipPick[] => clips.map((clip) => ({ ...clip, hashtags: clip.hashtags.map((tag) => tag.replace(/^#/, '')) }));

type ModelClip = z.infer<typeof ClipSchema>['clips'][number];
/** Model beats carry the spoken word; the exact time is resolved against the transcript later. */
const fromModel = (clip: ModelClip): ClipPick => ({
  ...clip,
  hookText: clip.hookText.slice(0, 80),
  beats: clip.beats.map((beat) => ({ t: beat.t, kind: beat.kind as BeatKind, text: beat.kind === 'text' ? beat.text.slice(0, 24) : beat.word })),
});

const norm = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Snaps each beat to the start of the nearest matching spoken word (within 3 s). */
function resolveBeats(beats: Beat[], words: Word[], clip: { start: number; end: number }): Beat[] {
  return beats
    .map((beat) => {
      const target = norm(beat.kind === 'text' ? ((beat.text ?? '').split(/\s+/)[0] ?? '') : (beat.text ?? ''));
      const match = words
        .filter((word) => Math.abs(word.s - beat.t) <= 3 && word.s >= clip.start && word.s <= clip.end && (!target || norm(word.w) === target))
        .sort((a, b) => Math.abs(a.s - beat.t) - Math.abs(b.s - beat.t))[0];
      return { ...beat, t: match ? match.s : beat.t, text: beat.kind === 'text' ? beat.text : undefined };
    })
    .filter((beat) => beat.t > clip.start + 0.8 && beat.t < clip.end - 0.3);
}

/** Short headline from a sentence (heuristic picks). */
const headline = (text: string): string => {
  const words = text.replace(/[.,;:]+$/, '').split(/\s+/);
  return words.length > 7 ? `${words.slice(0, 7).join(' ')}…` : words.join(' ');
};

/* ------------------------------------------------------------------ Claude */

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

async function pickWithClaude(engine: ResolvedEngine, all: Sentence[], request: PickRequest): Promise<HookResult> {
  // authToken: null stops the SDK picking up an ANTHROPIC_AUTH_TOKEN from the shell.
  const client = new Anthropic({ apiKey: engine.apiKey, authToken: null });
  const withFallback = FALLBACK_MODELS.has(engine.model);
  const response = await client.beta.messages.parse({
    model: engine.model,
    max_tokens: 16000,
    ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: betaZodOutputFormat(ClipSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: brief(all, request) }],
  });
  const inputTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
  void recordLlmUsage({ source: 'hooks', provider: 'ANTHROPIC', model: response.model, inputTokens, outputTokens: response.usage.output_tokens });

  if (response.stop_reason === 'refusal') throw new Error(`Claude declined the transcript (${response.stop_details?.category ?? 'no category'})`);
  if (!response.parsed_output) throw new Error(`Claude returned no clip list (stop_reason: ${response.stop_reason})`);

  return {
    clips: cleanTags(response.parsed_output.clips.map(fromModel)),
    engine: `${response.model} · Anthropic (structured output, adaptive thinking)`,
    llmInputTokens: inputTokens,
    llmOutputTokens: response.usage.output_tokens,
  };
}

/* ------------------------------------------------------------------ OpenAI-compatible */

/** JSON Schema for strict structured outputs (every field required, no extras). */
const CLIP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clips'],
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'title', 'hook', 'score', 'caption', 'hashtags', 'hookText', 'beats'],
        properties: {
          start: { type: 'number', description: 'Clip start in seconds; the start time of a listed sentence' },
          end: { type: 'number', description: 'Clip end in seconds; the end time of a listed sentence' },
          title: { type: 'string', description: 'Punchy on-screen title, max 70 characters' },
          hook: { type: 'string', description: 'One sentence: why the first 3 seconds stop the scroll' },
          score: { type: 'integer', description: 'Predicted hook strength 0-100' },
          caption: { type: 'string', description: 'Post caption, max 220 characters, no hashtags' },
          hashtags: { type: 'array', items: { type: 'string' }, description: '3-6 hashtags without #' },
          hookText: { type: 'string', description: 'On-screen hook headline for the first 3 seconds, max 7 words' },
          beats: {
            type: 'array',
            description: '4-10 flashpoints: key words to punch in on, flash, shake, black-and-white hit, or pop as text',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['t', 'word', 'kind', 'text'],
              properties: {
                t: { type: 'number' },
                word: { type: 'string' },
                kind: { type: 'string', enum: ['zoom', 'flash', 'shake', 'bw', 'text'] },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

async function chat(engine: ResolvedEngine, body: Record<string, unknown>): Promise<{ status: number; data: ChatResponse }> {
  const response = await fetch(`${engine.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${engine.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const data = (await response.json().catch(() => ({}))) as ChatResponse;
  if (data.usage) {
    void recordLlmUsage({ source: 'hooks', provider: engine.provider, model: data.model ?? engine.model, inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 });
  }
  return { status: response.status, data };
}

async function pickWithOpenAICompatible(engine: ResolvedEngine, all: Sentence[], request: PickRequest): Promise<HookResult> {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: brief(all, request) },
  ];
  let mode = 'strict JSON schema';
  let { status, data } = await chat(engine, { model: engine.model, messages, response_format: { type: 'json_schema', json_schema: { name: 'clip_picks', strict: true, schema: CLIP_JSON_SCHEMA } } });

  // Some models/providers don't support strict schemas: retry in JSON mode.
  if (status === 400 && /response_format|json_schema|schema/i.test(data.error?.message ?? '')) {
    mode = 'JSON mode';
    ({ status, data } = await chat(engine, {
      model: engine.model,
      messages: [...messages, { role: 'user', content: 'Respond with only a JSON object of the form {"clips":[{"start":0,"end":0,"title":"","hook":"","score":0,"caption":"","hashtags":[""],"hookText":"","beats":[{"t":0,"word":"","kind":"zoom","text":""}]}]}.' }],
      response_format: { type: 'json_object' },
    }));
  }
  if (status >= 400) throw new Error(`${engine.model} request failed (HTTP ${status}): ${data.error?.message?.slice(0, 200) ?? 'no detail'}`);

  const message = data.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`${engine.model} declined the transcript: ${message.refusal.slice(0, 160)}`);
  const parsed = ClipSchema.safeParse(JSON.parse(message?.content ?? '{}'));
  if (!parsed.success) throw new Error(`${engine.model} returned clips in an unexpected shape`);

  return {
    clips: cleanTags(parsed.data.clips.map(fromModel)),
    engine: `${data.model ?? engine.model} · ${engine.label.split(' · ')[1] ?? 'OpenAI-compatible'} (${mode})`,
    llmInputTokens: data.usage?.prompt_tokens ?? 0,
    llmOutputTokens: data.usage?.completion_tokens ?? 0,
  };
}

/* ------------------------------------------------------------------ heuristic */

const POWER = /\b(secret|mistake|never|always|truth|crazy|insane|best|worst|why|how|stop|biggest|nobody|everyone|money|million|free|hack|lesson|wrong)\b/i;
const STOP = new Set('the a an and or but to of in on for with is are was were be been it this that i you we they he she my your our their so just like very really have has had do does did not no yes'.split(' '));

/** Content words (5+ letters, not stop words), lower-cased. */
const contentWords = (text: string): string[] =>
  [...text.toLowerCase().matchAll(/[a-z][a-z'-]{4,}/g)].map((match) => match[0]).filter((word) => !STOP.has(word));

function topTags(text: string, count: number): string[] {
  const counts = contentWords(text).reduce((map, word) => map.set(word, (map.get(word) ?? 0) + 1), new Map<string, number>());
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([word]) => word.replace(/[^a-z0-9]/g, ''));
}

/** Scores every candidate window; detectHooks keeps the best non-overlapping ones. */
function heuristic(all: Sentence[], targetSeconds: number, directions?: string): HookResult {
  // Topics named in the directions nudge matching windows up.
  const wanted = new Set(directions ? contentWords(directions) : []);
  const candidates: ClipPick[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const first = all[i];
    if (!first) continue;
    let j = i;
    while (j + 1 < all.length && (all[j + 1]?.end ?? 0) - first.start <= targetSeconds * 1.25) j += 1;
    const last = all[j];
    if (!last || last.end - first.start < targetSeconds * 0.5) continue;
    const span = all.slice(i, j + 1);
    const text = span.map((sentence) => sentence.text).join(' ');
    const wordsPerSec = text.split(/\s+/).length / Math.max(1, last.end - first.start);
    let score = 40;
    if (/\?/.test(first.text)) score += 15;
    if (/\d/.test(first.text)) score += 10;
    if (POWER.test(first.text)) score += 12;
    if (/\byou\b/i.test(first.text)) score += 6;
    if (/!/.test(text)) score += 4;
    score += Math.min(13, Math.max(0, (wordsPerSec - 2) * 8));
    if (wanted.size) score += Math.min(24, new Set(contentWords(text).filter((word) => wanted.has(word))).size * 8);
    const tags = topTags(text, 4);
    candidates.push({
      start: first.start,
      end: last.end,
      title: first.text.length > 70 ? `${first.text.slice(0, 67).trimEnd()}…` : first.text,
      hook: wanted.size ? 'Matches your directions and opens strongly (heuristic scoring).' : 'Opens on a question, number or strong claim (heuristic scoring).',
      score: Math.min(99, Math.round(score)),
      caption: text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text,
      hashtags: tags,
      hookText: headline(first.text),
      beats: [],
    });
  }
  return { clips: candidates.sort((a, b) => b.score - a.score), engine: 'heuristic scorer', llmInputTokens: 0, llmOutputTokens: 0 };
}

/* ------------------------------------------------------------------ normalise */

function snap(pick: ClipPick, all: Sentence[], targetSeconds: number, duration: number): ClipPick | null {
  if (all.length === 0) return null;
  const startSentence = all.reduce((best, sentence) => (Math.abs(sentence.start - pick.start) < Math.abs(best.start - pick.start) ? sentence : best));
  let endSentence = all.reduce((best, sentence) => (Math.abs(sentence.end - pick.end) < Math.abs(best.end - pick.end) ? sentence : best));
  const max = targetSeconds * 1.6;
  if (endSentence.end - startSentence.start > max) {
    endSentence = [...all].reverse().find((sentence) => sentence.end <= startSentence.start + max && sentence.end > startSentence.start) ?? endSentence;
  }
  const start = Math.max(0, startSentence.start - 0.15);
  const end = Math.min(duration, endSentence.end + 0.35);
  if (end - start < Math.max(5, targetSeconds * 0.35)) return null;
  return { ...pick, start: +start.toFixed(2), end: +end.toFixed(2), score: Math.max(0, Math.min(100, Math.round(pick.score))) };
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface HookOptions {
  count: number;
  targetSeconds: number;
  durationSec: number;
  language: string | null;
  /** Creator's free-text directions for the AI (and keyword boost for the heuristic). */
  directions?: string | undefined;
  /** `clip` lines from the reel script: always become reels, exactly as cut. */
  forced?: (TimeRange & { title?: string | undefined })[];
  /** `skip` lines: never used. */
  skips?: TimeRange[];
}

const overlaps = (a: TimeRange, b: TimeRange): boolean => a.start < b.end && b.start < a.end;

/** Title, caption and tags for a clip the creator chose themselves. */
function describeForced(clip: TimeRange & { title?: string | undefined }, all: Sentence[]): ClipPick {
  const text = all.filter((sentence) => overlaps(sentence, clip)).map((sentence) => sentence.text).join(' ');
  const first = all.find((sentence) => overlaps(sentence, clip))?.text ?? '';
  const fallbackTitle = first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
  return {
    start: clip.start,
    end: clip.end,
    title: clip.title ?? (fallbackTitle || 'Your clip'),
    hook: 'Chosen by you in the reel script.',
    score: 100,
    caption: text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text,
    hashtags: topTags(text, 4),
    hookText: clip.title ?? headline(first),
    beats: [],
  };
}

/** `count` contiguous parts of the pickable speech, each at least 4 s, cut between words. */
function partition(words: Word[], pickable: Sentence[], count: number, duration: number): ClipPick[] {
  const inside = words.filter((word) => pickable.some((sentence) => word.s >= sentence.start - 0.05 && word.e <= sentence.end + 0.05));
  if (inside.length < count * 2) return [];
  const first = inside[0]!.s;
  const span = inside[inside.length - 1]!.e - first;
  const parts: ClipPick[] = [];
  let from = 0;
  for (let part = 0; part < count; part += 1) {
    const cutAt = first + (span * (part + 1)) / count;
    let to = from;
    while (to + 1 < inside.length && (part === count - 1 || inside[to + 1]!.e <= cutAt)) to += 1;
    const slice = inside.slice(from, to + 1);
    from = to + 1;
    const head = slice[0];
    const tail = slice[slice.length - 1];
    if (!head || !tail) continue;
    const start = Math.max(0, head.s - 0.15);
    const end = Math.min(duration, tail.e + 0.35);
    if (end - start < 4) continue;
    const text = slice.map((word) => word.w).join(' ');
    parts.push({
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      title: text.length > 70 ? `${text.slice(0, 67).trimEnd()}…` : text,
      hook: `Part ${part + 1} of ${count}: the speech split evenly so every requested reel is made.`,
      score: Math.max(30, 60 - part * 5),
      caption: text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text,
      hashtags: topTags(text, 4),
      hookText: headline(text),
      beats: [],
    });
  }
  return parts;
}

export async function detectHooks(words: Word[], options: HookOptions, engine: ResolvedEngine | null): Promise<HookResult> {
  const all = sentences(words);
  const forced = (options.forced ?? [])
    .filter((clip) => clip.start < options.durationSec - 1)
    .map((clip) => ({ ...clip, end: Math.min(clip.end, options.durationSec) }))
    .slice(0, options.count);
  const fixed = forced.map((clip) => describeForced(clip, all));
  const remaining = options.count - fixed.length;
  if (remaining <= 0) return { clips: fixed, engine: 'your reel script (every reel was chosen by you)', llmInputTokens: 0, llmOutputTokens: 0 };

  // The pickers only ever see sentences outside skipped and already-chosen ranges.
  const blocked: TimeRange[] = [...(options.skips ?? []), ...forced];
  const pickable = all.filter((sentence) => !blocked.some((range) => overlaps(sentence, range)));
  if (pickable.length === 0) {
    if (fixed.length) return { clips: fixed, engine: 'your reel script (no other speech left to pick from)', llmInputTokens: 0, llmOutputTokens: 0 };
    throw new Error(all.length ? 'Every part with speech is skipped by your reel script.' : 'No speech was found in this video, so there is nothing to cut reels from.');
  }

  // Short videos: shrink the clip length so the requested number of reels fits.
  const speechSpan = Math.max(1, (pickable[pickable.length - 1]?.end ?? options.durationSec) - (pickable[0]?.start ?? 0));
  const targetSeconds = Math.max(6, Math.min(options.targetSeconds, Math.floor(speechSpan / remaining)));
  const request: PickRequest = { count: remaining, targetSeconds, language: options.language, directions: options.directions };
  let result: HookResult;
  if (engine) {
    try {
      result = engine.provider === 'ANTHROPIC' ? await pickWithClaude(engine, pickable, request) : await pickWithOpenAICompatible(engine, pickable, request);
    } catch (error) {
      // The job still produces reels; the engine log records why the AI pick fell back.
      logger.error({ err: error, model: engine.model }, 'AI hook detection failed; using heuristic picker');
      // `targetSeconds` here is the shrunk length: with the creator's original
      // length a short video only ever has room for one window.
      result = { ...heuristic(pickable, targetSeconds, options.directions), engine: `heuristic scorer (${engine.model} failed: ${error instanceof Error ? error.message.slice(0, 120) : 'error'})` };
    }
  } else {
    result = { ...heuristic(pickable, targetSeconds, options.directions), engine: 'heuristic scorer (no AI model selected for hooks)' };
  }

  // Snap, then keep the best picks that clear the creator's clips and skips.
  const chosen: ClipPick[] = [...fixed];
  const picks = result.clips
    .map((clip) => snap(clip, pickable, targetSeconds, options.durationSec))
    .filter((clip): clip is ClipPick => clip !== null)
    .sort((a, b) => b.score - a.score);
  for (const pick of picks) {
    if (chosen.length >= options.count) break;
    if (chosen.some((other) => overlaps(pick, other)) || blocked.some((range) => overlaps(pick, range))) continue;
    chosen.push(pick);
  }
  // Not enough separate moments (short video): add the best alternative cuts,
  // windows that start or end clearly elsewhere, from the AI picks first and
  // then from every sentence window.
  if (chosen.length < options.count) {
    const windows = heuristic(pickable, targetSeconds, options.directions)
      .clips.map((clip) => snap(clip, pickable, targetSeconds, options.durationSec))
      .filter((clip): clip is ClipPick => clip !== null);
    for (const pick of [...picks, ...windows]) {
      if (chosen.length >= options.count) break;
      if (blocked.some((range) => overlaps(pick, range))) continue;
      if (chosen.some((other) => Math.abs(other.start - pick.start) < 2 || Math.abs(other.end - pick.end) < 1.5)) continue;
      chosen.push({ ...pick, hook: `${pick.hook} (alternative cut)` });
    }
  }
  // Still short (very little speech, few sentence breaks): split the speech
  // into the requested number of back-to-back parts on word boundaries, so
  // the creator always gets the number of reels they asked for.
  if (chosen.length < options.count) {
    for (const part of partition(words, pickable, options.count, options.durationSec)) {
      if (chosen.length >= options.count) break;
      if (blocked.some((range) => overlaps(part, range))) continue;
      if (chosen.some((other) => Math.abs(other.start - part.start) < 1 && Math.abs(other.end - part.end) < 1)) continue;
      chosen.push(part);
    }
  }
  chosen.sort((a, b) => b.score - a.score);
  for (const clip of chosen) clip.beats = resolveBeats(clip.beats, words, clip);
  const steering = [options.directions?.trim() ? 'your directions' : '', fixed.length ? `${fixed.length} clip(s) from your script` : ''].filter(Boolean).join(' + ');
  return { ...result, clips: chosen, engine: steering ? `${result.engine} · ${steering}` : result.engine };
}
