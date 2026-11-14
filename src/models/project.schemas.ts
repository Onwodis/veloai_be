import { z } from 'zod';
import { LOOK_IDS } from '../studio/cinema.js';

/** Finishing options for every reel (see media/render.ts EditStyle). */
export const styleSchema = z.strictObject({
  muted: z.boolean().optional(),
  look: z.enum(['none', ...LOOK_IDS]).optional(),
  jumpCuts: z.boolean().optional(),
  denoise: z.boolean().optional(),
  autoEffects: z.boolean().optional(),
});
const FRAMING = z.enum(['original', 'fit', 'crop']);

export const projectWorkspaceParams = z.strictObject({ workspaceId: z.uuid() });
export const projectParams = z.strictObject({ workspaceId: z.uuid(), projectId: z.uuid() });

export const createProjectSchema = z.strictObject({
  title: z.string().trim().max(120).optional(),
  fileName: z.string().trim().min(1).max(255),
  size: z.number().int().min(1),
  contentType: z.string().trim().max(100),
  /** Measured in the browser from the file's metadata; re-measured server-side. */
  durationSec: z.number().min(10, { error: 'Videos must be at least 10 seconds' }).max(600 * 60, { error: 'Videos can be up to 10 hours' }),
  reels: z.number().int().min(1).max(30),
  framing: FRAMING.default('original'),
  style: styleSchema.default({}),
  captionStyle: z.enum(['pop', 'karaoke', 'minimal', 'none']).default('pop'),
  targetSeconds: z.number().int().min(15).max(90).default(35),
  /** Free-text directions for the AI picker ("focus on pricing, keep it funny"). */
  directions: z.string().trim().max(1000).optional(),
  /** Reel script (see media/script.ts); parsed and checked against the duration. */
  script: z.string().max(4000).optional(),
});

export const completeUploadSchema = z.strictObject({
  parts: z
    // 5 GB cap / 16 MiB parts = at most 320 parts (~20 kB of JSON).
    .array(z.strictObject({ partNumber: z.number().int().min(1).max(400), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(400),
});

/**
 * Edit a project. Title-only edits just save. Changing what the AI picks
 * (directions, script, reel count, length) re-picks hooks and re-renders,
 * keeping the transcript; changing framing/captions only re-renders.
 * An empty string clears directions / script.
 */
export const updateProjectSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(120).optional(),
    directions: z.string().trim().max(1000).optional(),
    script: z.string().max(4000).optional(),
    reels: z.number().int().min(1).max(30).optional(),
    targetSeconds: z.number().int().min(15).max(90).optional(),
    framing: FRAMING.optional(),
    style: styleSchema.optional(),
    captionStyle: z.enum(['pop', 'karaoke', 'minimal', 'none']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Nothing to update' });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const reelParams = z.strictObject({ workspaceId: z.uuid(), projectId: z.uuid(), reelId: z.uuid() });

/**
 * Edit one reel. Caption / hashtags just save; the hook headline or a new
 * trim (start/end, source seconds) re-renders only this reel.
 */
export const updateReelSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(160).optional(),
    caption: z.string().trim().max(1000).optional(),
    hashtags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
    hookText: z.string().trim().max(80).optional(),
    startSec: z.number().min(0).optional(),
    endSec: z.number().min(0).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Nothing to update' });
export type UpdateReelInput = z.infer<typeof updateReelSchema>;

/** One-click variations: a fresh hook from the cached transcript, or the next visual preset. */
export const reelVariationSchema = z.strictObject({
  kind: z.enum(['hook', 'style']),
  /** style only: jump to this preset (index into VISUAL_PRESETS) instead of the next one. */
  preset: z.number().int().min(0).max(50).optional(),
});
export type ReelVariationInput = z.infer<typeof reelVariationSchema>;

/** Retry body: resume from saved work (default) or start over and re-charge everything. */
export const retryProjectSchema = z.strictObject({ fresh: z.boolean().default(false) }).default({ fresh: false });

export const listProjectsQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});
