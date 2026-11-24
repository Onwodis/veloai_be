/**
 * The "director": Claude reads the creator's photos and words and produces
 *   - an identity profile (face, body frame, proportions) used in every
 *     keyframe prompt alongside the reference photos, and
 *   - a shot list: from a script (AI video) or by refining the creator's own
 *     scene descriptions (music video) into cinematic prompts.
 *
 * Creator text is passed as data inside tags; it steers content, never the
 * output format. Uses the hooks engine when it is Claude, else ANTHROPIC_API_KEY.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { env } from '../config/env.js';
import { secret } from '../vault/secrets.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { resolveEngine } from '../services/ai.service.js';
import { downloadToFile } from '../services/storage.service.js';
import { recordLlmUsage, type UsageSource } from '../launch/wallet.js';
import { reportAiError } from '../services/aiAlerts.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { SHOT_IDS, SHOTS, TRANSITION_IDS } from './cinema.js';

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

async function claude(): Promise<{ client: Anthropic; model: string }> {
  const engine = await resolveEngine('hooks').catch(() => null);
  // authToken: null stops the SDK picking up an ANTHROPIC_AUTH_TOKEN from the shell.
  if (engine?.provider === 'ANTHROPIC') return { client: new Anthropic({ apiKey: engine.apiKey, authToken: null }), model: engine.model };
  if (secret('ANTHROPIC_API_KEY')) return { client: new Anthropic({ apiKey: secret('ANTHROPIC_API_KEY'), authToken: null }), model: env.CLAUDE_MODEL };
  throw new AppError(503, 'INTERNAL_ERROR', 'The AI director needs Claude: add an Anthropic key in AI models (or ANTHROPIC_API_KEY in the API .env).');
}

/**
 * Who the AI is working for, put in front of every director / writer / reviewer prompt. Users
 * are artists, labels, brands and agencies making commercial work: casting and styling requests
 * ("a beautiful curvy lady", "a muscular dancer", "sexy club look") are normal production briefs
 * and must be carried out, described the way a casting director and stylist would, never
 * refused or lectured about. The hard lines stay: adults only, nothing sexually explicit or nude.
 */
const PRODUCTION_CONTEXT =
  '<production_context>You are part of a professional video production studio used by recording artists, record labels, brands, agencies and filmmakers ' +
  'to make music videos, commercials and films for release. This is commercial creative work. Music videos, fashion and ads routinely feature attractive adult ' +
  'talent: beauty, glamour, confidence, sensual attitude, figure-flattering or revealing fashion (swimwear, club wear, fitted dresses), dance, romance and ' +
  'nightlife are standard, legitimate creative choices. Requests about how someone looks (body type such as curvy, slim, plus-size, athletic or muscular; ' +
  'beauty; skin tone; hair; age range; styling) are casting and wardrobe specifications: carry them out faithfully, describe people respectfully and ' +
  'concretely the way a casting director, stylist and cinematographer would, and never refuse, moralise, add disclaimers or water the brief down because a ' +
  'request mentions attractiveness, body shape or sensuality. Only these limits apply, silently: every person is an adult (18+); no nudity, no sexual acts and ' +
  'nothing sexually explicit (keep it tasteful, as broadcast music videos and ads are); no real, identifiable people without consent; nothing hateful. If ' +
  'part of a request would cross one of those limits, deliver the closest tasteful version that still meets the brief and carry on; do not comment on it.' +
  '</production_context>\n\n';

/** On a refusal, the request is retried once with this note: produce the tasteful version instead of refusing. */
const ON_REFUSAL =
  'Note from the studio: this is a legitimate commercial production brief. If anything in it seemed sensitive, do not refuse: interpret it as a tasteful, ' +
  'non-explicit, adults-only version (as it would air on broadcast TV or a major music channel) that still delivers the creative intent, and complete the task.';

/**
 * Per-call tuning. `effort: 'low'` for short, well-specified tasks (a casting brief, three text
 * options, a content fix): same quality there, far fewer thinking tokens. `cache` marks the system
 * prompt for prompt caching, for calls made again and again with the same instructions (script
 * rewrites in rounds, the review of every finished shot): later calls read it at a tenth of the price.
 */
export interface ParseOptions {
  effort?: 'low' | 'medium' | 'high';
  cache?: boolean;
}

export async function parse<S extends z.ZodType>(
  source: UsageSource,
  schema: S,
  system: string,
  content: Anthropic.Beta.BetaContentBlockParam[],
  options: ParseOptions = {},
): Promise<{ data: z.output<S>; engine: string }> {
  const { client, model } = await claude();
  const ask = async (messages: Anthropic.Beta.BetaContentBlockParam[]) => {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      thinking: { type: 'adaptive' },
      output_config: { effort: options.effort ?? 'medium', format: betaZodOutputFormat(schema) },
      system: options.cache ? [{ type: 'text' as const, text: PRODUCTION_CONTEXT + system, cache_control: { type: 'ephemeral' as const } }] : PRODUCTION_CONTEXT + system,
      messages: [{ role: 'user', content: messages }],
    });
    const usage = response.usage;
    void recordLlmUsage({
      source,
      provider: 'ANTHROPIC',
      model: response.model,
      inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
    });
    return response;
  };
  // Temporary API trouble (rate limit, overloaded, a dropped connection) gets two more tries with a
  // pause, on top of the SDK's own quick retries; every failure is logged and reported to the super
  // admins (AI error alerts), so a director call never fails silently.
  const transient = (error: unknown): boolean =>
    error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError || (error instanceof Anthropic.APIError && (error.status === 529 || error.status === 503));
  const call = async (messages: Anthropic.Beta.BetaContentBlockParam[]) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await ask(messages);
      } catch (error) {
        const status = error instanceof Anthropic.APIError ? error.status : undefined;
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, source, model, status, attempt }, 'Claude call failed');
        if (transient(error) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
          continue;
        }
        // Out of API credit: nothing the user can do; the super admins get the alert to top up.
        const noCredit = /credit balance is too low|billing|insufficient.?(credit|funds|quota)/i.test(message);
        reportAiError({
          service: 'LLM (Anthropic)',
          endpoint: model,
          error: noCredit ? `Out of API credit: top up the Anthropic account (Plans & Billing). ${message}`.slice(0, 400) : `${status ?? ''} ${message}`.trim().slice(0, 400),
          where: `the ${source} director`,
        });
        if (noCredit) {
          throw new AppError(503, 'INTERNAL_ERROR', `${env.BOT_NAME} is unavailable right now (the AI service needs topping up). The team has been alerted; nothing was charged. Try again later.`);
        }
        throw new AppError(
          502,
          'INTERNAL_ERROR',
          `The AI director could not answer${status ? ` (error ${status})` : ''}: ${message.slice(0, 200)}. Try again in a minute; nothing was charged for it.`,
        );
      }
    }
  };
  let response = await call(content);
  if (response.stop_reason === 'refusal') response = await call([...content, { type: 'text', text: ON_REFUSAL }]);
  if (response.stop_reason === 'refusal') {
    throw new AppError(422, 'BAD_REQUEST', 'The AI couldn’t do this one as written, even as a tasteful version. Describe the look in styling terms (body type, wardrobe, attitude) rather than anything explicit, and try again.');
  }
  if (!response.parsed_output) throw new Error(`Claude returned nothing usable (stop_reason: ${response.stop_reason})`);
  return { data: response.parsed_output as z.output<S>, engine: `${response.model} · Anthropic` };
}

/** Downscales a stored photo to ≤1568 px JPEG (Claude's sweet spot) and base64-encodes it. */
export async function photoBlock(key: string): Promise<Anthropic.Beta.BetaImageBlockParam> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-photo-'));
  try {
    const source = join(dir, 'source');
    const out = join(dir, 'small.jpg');
    await downloadToFile(key, source);
    await ffmpeg(['-i', source, '-vf', "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '3', out]);
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await readFile(out)).toString('base64') } };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ identity */

const IdentitySchema = z.object({
  samePerson: z.boolean().describe('True when every photo shows the same single person'),
  profile: z
    .string()
    .describe(
      'Neutral physical description for an image model: apparent age range, build and body frame (shoulder width, torso, limb proportions), apparent height impression, skin tone, face shape, eyes, nose, lips, eyebrows, facial hair, hair colour/texture/length/hairline, distinctive marks, and typical clothing style. No names, no guesses about identity.',
    ),
  bestPhotos: z.array(z.number().int()).describe('Indexes (0-based) of up to 4 photos that best show the face and full body, best first'),
  notes: z.string().describe('Short advice to the creator if photos are weak (e.g. "add a full-body photo"), or empty'),
});
export type IdentityResult = z.infer<typeof IdentitySchema> & { engine: string };

const IDENTITY_SYSTEM =
  'You prepare reference descriptions so a video model can portray a creator accurately in their own music video or film. The creator uploaded these photos of themselves and confirmed consent. ' +
  'Describe only visible physical attributes, precisely and respectfully, so the generated person matches the real one: body frame and proportions matter as much as the face. ' +
  'Never identify who the person is or speculate about name, ethnicity labels, health or other sensitive traits.';

export async function analyzeIdentity(photoKeys: string[]): Promise<IdentityResult> {
  const blocks = await Promise.all(photoKeys.slice(0, 12).map((key) => photoBlock(key)));
  const content: Anthropic.Beta.BetaContentBlockParam[] = blocks.flatMap((block, index) => [{ type: 'text' as const, text: `Photo ${index}:` }, block]);
  content.push({ type: 'text', text: `These ${blocks.length} photos are of the creator. Describe them as specified.` });
  const { data, engine } = await parse('director', IdentitySchema, IDENTITY_SYSTEM, content);
  return { ...data, bestPhotos: data.bestPhotos.filter((index) => index >= 0 && index < blocks.length).slice(0, 4), engine };
}

/* ------------------------------------------------------------------ likeness (@me) */

const LikenessSchema = z.object({
  samePerson: z.boolean().describe('True when every photo and frame shows the same single person'),
  summary: z.string().describe('2-3 sentence portrait an image model can follow: age range, build, height impression, face, hair, signature look'),
  face: z.string().describe('Face shape, jaw, cheekbones, forehead, eyes (shape, colour, spacing), brows, nose, lips, ears, skin tone and texture, facial hair, distinctive marks'),
  skeleton: z.string().describe('Skeletal frame: head-to-body ratio, shoulder width vs hips, neck length, limb length relative to torso, hand and foot size impression'),
  body: z.string().describe('Build and body composition: overall frame (slim/athletic/broad/heavy), musculature, chest, waist, posture-relevant features'),
  proportions: z.string().describe('Measurable-looking proportions an artist would use: e.g. "approx 7.5 heads tall, shoulders ~2 heads wide, legs ~half of height"'),
  heightImpression: z.string().describe('Height impression; if the creator stated their height, restate it exactly and describe how it reads on camera'),
  posture: z.string().describe('Standing and sitting posture: spine, shoulder carriage, head position, weight distribution, how they hold their arms'),
  gait: z.string().describe('How they walk, from video frames if any: stride length, arm swing, pace, bounce, foot placement. "Not visible" if no walking footage'),
  hair: z.string().describe('Hair colour, texture, length, style, hairline'),
  wardrobe: z.string().describe('Typical clothing style seen, accessories, glasses'),
  bestReferences: z
    .array(z.number().int())
    .describe(
      'Indexes of up to 6 images (0-based, across all listed images) that best show the face clearly and the full body, best first. Prefer the most natural, unfiltered, least edited or retouched images over polished edited ones.',
    ),
  notes: z.string().describe('Advice if references are weak (e.g. "add a full-body photo in good light", "add a walking video"), else empty'),
});
export type LikenessResult = Omit<z.infer<typeof LikenessSchema>, 'bestReferences'> & { bestReferences: number[]; engine: string };

const LIKENESS_SYSTEM =
  'You build a precise physical reference of a person so image and video models can portray them faithfully: the creator uploaded these photos and videos of themselves and consented. ' +
  'Be concrete and measurable, like a casting sheet or a character artist’s turnaround notes: skeletal frame and proportions matter as much as the face. ' +
  'Sequential frames from the same video show movement: use them for posture and gait. ' +
  'Describe only what is visible. Never identify who the person is, and never speculate about name, ethnicity labels, health, or other sensitive traits.';

export interface LikenessImage {
  key: string;
  label: string;
}

export async function analyzeLikeness(images: LikenessImage[], context: { heightCm?: number | null | undefined; selfDescription?: string | undefined }): Promise<LikenessResult> {
  const chosen = images.slice(0, 20);
  const blocks = await Promise.all(chosen.map((image) => photoBlock(image.key)));
  const content: Anthropic.Beta.BetaContentBlockParam[] = blocks.flatMap((block, index) => [{ type: 'text' as const, text: `Image ${index} (${chosen[index]!.label}):` }, block]);
  const facts = [
    context.heightCm ? `The creator states their height is ${context.heightCm} cm. Treat this as fact.` : 'The creator did not state their height.',
    context.selfDescription ? `<creator_notes>${context.selfDescription}</creator_notes>` : '',
  ].filter(Boolean);
  content.push({ type: 'text', text: `${facts.join('\n')}\nThese ${blocks.length} images are of the creator. Build their reference as specified.` });
  const { data, engine } = await parse('likeness', LikenessSchema, LIKENESS_SYSTEM, content);
  return { ...data, bestReferences: data.bestReferences.filter((index) => index >= 0 && index < chosen.length).slice(0, 6), engine };
}

/* ------------------------------------------------------------------ prompt direction */

const DirectionSchema = z.object({
  prompt: z.string().describe('The final prompt for the model: 50-120 words, concrete subject action, setting, time of day, light, lens feel, atmosphere, wardrobe. Present tense. No quality buzzwords, no camera brand names.'),
  motion: z.string().describe('For video: the camera move and the subject’s single clear action over the clip, 15-40 words. Empty for stills.'),
  title: z.string().describe('A 2-6 word title for the creation'),
});
export type Direction = z.infer<typeof DirectionSchema> & { engine: string };

const DIRECTION_SYSTEM =
  'You are a director of photography writing prompts for photoreal AI image and video models. Turn the creator’s request into one shot that looks like a real photograph or real footage: ' +
  'motivated light, believable location, physically plausible pose, one clear action. When the request includes the creator (written @me), describe them using the reference provided so the model renders exactly that person: ' +
  'keep their face, build, height and proportions; do not beautify or change age, body or skin tone. Follow the creator’s intent; never add text, logos or extra people unless asked. ' +
  'Aim for real life, not "AI cinematic": available light, natural colour, subtle camera, real skin with pores and small imperfections, lived-in clothes and places.';

export async function directPrompt(request: {
  mode: 'IMAGE' | 'VIDEO' | 'ENHANCE';
  prompt: string;
  aspect: string;
  likeness?: string | undefined;
  triggerWord?: string | undefined;
}): Promise<Direction> {
  const lines = [
    `Output: ${request.mode === 'VIDEO' ? 'a 5-10 second video shot' : request.mode === 'ENHANCE' ? 'an edit of the attached photo (describe the finished photo)' : 'a single photograph'}, aspect ${request.aspect}.`,
    request.likeness ? `@me is the creator. Reference: ${request.likeness}` : 'The request does not include the creator.',
    request.triggerWord ? `Refer to the creator as "${request.triggerWord} person" in the prompt (a trained identity token), plus the key physical details.` : '',
    `<request>${request.prompt}</request>`,
  ];
  const { data, engine } = await parse('direction', DirectionSchema, DIRECTION_SYSTEM, [{ type: 'text', text: lines.filter(Boolean).join('\n\n') }]);
  return { ...data, engine };
}

/** True when Claude is available for direction (a missing key degrades to the raw prompt). */
export async function directorAvailable(): Promise<boolean> {
  return claude()
    .then(() => true)
    .catch(() => false);
}

/* ------------------------------------------------------------------ shot list */

const SceneSchema = z.object({
  description: z.string().describe("One or two plain sentences of what happens, in the creator's terms"),
  prompt: z
    .string()
    .describe(
      'Prompt for the video model, written like a DP describing real footage: subject action, setting, time of day, the real light source, wardrobe, subtle camera behaviour. 40-90 words. ' +
        'Real-life look with natural imperfections; no camera brand names, no quality buzzwords, no "cinematic" or "epic".',
    ),
  shot: z.enum(SHOT_IDS),
  transition: z.enum(TRANSITION_IDS).describe('Transition INTO the next scene'),
  durationSec: z.number().describe('Seconds on screen, 3-10'),
  featuresSubject: z.boolean().describe('True if the creator appears in the shot'),
  lipSync: z.boolean().describe('True only for music-video performance shots where the creator sings to camera'),
  photoIndex: z.number().int().describe('Index of the uploaded scene photo to build this shot from, or -1'),
});
const ShotListSchema = z.object({ scenes: z.array(SceneSchema) });
export type PlannedScene = z.infer<typeof SceneSchema>;

const DIRECTOR_SYSTEM =
  'You are a music-video and commercial director planning shots for photoreal AI video generation. Your goal is footage indistinguishable from a real shoot: ' +
  'grounded locations, motivated light, believable wardrobe, physically plausible action, one clear action per shot (video models fail at complex choreography), ' +
  'varied shot sizes, and aerial drone shots used for scale, establishing and reveals. Avoid crowds of detailed faces, readable signage, and fast complex hand movements. ' +
  '"@me" in the creator’s text means the creator themself: those shots feature the subject (featuresSubject true). ' +
  `Shot ids mean: ${Object.entries(SHOTS)
    .map(([id, text]) => `${id} = ${text}`)
    .join('; ')}.`;

export interface PlanRequest {
  kind: 'AI_VIDEO' | 'MUSIC_VIDEO';
  aspect: string;
  style?: string | undefined;
  identity?: string | undefined;
  /** AI video: the script / brief. */
  script?: string | undefined;
  /** Music video: what the creator wrote per scene (refine mode). */
  scenes?: { description: string; shot?: string; transition?: string; durationSec?: number }[];
  /** Target total length (song length for music videos). */
  targetSeconds?: number | undefined;
  sceneCount?: number | undefined;
  /** Captions the creator gave scene photos (index = photoIndex). */
  photoCaptions?: string[];
}

export async function planScenes(request: PlanRequest): Promise<{ scenes: PlannedScene[]; engine: string }> {
  const lines = [
    `Format: ${request.kind === 'MUSIC_VIDEO' ? 'music video' : 'short film / ad from a script'}, aspect ${request.aspect}.`,
    request.targetSeconds ? `Total running time about ${Math.round(request.targetSeconds)} seconds; scene durations should add up to it.` : '',
    request.sceneCount ? `Use ${request.sceneCount} scenes.` : '',
    request.identity ? `The creator (the subject) looks like this: ${request.identity}` : 'There may be no recurring subject.',
    request.photoCaptions?.length ? `Uploaded scene photos:\n${request.photoCaptions.map((caption, index) => `${index}: ${caption}`).join('\n')}` : 'No scene photos were uploaded (use photoIndex -1).',
    request.style ? `<style>${request.style}</style>` : '',
  ];
  if (request.scenes?.length) {
    lines.push(
      `The creator described these scenes. Keep their order, count, intent and any shot/transition/duration they chose; write the cinematic prompt and fill in what they left out:\n<creator_scenes>\n${request.scenes
        .map((scene, index) => `${index + 1}. ${scene.description}${scene.shot ? ` [shot: ${scene.shot}]` : ''}${scene.transition ? ` [transition: ${scene.transition}]` : ''}${scene.durationSec ? ` [${scene.durationSec}s]` : ''}`)
        .join('\n')}\n</creator_scenes>`,
    );
  } else {
    lines.push(`Break this into a shot list:\n<script>\n${request.script ?? ''}\n</script>`);
  }
  const { data, engine } = await parse('director', ShotListSchema, DIRECTOR_SYSTEM, [{ type: 'text', text: lines.filter(Boolean).join('\n\n') }]);
  const scenes = data.scenes.map((scene) => ({ ...scene, durationSec: Math.min(10, Math.max(3, Math.round(scene.durationSec * 2) / 2)) }));
  return { scenes, engine };
}
