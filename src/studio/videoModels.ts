/**
 * Video models: what the app can film with, how each one is called, how each has performed, and
 * which the super admin has switched on.
 *
 *   catalog      Kling 2.1 Master, Kling O1 (reference), Seedance 1.0 Pro, 2.0, 2.5: endpoints per
 *                job, clip lengths, resolution, native audio, lip sync, references, price
 *   jobs         imageToVideo (a shot from its first frame), textToVideo (no first frame),
 *                referenceVideo (music-video shots with cast: start frame + identity photos, and
 *                for Seedance 2.x the shot's vocal as @Audio1 so the mouth follows the song)
 *   requests     each family's body (Seedance takes no negative_prompt; durations are strings)
 *   measured     from the takes themselves: success, render time, picked by the artist, the
 *                director's review score and flags, cost
 *   advice       the best switched-on model per job, from the measurements when there are enough,
 *                else from what each model is built for (and it says so)
 * The model in use for a job is still settings.models[job] (studio settings); "use this model"
 * writes the catalog entry there, so every renderer keeps reading one place.
 */
import { z } from 'zod';
import { getStudioSettings, saveStudioSettings, type StudioModel } from './settings.js';
import { json, sql } from './sql.js';

export const VIDEO_JOBS = ['imageToVideo', 'textToVideo', 'referenceVideo'] as const;
export type VideoJob = (typeof VIDEO_JOBS)[number];
export const JOB_LABEL: Record<VideoJob, string> = {
  imageToVideo: 'Image → video (shots from a first frame)',
  textToVideo: 'Text → video (shots without a first frame)',
  referenceVideo: 'Performance shots with cast (identity references, lip sync)',
};

export type VideoFamily = 'kling' | 'seedance1' | 'seedance2' | 'grok' | 'other';
export const videoFamily = (endpoint: string): VideoFamily =>
  /seedance-2\./.test(endpoint) ? 'seedance2' : /seedance\/v1\//.test(endpoint) ? 'seedance1' : /kling/.test(endpoint) ? 'kling' : /grok-imagine/.test(endpoint) ? 'grok' : 'other';

export interface VideoModelInfo {
  id: string;
  name: string;
  vendor: string;
  jobs: Partial<Record<VideoJob, Pick<StudioModel, 'endpoint' | 'durations' | 'extra'>>>;
  maxSeconds: number;
  resolution: string;
  /** Generates sound (effects, ambience, speech) with the picture. */
  nativeAudio: boolean;
  lipSync: string;
  /** Reference images it takes (identity / style). */
  references: number;
  /** USD per second at the resolution set, as published by fal (null = not published; check fal.ai/pricing). */
  usdPerSecond: number | null;
  priceNote: string;
  strengths: string[];
  watchOuts: string[];
}

const KLING_I2V = 'fal-ai/kling-video/v2.1/master/image-to-video';
const S2 = (version: '2.0' | '2.5', job: 'image' | 'text' | 'reference'): string => `bytedance/seedance-${version}/us/${job}-to-video`;

export const VIDEO_MODELS: VideoModelInfo[] = [
  {
    id: 'kling-2.1-master',
    name: 'Kling 2.1 Master',
    vendor: 'Kuaishou',
    jobs: {
      imageToVideo: { endpoint: KLING_I2V, durations: ['5', '10'], extra: { cfg_scale: 0.5 } },
      textToVideo: { endpoint: 'fal-ai/kling-video/v2.1/master/text-to-video', durations: ['5', '10'], extra: { cfg_scale: 0.5 } },
    },
    maxSeconds: 10,
    resolution: '1080p',
    nativeAudio: false,
    lipSync: 'None built in: the lip-sync pass draws the mouth afterwards',
    references: 1,
    usdPerSecond: 0.28,
    priceNote: 'about $1.40 per 5 s clip (fal list price; confirm on fal.ai/pricing)',
    strengths: ['Very stable faces and bodies from a first frame', 'Realistic motion and physics', 'The current default: proven in this app'],
    watchOuts: ['5 or 10 s only', 'No sound', 'Honours negative prompts (Seedance does not)'],
  },
  {
    id: 'kling-o1-reference',
    name: 'Kling O1 reference',
    vendor: 'Kuaishou',
    jobs: { referenceVideo: { endpoint: 'fal-ai/kling-video/o1/reference-to-video', durations: ['3', '4', '5', '6', '7', '8', '9', '10'], extra: {} } },
    maxSeconds: 10,
    resolution: '1080p',
    nativeAudio: false,
    lipSync: 'None built in: the lip-sync pass draws the mouth afterwards',
    references: 7,
    usdPerSecond: null,
    priceNote: 'not shown here: check fal.ai/pricing',
    strengths: ['Each character’s photos ride along as an identity element: faces hold to the last frame', 'Start frame + up to 3 people'],
    watchOuts: ['7 images in all (start frame included)', 'Lip sync only from the separate pass'],
  },
  {
    id: 'seedance-1-pro',
    name: 'Seedance 1.0 Pro',
    vendor: 'ByteDance',
    jobs: {
      imageToVideo: { endpoint: 'fal-ai/bytedance/seedance/v1/pro/image-to-video', durations: ['3', '4', '5', '6', '8', '10', '12'], extra: { resolution: '1080p', camera_fixed: false } },
      textToVideo: { endpoint: 'fal-ai/bytedance/seedance/v1/pro/text-to-video', durations: ['3', '4', '5', '6', '8', '10', '12'], extra: { resolution: '1080p', camera_fixed: false } },
    },
    maxSeconds: 12,
    resolution: '1080p',
    nativeAudio: false,
    lipSync: 'None built in: the lip-sync pass draws the mouth afterwards',
    references: 1,
    usdPerSecond: null,
    priceNote: 'not shown on the model page: check fal.ai/pricing',
    strengths: ['Sharp 1080p', 'Any length from 2 to 12 s', 'Strong camera language (dolly, tracking, handheld)'],
    watchOuts: ['No negative prompt', 'No sound'],
  },
  {
    id: 'seedance-2.0',
    name: 'Seedance 2.0',
    vendor: 'ByteDance',
    jobs: {
      imageToVideo: { endpoint: S2('2.0', 'image'), durations: ['4', '5', '6', '8', '10', '12', '15'], extra: { resolution: '1080p', generate_audio: false } },
      textToVideo: { endpoint: S2('2.0', 'text'), durations: ['4', '5', '6', '8', '10', '12', '15'], extra: { resolution: '1080p', generate_audio: false } },
      referenceVideo: { endpoint: S2('2.0', 'reference'), durations: ['4', '5', '6', '8', '10', '12', '15'], extra: { resolution: '1080p', generate_audio: false } },
    },
    maxSeconds: 15,
    resolution: 'up to 4K',
    nativeAudio: true,
    lipSync: 'Native: the shot’s vocal goes in as @Audio1 and the mouth follows it (fal: "test lip-sync quality against your standards")',
    references: 9,
    usdPerSecond: 0.3,
    priceNote: '$0.30/s at 720p (fal guide, Apr 2026); 1080p costs more',
    strengths: ['Picture and sound generated together', 'Multi-shot prompts ("Shot 1:", "Shot 2:")', 'Up to 9 reference images + 3 audio clips'],
    watchOuts: ['No negative prompt', 'Native lip sync is unproven for singing: keep the lip-sync pass on until compared', 'Reference audio ≤ 15 s in all'],
  },
  {
    id: 'seedance-2.5',
    name: 'Seedance 2.5',
    vendor: 'ByteDance',
    jobs: {
      imageToVideo: { endpoint: S2('2.5', 'image'), durations: ['4', '5', '6', '8', '10', '12', '15', '20', '30'], extra: { resolution: '1080p', generate_audio: false } },
      textToVideo: { endpoint: S2('2.5', 'text'), durations: ['4', '5', '6', '8', '10', '12', '15', '20', '30'], extra: { resolution: '1080p', generate_audio: false } },
      referenceVideo: { endpoint: S2('2.5', 'reference'), durations: ['4', '5', '6', '8', '10', '12', '15', '20', '30'], extra: { resolution: '1080p', generate_audio: false } },
    },
    maxSeconds: 30,
    resolution: 'up to 4K',
    nativeAudio: true,
    lipSync: 'Native: performers lip-sync to the track given as an audio reference (vendor showcase); the shot’s vocal goes in as @Audio1',
    references: 30,
    usdPerSecond: null,
    priceNote: 'separate pricing, not published on the model page: check fal.ai/pricing',
    strengths: ['Native 30-second shots', 'Timed shot lists in one prompt', 'Up to 30 reference images and 10 audio clips', 'Lip sync in major languages (vendor claim)'],
    watchOuts: ['No negative prompt', 'Image-to-video takes the frame’s aspect only', 'Newest: measure it here before making it the default'],
  },
];

export const modelById = (id: string): VideoModelInfo | undefined => VIDEO_MODELS.find((model) => model.id === id);
/** The catalog model behind an endpoint (null = a custom endpoint the admin typed). */
export const modelByEndpoint = (endpoint: string): VideoModelInfo | null => VIDEO_MODELS.find((model) => Object.values(model.jobs).some((job) => job?.endpoint === endpoint)) ?? null;

/* ------------------------------------------------------------------ requests */

/** Seedance has no negative prompt: the most important "avoid" items join the prompt instead. */
function withAvoid(prompt: string, negative: string): string {
  const avoid = negative
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
  return avoid.length ? `${prompt} Avoid: ${avoid.join(', ')}.` : prompt;
}

/** The body for a plain animation call (a first frame, or none), in the model's own shape. */
export function animationRequest(model: Pick<StudioModel, 'endpoint' | 'extra'>, input: { prompt: string; negative: string; duration: string | null; imageUrl: string | null; aspect: string }): Record<string, unknown> {
  const family = videoFamily(model.endpoint);
  const duration = input.duration ? { duration: input.duration } : {};
  if (family === 'seedance1' || family === 'seedance2') {
    return {
      ...model.extra,
      prompt: withAvoid(input.prompt, input.negative),
      ...duration,
      // Seedance image-to-video takes its shape from the frame (2.5 accepts only "auto").
      ...(input.imageUrl ? { image_url: input.imageUrl } : { aspect_ratio: input.aspect }),
    };
  }
  return { ...model.extra, prompt: input.prompt, negative_prompt: input.negative, ...duration, ...(input.imageUrl ? { image_url: input.imageUrl } : { aspect_ratio: input.aspect }) };
}

/**
 * Seedance 2.x reference-to-video: the start frame and each character's photos as @Image tags,
 * and (performance shots) the shot's isolated vocal as @Audio1 so the singer's mouth follows it.
 */
export function seedanceReferenceRequest(
  model: Pick<StudioModel, 'endpoint' | 'extra'>,
  input: { frameUrl: string; people: { name: string; urls: string[] }[]; prompt: (references: string) => string; negative: string; duration: string | null; aspect: string; vocalUrl: string | null; singer: string | null },
): Record<string, unknown> {
  const limit = /seedance-2\.0/.test(model.endpoint) ? 9 : 12;
  const people = input.people.slice(0, 4);
  const per = Math.max(1, Math.min(3, Math.floor((limit - 1) / Math.max(1, people.length))));
  const urls = [input.frameUrl];
  const named = people.map((person) => {
    const tags = person.urls.slice(0, per).map((url) => {
      urls.push(url);
      return `@Image${urls.length}`;
    });
    return `${person.name} is the person in ${tags.join(', ')}`;
  });
  const references = [
    '@Image1 is the opening frame: keep its framing, place, light and wardrobe.',
    named.length ? `${named.join('; ')}; each keeps exactly that face, bone structure, skin tone and hair in every frame.` : '',
    input.vocalUrl ? `@Audio1 is the vocal of this moment of the song: ${input.singer ?? 'the lead'} sings it on camera, lips, jaw and breath matching every word exactly in time; nobody else sings.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...model.extra,
    prompt: withAvoid(input.prompt(references), input.negative),
    image_urls: urls,
    ...(input.vocalUrl ? { audio_urls: [input.vocalUrl] } : {}),
    ...(input.duration ? { duration: input.duration } : {}),
    aspect_ratio: input.aspect,
  };
}

/* ------------------------------------------------------------------ switches */

const KEY = 'video-models';
export const videoModelSettingsSchema = z.strictObject({
  /** Catalog models the super admin allows (the job's model must be one of them). */
  available: z.array(z.string().max(60)).max(40),
  /**
   * Performance shots on a model with native lip sync (Seedance 2.x): 'refine' also runs the
   * lip-sync pass over it (safe while comparing), 'native' trusts the model's own mouth.
   */
  nativeLipSync: z.enum(['refine', 'native']),
  /**
   * Kinetic camera shots (FPV, fast orbits, whip pans, crash zooms…) that aren't lip-synced go to
   * this model when set (null = the job's normal model): combine the best camera model with the
   * best identity / lip-sync model.
   */
  kineticModel: z.string().max(60).nullable(),
});
export type VideoModelSettings = z.infer<typeof videoModelSettingsSchema>;
const DEFAULTS: VideoModelSettings = { available: VIDEO_MODELS.map((model) => model.id), nativeLipSync: 'refine', kineticModel: null };

/** The model that films a kinetic camera shot (with or without a first frame), or null = the normal one. */
export async function kineticModel(hasFrame: boolean): Promise<StudioModel | null> {
  const { kineticModel: id, available } = await getVideoModelSettings();
  const model = id && available.includes(id) ? modelById(id) : undefined;
  const spec = model?.jobs[hasFrame ? 'imageToVideo' : 'textToVideo'];
  return spec ? { endpoint: spec.endpoint, durations: [...spec.durations], extra: { ...spec.extra }, enabled: true } : null;
}

let cache: { value: VideoModelSettings; at: number } | null = null;
export async function getVideoModelSettings(): Promise<VideoModelSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = ${KEY}`;
  const parsed = videoModelSettingsSchema.safeParse({ ...DEFAULTS, ...(row?.value as object | undefined) });
  const value = parsed.success ? parsed.data : DEFAULTS;
  cache = { value, at: Date.now() };
  return value;
}

/** The catalog model filling a job now (null = a custom endpoint). */
export async function activeModels(): Promise<Record<VideoJob, { endpoint: string; enabled: boolean; modelId: string | null }>> {
  const { models } = await getStudioSettings();
  return Object.fromEntries(VIDEO_JOBS.map((job) => [job, { endpoint: models[job].endpoint, enabled: models[job].enabled, modelId: modelByEndpoint(models[job].endpoint)?.id ?? null }])) as Record<
    VideoJob,
    { endpoint: string; enabled: boolean; modelId: string | null }
  >;
}

/** Puts a catalog model on a job (its endpoint, lengths and defaults go into the studio settings). */
export async function useModel(job: VideoJob, modelId: string, actorId: string): Promise<void> {
  const model = modelById(modelId);
  const spec = model?.jobs[job];
  if (!model || !spec) throw new Error(`${model?.name ?? modelId} can't do “${JOB_LABEL[job]}”.`);
  const { available } = await getVideoModelSettings();
  if (!available.includes(modelId)) throw new Error(`${model.name} is switched off: switch it on first.`);
  const settings = await getStudioSettings();
  await saveStudioSettings({ ...settings, models: { ...settings.models, [job]: { endpoint: spec.endpoint, durations: [...spec.durations], extra: { ...spec.extra }, enabled: true } } }, actorId);
}

/**
 * Saves the switches. A job whose model was just switched off moves to the best switched-on model
 * for it (never left pointing at a model the admin turned off); returns what moved.
 */
export async function saveVideoModelSettings(input: VideoModelSettings, actorId: string): Promise<{ moved: { job: VideoJob; to: string }[] }> {
  const available = input.available.filter((id) => modelById(id));
  // A kinetic route to a model that's off (or can't film from a frame) is dropped.
  const kinetic = input.kineticModel && available.includes(input.kineticModel) && modelById(input.kineticModel)?.jobs.imageToVideo ? input.kineticModel : null;
  const value = videoModelSettingsSchema.parse({ ...input, available, kineticModel: kinetic });
  if (!VIDEO_JOBS.every((job) => value.available.some((id) => modelById(id)?.jobs[job]))) {
    throw new Error('Keep at least one model switched on for every job (image → video, text → video, performance shots).');
  }
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES (${KEY}, ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  cache = { value, at: Date.now() };
  const moved: { job: VideoJob; to: string }[] = [];
  const active = await activeModels();
  const advice = await videoModelAdvice();
  for (const job of VIDEO_JOBS) {
    const current = active[job].modelId;
    if (current && !value.available.includes(current)) {
      const next = advice.recommendations[job]?.modelId;
      if (next) {
        await useModel(job, next, actorId);
        moved.push({ job, to: next });
      }
    }
  }
  return { moved };
}

/* ------------------------------------------------------------------ measured + advice */

export interface ModelStats {
  endpoint: string;
  modelId: string | null;
  takes: number;
  ready: number;
  failed: number;
  successRate: number | null;
  renderSeconds: number | null;
  reviewScore: number | null;
  flagRate: number | null;
  pickRate: number | null;
  avgTokens: number | null;
}

/** What each video model did over the last `days`: from the takes it animated. */
export async function videoModelStats(days = 90): Promise<ModelStats[]> {
  const rows = await sql<{ endpoint: string; takes: number; ready: number; failed: number; renderSeconds: number | null; reviewScore: number | null; reviewed: number; flagged: number; picked: number; avgTokens: number | null }[]>`
    WITH t AS (
      SELECT t.*, COALESCE(
          substring(t.engine from 'animating: ([^ ]+)'),
          CASE WHEN t.fal_request ->> 'stage' = 'ANIMATING' THEN t.fal_request ->> 'endpoint' END) AS endpoint,
        NULLIF(substring(t.engine from 'animating: [^ ]+ \\((\\d+) s\\)'), '')::int AS render_seconds
      FROM studio_takes t
      WHERE t.created_at >= now() - make_interval(days => ${days}) AND t.status IN ('READY', 'FAILED'))
    SELECT endpoint, count(*)::int AS takes,
      count(*) FILTER (WHERE status = 'READY')::int AS ready,
      count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
      avg(render_seconds) FILTER (WHERE status = 'READY')::float AS render_seconds,
      avg((review ->> 'score')::float) FILTER (WHERE review ->> 'score' IS NOT NULL)::float AS review_score,
      count(*) FILTER (WHERE review ->> 'verdict' IS NOT NULL)::int AS reviewed,
      count(*) FILTER (WHERE review ->> 'verdict' = 'FLAG')::int AS flagged,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM studio_scenes s WHERE s.selected_take_id = t.id))::int AS picked,
      avg(cost) FILTER (WHERE status = 'READY')::float AS avg_tokens
    -- "animating: reused saved result" = a resumed take, not a model.
    FROM t WHERE endpoint IS NOT NULL AND endpoint <> 'reused' GROUP BY endpoint`.catch(() => []);
  return rows.map((row) => ({
    endpoint: row.endpoint,
    modelId: modelByEndpoint(row.endpoint)?.id ?? null,
    takes: row.takes,
    ready: row.ready,
    failed: row.failed,
    successRate: row.takes ? row.ready / row.takes : null,
    renderSeconds: row.renderSeconds === null ? null : Math.round(row.renderSeconds),
    reviewScore: row.reviewScore === null ? null : +row.reviewScore.toFixed(1),
    flagRate: row.reviewed ? row.flagged / row.reviewed : null,
    pickRate: row.ready ? row.picked / row.ready : null,
    avgTokens: row.avgTokens === null ? null : Math.round(row.avgTokens),
  }));
}

/** Enough takes to judge a model by its results. */
const MEASURED = 8;

export interface Recommendation {
  modelId: string;
  measured: boolean;
  score: number | null;
  reason: string;
}

/** What the app thinks each model is built for, when there aren't enough takes to judge. */
const BUILT_FOR: Record<VideoJob, string[]> = {
  imageToVideo: ['kling-2.1-master', 'seedance-2.5', 'seedance-2.0', 'seedance-1-pro'],
  textToVideo: ['kling-2.1-master', 'seedance-2.5', 'seedance-2.0', 'seedance-1-pro'],
  referenceVideo: ['kling-o1-reference', 'seedance-2.5', 'seedance-2.0'],
};

export async function videoModelAdvice(days = 90): Promise<{ stats: ModelStats[]; recommendations: Partial<Record<VideoJob, Recommendation>>; warnings: string[] }> {
  const [stats, { available }] = await Promise.all([videoModelStats(days), getVideoModelSettings()]);
  const byModel = new Map<string, ModelStats[]>();
  for (const row of stats) if (row.modelId) byModel.set(row.modelId, [...(byModel.get(row.modelId) ?? []), row]);
  const recommendations: Partial<Record<VideoJob, Recommendation>> = {};
  const warnings: string[] = [];

  for (const job of VIDEO_JOBS) {
    const candidates = VIDEO_MODELS.filter((model) => model.jobs[job] && available.includes(model.id));
    const scored = candidates
      .map((model) => {
        const row = stats.find((item) => item.endpoint === model.jobs[job]!.endpoint);
        if (!row || row.takes < MEASURED) return { model, row, score: null as number | null };
        const speed = row.renderSeconds === null ? 0.5 : Math.max(0, Math.min(1, (300 - row.renderSeconds) / 210));
        const score = 0.35 * (row.successRate ?? 0) + 0.25 * (row.pickRate ?? 0) + 0.25 * ((row.reviewScore ?? 6) / 10) + 0.15 * speed;
        return { model, row, score: +score.toFixed(3) };
      })
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const best = scored.find((item) => item.score !== null);
    if (best?.row) {
      recommendations[job] = {
        modelId: best.model.id,
        measured: true,
        score: best.score,
        reason: `${best.model.name}: ${Math.round((best.row.successRate ?? 0) * 100)}% of ${best.row.takes} takes finished, ${Math.round((best.row.pickRate ?? 0) * 100)}% kept by artists${best.row.reviewScore !== null ? `, review ${best.row.reviewScore}/10` : ''}${best.row.renderSeconds !== null ? `, ~${best.row.renderSeconds} s to render` : ''}.`,
      };
    } else {
      const fallback = BUILT_FOR[job].find((id) => candidates.some((model) => model.id === id));
      if (fallback) {
        const model = modelById(fallback)!;
        recommendations[job] = {
          modelId: fallback,
          measured: false,
          score: null,
          reason: `Not enough takes yet to compare by results (${MEASURED}+ per model). ${model.name} is built for this: ${model.strengths[0]!.toLowerCase()}.`,
        };
      }
    }
  }
  for (const row of stats) {
    const name = row.modelId ? modelById(row.modelId)!.name : row.endpoint;
    if (row.takes >= MEASURED && (row.successRate ?? 1) < 0.85) warnings.push(`${name}: ${Math.round((1 - (row.successRate ?? 0)) * 100)}% of its last ${row.takes} takes failed.`);
    if ((row.flagRate ?? 0) > 0.25 && row.takes >= MEASURED) warnings.push(`${name}: the director flagged ${Math.round((row.flagRate ?? 0) * 100)}% of its takes (faces, hands, glitches).`);
    if ((row.renderSeconds ?? 0) > 300) warnings.push(`${name}: takes average ${Math.round((row.renderSeconds ?? 0) / 60)} min to render.`);
  }
  return { stats, recommendations, warnings };
}
