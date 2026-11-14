/** Request schemas for /workspaces/:workspaceId/studio. */
import { z } from 'zod';
import { LOOK_IDS, SHOT_IDS, TRANSITION_IDS } from './cinema.js';
import { categorySchema } from '../config/categories.js';

const uuid = z.uuid();
const trimmed = (max: number) => z.string().trim().max(max);

export const workspaceParams = z.strictObject({ workspaceId: uuid });
export const projectParams = z.strictObject({ workspaceId: uuid, projectId: uuid });
export const assetParams = projectParams.extend({ assetId: uuid });
export const takeParams = projectParams.extend({ takeId: uuid });

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

const ASPECT = z.enum(['16:9', '9:16', '1:1']);

const briefSchema = z.strictObject({
  script: trimmed(12_000).optional(),
  style: trimmed(600).optional(),
  songStart: z.number().min(0).max(1200).optional(),
});

export const finishSchema = z.strictObject({
  look: z.enum(LOOK_IDS).optional(),
  grain: z.number().int().min(0).max(20).optional(),
  letterbox: z.boolean().optional(),
  enhance: z.boolean().optional(),
  musicVolume: z.number().min(0).max(1).optional(),
  resolution: z.enum(['1080p', '2160p']).optional(),
  /** Integrated loudness of the master (LUFS). -14 = streaming standard. */
  loudnessLufs: z.number().min(-30).max(-6).optional(),
  /** Music-video mastering desk. */
  audio: z
    .strictObject({
      gainDb: z.number().min(-12).max(12),
      lowDb: z.number().min(-12).max(12),
      midDb: z.number().min(-12).max(12),
      highDb: z.number().min(-12).max(12),
      compress: z.number().min(0).max(1),
      width: z.number().min(0).max(2),
    })
    .optional(),
  /** Master only this part of the song (start / end markers, seconds); null = the whole song. */
  range: z
    .strictObject({ start: z.number().min(0).max(1200), end: z.number().min(0).max(1200) })
    .refine((range) => range.end - range.start >= 1, 'The range must be at least 1 second long.')
    .nullable()
    .optional(),
  /** VeloBot's AI-master report (written by the server; echoed back by the page, never trusted). */
  aiReport: z.unknown().optional(),
});

export const createStudioSchema = z.strictObject({
  kind: z.enum(['AI_VIDEO', 'MUSIC_VIDEO']),
  /** Industry focus (config/categories.ts); required at creation. */
  category: categorySchema,
  title: trimmed(120).min(1),
  aspect: ASPECT.default('16:9'),
  brief: briefSchema.default({}),
});
export type CreateStudioInput = z.infer<typeof createStudioSchema>;

export const updateStudioSchema = z.strictObject({
  title: trimmed(120).min(1).optional(),
  aspect: ASPECT.optional(),
  brief: briefSchema.optional(),
  finish: finishSchema.optional(),
});
export type UpdateStudioInput = z.infer<typeof updateStudioSchema>;

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MUSIC_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/ogg'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'] as const;
export const LIMITS = { photoBytes: 25 * 1024 * 1024, musicBytes: 120 * 1024 * 1024, videoBytes: 400 * 1024 * 1024, musicSeconds: 15 * 60 } as const;

const assetMeta = z.strictObject({
  width: z.number().int().min(1).max(20_000).optional(),
  height: z.number().int().min(1).max(20_000).optional(),
  durationSec: z.number().min(0).max(LIMITS.musicSeconds).optional(),
  /** The photo shows the creator (used for identity), rather than a location/prop. */
  subject: z.boolean().optional(),
  caption: trimmed(200).optional(),
});

export const createAssetSchema = z
  .strictObject({
    /** PHOTO / VIDEO of a person or place; MUSIC = the song; SFX = a background effect layer (DAW). */
    role: z.enum(['PHOTO', 'MUSIC', 'VIDEO', 'SFX']),
    fileName: trimmed(255).min(1),
    contentType: z.string().trim().toLowerCase(),
    size: z.number().int().min(1),
    meta: assetMeta.default({}),
  })
  .superRefine((input, ctx) => {
    const photo = input.role === 'PHOTO';
    const video = input.role === 'VIDEO';
    if (photo && !(PHOTO_TYPES as readonly string[]).includes(input.contentType)) ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'Photos must be JPEG, PNG or WebP' });
    if (video && !(VIDEO_TYPES as readonly string[]).includes(input.contentType)) ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'Videos must be MP4, MOV or WebM' });
    if (!photo && !video && !(MUSIC_TYPES as readonly string[]).includes(input.contentType)) ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'Audio must be MP3, WAV, M4A/AAC, FLAC or OGG' });
    const max = photo ? LIMITS.photoBytes : video ? LIMITS.videoBytes : LIMITS.musicBytes;
    if (input.size > max) ctx.addIssue({ code: 'custom', path: ['size'], message: `Files of this type can be up to ${Math.round(max / 1_048_576)} MB` });
  });
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = z.strictObject({ subject: z.boolean().optional(), caption: trimmed(200).optional() });

export const identitySchema = z.strictObject({
  /** The creator confirms the photos are of themselves (or that they have the person's permission). */
  consent: z.literal(true, { error: 'Confirm the photos are of you, or that you have permission, to continue' }),
});

export const sceneInput = z.strictObject({
  id: uuid.optional(),
  description: trimmed(1000).min(3),
  prompt: trimmed(2000).optional(),
  shot: z.enum(SHOT_IDS).default('medium'),
  transition: z.enum(TRANSITION_IDS).default('crossfade'),
  durationSec: z.number().min(2).max(10).default(5),
  featuresSubject: z.boolean().default(true),
  lipSync: z.boolean().default(false),
  photoAssetIds: z.array(uuid).max(4).default([]),
});
export type SceneInput = z.infer<typeof sceneInput>;

export const scenesSchema = z.strictObject({ scenes: z.array(sceneInput).max(120) });

export const directSchema = z.strictObject({
  /** plan: write the shot list from the script; refine: polish the creator's own scenes. */
  mode: z.enum(['plan', 'refine']),
  sceneCount: z.number().int().min(1).max(60).optional(),
});

export const generateSchema = z.strictObject({
  sceneIds: z.array(uuid).min(1).max(120),
  takes: z.number().int().min(1).max(8).default(2),
  dryRun: z.boolean().default(false),
});

export const assembleSchema = z.strictObject({ finish: finishSchema.optional(), dryRun: z.boolean().default(false) });
