/**
 * AI video studio settings (super admin, platform_settings key "studio").
 *
 * Every generation stage names a fal.ai endpoint, so a newer or better model
 * can be switched in from the console without a deploy. `extra` is merged
 * into the request body for model-specific knobs (cfg_scale, resolution…).
 * Costs are in tokens and charged only for takes that succeed.
 */
import { z } from 'zod';
import { json, sql } from './sql.js';

const SETTINGS_KEY = 'studio';

const endpoint = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)+$/i, { error: 'Use a fal.ai endpoint id such as fal-ai/kling-video/v2.1/master/image-to-video' });

const modelSchema = z.strictObject({
  endpoint,
  /** Clip lengths the model accepts, exactly as it expects them ("5", "8s"…). */
  durations: z.array(z.string().trim().min(1).max(8)).max(8).default([]),
  extra: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type StudioModel = z.infer<typeof modelSchema>;

export const studioSettingsSchema = z.strictObject({
  models: z.strictObject({
    /** Photoreal still of the creator in the scene, from their reference photos (identity lock). */
    keyframe: modelSchema,
    /** Animates a keyframe / uploaded picture into footage. */
    imageToVideo: modelSchema,
    /** Scenes without the creator (aerial establishing shots, b-roll). */
    textToVideo: modelSchema,
    /**
     * Identity-locked animation for music-video shots with cast: the keyframe is the start
     * frame and each character's photos ride along as a reference element, so the face
     * holds from the first frame to the last (Kling O1 reference-to-video, Grok reference mode).
     */
    referenceVideo: modelSchema,
    /** Matches the creator's mouth to the song for performance shots (sync v2 pro, or react-1 for emotion). */
    lipSync: modelSchema,
    /**
     * Music-video performance shots: lip sync that also moves the face (brows, cheeks,
     * creases) with the scene's emotion (sync react-1, clips ≤ 15 s). Off, or a longer
     * clip, falls back to `lipSync`.
     */
    lipSyncExpressive: modelSchema,
    /** Isolates the vocal stem (acapella) of the song before lip sync, so drums never move the mouth. */
    vocalStem: modelSchema,
    /** Optional enhancement pass on each chosen take before assembly. */
    upscale: modelSchema,
    /** Trains a personal identity model (LoRA) from the user's likeness photos + video frames. */
    likenessTraining: modelSchema,
    /** Renders @me with the trained identity model. */
    likenessImage: modelSchema,
    /** Stills without the user. */
    textToImage: modelSchema,
    /** Edits / enhances an uploaded picture from written instructions (also @me with reference photos). */
    imageEdit: modelSchema,
    /** Final detail / resolution pass on stills. */
    imageUpscale: modelSchema,
    /** Music video foley: action sounds (steps, claps, cloth, heartbeat) generated from each shot. */
    foley: modelSchema,
    /** Post-processing: edits a finished take from an instruction (remove text, match a look, fix glitches). */
    videoEdit: modelSchema,
    /** Character photo shoots: stills of a cast member in scripted scenes, from their reference photos. */
    characterStill: modelSchema,
    /** Commercials: text-to-speech for each character's lines (voice chosen per character). */
    tts: modelSchema,
    /**
     * Speech in a real person's voice, cloned from a reference recording (the artist's
     * vocal stem): the cold open's lines in the artist's own voice and accent.
     */
    voiceClone: modelSchema,
  }),
  costs: z.strictObject({
    keyframe: z.number().int().min(0).max(100_000),
    videoPerSecond: z.number().int().min(0).max(100_000),
    lipSyncPerSecond: z.number().int().min(0).max(100_000),
    upscalePerSecond: z.number().int().min(0).max(100_000),
    assemblyPerMinute: z.number().int().min(0).max(100_000),
    identity: z.number().int().min(0).max(100_000),
    director: z.number().int().min(0).max(100_000),
    likenessAnalysis: z.number().int().min(0).max(100_000),
    likenessTraining: z.number().int().min(0).max(1_000_000),
    image: z.number().int().min(0).max(100_000),
    imageEdit: z.number().int().min(0).max(100_000),
    imageUpscale: z.number().int().min(0).max(100_000),
    /** Music video director (tokens). */
    mvCasting: z.number().int().min(0).max(100_000),
    mvScene: z.number().int().min(0).max(100_000),
    mvChat: z.number().int().min(0).max(100_000),
    mvStoryboard: z.number().int().min(0).max(100_000),
    mvLyricsPerMinute: z.number().int().min(0).max(100_000),
    mvMix: z.number().int().min(0).max(100_000),
    foleyPerSecond: z.number().int().min(0).max(100_000),
    videoEditPerSecond: z.number().int().min(0).max(100_000),
    characterStill: z.number().int().min(0).max(100_000),
    /** Commercials: spoken lines (tokens per second of speech, min 1 s). */
    ttsPerSecond: z.number().int().min(0).max(100_000),
  }),
  limits: z.strictObject({
    maxScenes: z.number().int().min(1).max(120),
    maxTakesPerRequest: z.number().int().min(1).max(8),
    maxPhotos: z.number().int().min(1).max(300),
    concurrency: z.number().int().min(1).max(16),
  }),
});
export type StudioSettings = z.infer<typeof studioSettingsSchema>;

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  models: {
    keyframe: { endpoint: 'fal-ai/nano-banana/edit', durations: [], extra: { num_images: 1, output_format: 'png' }, enabled: true },
    imageToVideo: { endpoint: 'fal-ai/kling-video/v2.1/master/image-to-video', durations: ['5', '10'], extra: { cfg_scale: 0.5 }, enabled: true },
    textToVideo: { endpoint: 'fal-ai/kling-video/v2.1/master/text-to-video', durations: ['5', '10'], extra: { cfg_scale: 0.5 }, enabled: true },
    // Kling O1: start frame as @Image1 + one @Element per character (frontal + 1-3 references), 7 images max.
    referenceVideo: { endpoint: 'fal-ai/kling-video/o1/reference-to-video', durations: ['3', '4', '5', '6', '7', '8', '9', '10'], extra: {}, enabled: true },
    // sync_mode cut_off is enforced in lipsync.ts (frame-exact timing). For react-1 put
    // { emotion: happy|sad|angry|disgusted|surprised|neutral, temperature, model_mode } in extra.
    lipSync: { endpoint: 'fal-ai/sync-lipsync/v2/pro', durations: [], extra: {}, enabled: true },
    // model_mode face = lips + facial expression (the base video keeps the head movement).
    // Emotion and temperature come from the scene (emotion + intensity); extra overrides.
    lipSyncExpressive: { endpoint: 'fal-ai/sync-lipsync/react-1', durations: [], extra: { model_mode: 'face' }, enabled: true },
    // WAV, not MP3: MP3 encoder padding shifts the vocals by ~25 ms, which reads as late lips.
    vocalStem: { endpoint: 'fal-ai/demucs', durations: [], extra: { model: 'htdemucs_ft', stems: ['vocals'], output_format: 'wav' }, enabled: true },
    upscale: { endpoint: 'fal-ai/topaz/upscale/video', durations: [], extra: { upscale_factor: 2 }, enabled: true },
    likenessTraining: { endpoint: 'fal-ai/flux-lora-fast-training', durations: [], extra: { steps: 1000, create_masks: true, is_style: false }, enabled: true },
    likenessImage: { endpoint: 'fal-ai/flux-lora', durations: [], extra: { num_inference_steps: 32, guidance_scale: 3.5, num_images: 1, output_format: 'png', enable_safety_checker: true }, enabled: true },
    textToImage: { endpoint: 'fal-ai/flux-pro/v1.1-ultra', durations: [], extra: { num_images: 1, output_format: 'png', enable_safety_checker: true }, enabled: true },
    imageEdit: { endpoint: 'fal-ai/nano-banana/edit', durations: [], extra: { num_images: 1, output_format: 'png' }, enabled: true },
    imageUpscale: { endpoint: 'fal-ai/clarity-upscaler', durations: [], extra: { upscale_factor: 2, creativity: 0.2, resemblance: 0.9 }, enabled: true },
    foley: { endpoint: 'fal-ai/mmaudio-v2', durations: [], extra: { num_steps: 25, cfg_strength: 4.5 }, enabled: true },
    // Kling O1 edit: 3-10 s mp4/mov in, keeps the motion; `@Image1…` in the prompt refers to image_urls.
    videoEdit: { endpoint: 'fal-ai/kling-video/o1/video-to-video/edit', durations: [], extra: { keep_audio: true }, enabled: true },
    characterStill: { endpoint: 'fal-ai/nano-banana/edit', durations: [], extra: { num_images: 1, output_format: 'png' }, enabled: true },
    // Multilingual speech; the voice is picked per character (gender / age) in commercials/voice.ts.
    // extra.voices may map a character's accent or name to a voice id the admin prefers.
    tts: { endpoint: 'fal-ai/elevenlabs/tts/multilingual-v2', durations: [], extra: { stability: 0.5, similarity_boost: 0.75 }, enabled: true },
    // Chatterbox: text + audio_url (the reference voice) in, audio.url out, in one call.
    voiceClone: { endpoint: 'fal-ai/chatterbox/text-to-speech', durations: [], extra: { exaggeration: 0.35, cfg: 0.5, temperature: 0.7 }, enabled: true },
  },
  costs: { keyframe: 8, videoPerSecond: 12, lipSyncPerSecond: 6, upscalePerSecond: 4, assemblyPerMinute: 20, identity: 15, director: 10, likenessAnalysis: 20, likenessTraining: 150, image: 8, imageEdit: 8, imageUpscale: 6, mvCasting: 15, mvScene: 2, mvChat: 3, mvStoryboard: 12, mvLyricsPerMinute: 10, mvMix: 5, foleyPerSecond: 2, videoEditPerSecond: 190, characterStill: 45, ttsPerSecond: 1 },
  // maxPhotos covers a whole music-video cast (several photos per character).
  limits: { maxScenes: 40, maxTakesPerRequest: 4, maxPhotos: 120, concurrency: 3 },
};

let cache: { value: StudioSettings; at: number } | null = null;

export async function getStudioSettings(): Promise<StudioSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = ${SETTINGS_KEY}`;
  // Merge over defaults so settings saved before a field existed still parse.
  const stored = (row?.value ?? {}) as Partial<StudioSettings>;
  const models = { ...DEFAULT_STUDIO_SETTINGS.models, ...stored.models };
  // The old default (sync v2 standard) is upgraded to v2 pro; a model the admin picked themselves is kept.
  if (models.lipSync.endpoint === 'fal-ai/sync-lipsync/v2') models.lipSync = { ...DEFAULT_STUDIO_SETTINGS.models.lipSync, enabled: models.lipSync.enabled };
  const merged = {
    models,
    costs: { ...DEFAULT_STUDIO_SETTINGS.costs, ...stored.costs },
    limits: { ...DEFAULT_STUDIO_SETTINGS.limits, ...stored.limits },
  };
  const parsed = studioSettingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : DEFAULT_STUDIO_SETTINGS;
  cache = { value, at: Date.now() };
  return value;
}

export async function saveStudioSettings(input: StudioSettings, actorId: string): Promise<StudioSettings> {
  const value = studioSettingsSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at)
    VALUES (${SETTINGS_KEY}, ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  cache = { value, at: Date.now() };
  return value;
}

/** Closest supported clip length to what the scene asks for. */
export function pickDuration(model: StudioModel, wanted: number): { param: string | null; seconds: number } {
  if (model.durations.length === 0) return { param: null, seconds: wanted };
  const options = model.durations.map((param) => ({ param, seconds: Number.parseFloat(param) })).filter((option) => Number.isFinite(option.seconds));
  if (options.length === 0) return { param: null, seconds: wanted };
  // Prefer the shortest clip that covers the scene (extra is trimmed at assembly), else the longest.
  const covering = options.filter((option) => option.seconds >= wanted).sort((a, b) => a.seconds - b.seconds);
  return covering[0] ?? options.sort((a, b) => b.seconds - a.seconds)[0]!;
}
