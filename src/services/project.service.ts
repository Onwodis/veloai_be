/**
 * Media projects: create (token gate + direct-to-R2 upload), complete,
 * cancel, retry, delete, list and read.
 *
 * Asset creation is gated twice:
 *   1. here, before the upload starts - tokens for the declared duration
 *      are reserved (402 if the workspace can't cover the job), so nothing
 *      is uploaded or processed that can't be paid for;
 *   2. in the pipeline, after ffprobe measures the real duration - the hold
 *      is extended or the job stops before any AI engine runs.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import type { BilledSteps } from '../config/tokenSettings.js';
import type { AuthContext } from '../middleware/authenticate.js';
import type { ReelVariationInput, UpdateProjectInput, UpdateReelInput } from '../models/project.schemas.js';
import { billedSoFar, VISUAL_PRESETS, type ProjectOptions } from '../media/pipeline.js';
import { getTokenSettings } from './settings.service.js';
import { enqueueProject, requeueProject } from '../media/queue.js';
import type { EditStyle } from '../media/render.js';
import { parseReelScript } from '../media/script.js';
import { trackUpload } from '../storage/ledger.js';
import { assertStorage, SIZE_ESTIMATE } from '../storage/service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { abortMultipart, completeMultipart, deleteObject, deletePrefix, headObject, keys, readUrl, startMultipart } from './storage.service.js';
import { releaseSystem, reserve } from './token.service.js';
import { requireMembership } from './workspace.service.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

/** Estimated size of the reels a job will render (for the storage gate). */
const reelBytes = (reels: number, seconds: number): number => Math.round(reels * seconds * SIZE_ESTIMATE.reelPerSecond);
const ALLOWED_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-m4v']);

export interface CreateProjectInput {
  title?: string | undefined;
  fileName: string;
  size: number;
  contentType: string;
  durationSec: number;
  reels: number;
  framing: 'original' | 'fit' | 'crop';
  captionStyle: 'pop' | 'karaoke' | 'minimal' | 'none';
  targetSeconds: number;
  style: Partial<EditStyle>;
  directions?: string | undefined;
  script?: string | undefined;
}

async function canEdit(auth: AuthContext, workspaceId: string): Promise<void> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
}
async function canView(auth: AuthContext, workspaceId: string): Promise<void> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId);
}

async function findProject(workspaceId: string, projectId: string) {
  const project = await prisma.mediaProject.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) throw AppError.notFound('Project');
  return project;
}

/** Parses a reel script and rejects it (400, per-line errors) if it can't be used. */
function checkScript(scriptText: string | undefined, durationSec: number, reels: number) {
  const parsed = scriptText ? parseReelScript(scriptText, durationSec) : null;
  if (parsed?.errors.length) {
    throw new AppError(400, 'VALIDATION_FAILED', `Your reel script has ${parsed.errors.length} problem${parsed.errors.length === 1 ? '' : 's'}`, parsed.errors.map((error) => ({ path: `script:${error.line}`, message: error.line ? `Line ${error.line}: ${error.message}` : error.message })));
  }
  if (parsed && parsed.script.clips.length > reels) {
    throw AppError.badRequest(`Your script picks ${parsed.script.clips.length} clips but you asked for ${reels} reel${reels === 1 ? '' : 's'}; raise the reel count or remove a clip line`);
  }
  return parsed;
}

/* ------------------------------------------------------------------ create + upload */

export async function createProject(auth: AuthContext, workspaceId: string, input: CreateProjectInput) {
  await canEdit(auth, workspaceId);
  if (!env.R2_ENABLED) throw new AppError(503, 'INTERNAL_ERROR', 'Storage is not configured yet.');
  if (!ALLOWED_TYPES.has(input.contentType)) throw AppError.badRequest('Upload an MP4, MOV, WebM or MKV video');
  if (input.size > MAX_UPLOAD_BYTES) throw AppError.badRequest('Videos can be up to 5 GB');

  // The reel script is checked before anything is reserved or uploaded.
  const scriptText = input.script?.trim() ? input.script : undefined;
  const parsed = checkScript(scriptText, input.durationSec, input.reels);

  // Gate 0: the upload plus the reels it will produce must fit the user's storage.
  await assertStorage(auth, input.size + reelBytes(input.reels, input.targetSeconds), 'this video and its reels');
  // Gate 1: hold tokens for the declared duration before anything is uploaded.
  const { reservation } = await reserve(auth, workspaceId, 'REEL_GENERATION', { sourceMinutes: input.durationSec / 60, reels: input.reels });

  const project = await prisma.mediaProject.create({
    data: {
      workspaceId,
      createdById: auth.userId,
      title: (input.title?.trim() || input.fileName.replace(/\.[^.]+$/, '')).slice(0, 120),
      sourceKey: 'pending',
      sourceName: input.fileName.slice(0, 255),
      sourceSize: BigInt(input.size),
      sourceType: input.contentType,
      requestedReels: input.reels,
      reservationId: reservation.id,
      options: {
        framing: input.framing,
        captionStyle: input.captionStyle,
        targetSeconds: input.targetSeconds,
        style: input.style,
        declaredDurationSec: input.durationSec,
        ...(input.directions?.trim() ? { directions: input.directions.trim() } : {}),
        ...(parsed && scriptText ? { script: scriptText, plan: parsed.script as unknown as Prisma.InputJsonObject } : {}),
      } satisfies Prisma.InputJsonValue,
    },
  });

  try {
    const sourceKey = keys.source(workspaceId, project.id, input.fileName);
    const upload = await startMultipart(sourceKey, input.contentType, input.size);
    await prisma.mediaProject.update({ where: { id: project.id }, data: { sourceKey, uploadId: upload.uploadId } });
    logger.info({ projectId: project.id, size: input.size, parts: upload.parts.length }, 'upload started');
    return { project: await projectView(project.id), upload: { partSize: upload.partSize, parts: upload.parts }, reservation };
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    await prisma.mediaProject.delete({ where: { id: project.id } }).catch(() => undefined);
    throw error;
  }
}

export async function completeUpload(auth: AuthContext, workspaceId: string, projectId: string, parts: { partNumber: number; etag: string }[]) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (project.status !== 'UPLOADING' || !project.uploadId) throw AppError.conflict('This upload is not in progress');
  await completeMultipart(project.sourceKey, project.uploadId, parts);
  const head = await headObject(project.sourceKey);
  if (!head || BigInt(head.size) !== project.sourceSize) {
    throw AppError.badRequest(`Upload incomplete: expected ${project.sourceSize} bytes, storage has ${head?.size ?? 0}`);
  }
  // Counted against the uploader; the database refuses it if the quota is gone.
  await trackUpload(project.sourceKey, head.size, async () => {
    await deleteObject(project.sourceKey);
    if (project.reservationId) await releaseSystem(project.reservationId, workspaceId).catch(() => undefined);
    await prisma.mediaProject.update({ where: { id: projectId }, data: { status: 'CANCELED', uploadId: null, error: 'Storage full', finishedAt: new Date() } });
  });
  await prisma.mediaProject.update({ where: { id: projectId }, data: { status: 'QUEUED', uploadId: null, progress: 0 } });
  await enqueueProject(projectId);
  return projectView(projectId);
}

export async function abortUpload(auth: AuthContext, workspaceId: string, projectId: string) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (project.status !== 'UPLOADING') throw AppError.conflict('Only an upload in progress can be aborted');
  if (project.uploadId) await abortMultipart(project.sourceKey, project.uploadId);
  if (project.reservationId) await releaseSystem(project.reservationId, workspaceId).catch(() => undefined);
  await prisma.mediaProject.update({ where: { id: projectId }, data: { status: 'CANCELED', uploadId: null, finishedAt: new Date() } });
  return projectView(projectId);
}

/* ------------------------------------------------------------------ lifecycle */

export async function cancelProject(auth: AuthContext, workspaceId: string, projectId: string) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (project.status === 'UPLOADING') return abortUpload(auth, workspaceId, projectId);
  if (!['QUEUED', 'PROCESSING'].includes(project.status)) throw AppError.conflict('This project is not running');
  // The worker checks this flag between stages and stops, charging only completed work.
  await prisma.mediaProject.update({ where: { id: projectId }, data: { cancelRequested: true } });
  return projectView(projectId);
}

/**
 * Re-runs a failed or canceled project.
 *
 * Default (resume): the saved transcript, hooks and rendered reels are kept,
 * and tokens are reserved and charged only for the work that is left.
 * `fresh: true` (start over): everything is discarded and re-run, and every
 * step is charged again.
 */
export async function retryProject(auth: AuthContext, workspaceId: string, projectId: string, { fresh = false }: { fresh?: boolean } = {}) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (!['FAILED', 'CANCELED'].includes(project.status) || project.sourceKey === 'pending') throw AppError.conflict('Only a failed or canceled project with an uploaded video can be retried');
  if (!(await headObject(project.sourceKey))) throw AppError.conflict('The source video is no longer in storage; upload it again');

  const options = project.options as unknown as ProjectOptions;
  const reels = await prisma.reel.findMany({ where: { projectId }, select: { id: true, status: true } });
  const billed: BilledSteps = fresh ? {} : billedSoFar(project, reels);
  const minutes = (project.durationSec ?? options.declaredDurationSec ?? 60) / 60;
  await assertStorage(auth, reelBytes(project.requestedReels, options.targetSeconds), 'the reels');
  const { reservation } = await reserve(auth, workspaceId, 'REEL_GENERATION', { sourceMinutes: minutes, reels: project.requestedReels }, billed);

  try {
    if (fresh) await deletePrefix(`${keys.project(workspaceId, projectId)}/reels/`);
    await prisma.$transaction([
      ...(fresh ? [prisma.reel.deleteMany({ where: { projectId } })] : []),
      prisma.mediaProject.update({
        where: { id: projectId },
        data: {
          status: 'QUEUED',
          stage: null,
          progress: 0,
          error: null,
          cancelRequested: false,
          reservationId: reservation.id,
          startedAt: null,
          finishedAt: null,
          // `billed` is always written, so a resumed run never re-infers it.
          options: { ...options, billed } as unknown as Prisma.InputJsonValue,
          ...(fresh ? { transcript: Prisma.DbNull, language: null, engineLog: Prisma.DbNull } : {}),
        },
      }),
    ]);
    await requeueProject(projectId);
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  logger.info({ projectId, fresh, billed, reserved: reservation.estimated }, fresh ? 'project restarted' : 'project resumed');
  return projectView(projectId);
}

/** Steps that must run again when hooks are re-picked / reels re-rendered. */
const HOOK_STEPS = ['HOOK_DETECTION', 'AI_TITLES', 'REFRAME', 'CAPTIONS', 'EXPORT'] as const;
const RENDER_STEPS = ['REFRAME', 'CAPTIONS', 'EXPORT'] as const;
/** Steps charged per reel (as opposed to per source minute). */
const REEL_STEPS = ['AI_TITLES', 'CAPTIONS', 'EXPORT'] as const;

/**
 * Edits a project that isn't running.
 *
 *   - title only               → saved, nothing re-runs
 *   - directions / script /
 *     reels / targetSeconds    → hooks are re-picked and reels re-rendered;
 *                                the transcript is kept (not charged again)
 *   - framing / captionStyle   → reels re-rendered with the same hooks
 *
 * Tokens for the re-run are reserved before anything changes, so a 402
 * leaves the project exactly as it was.
 */
export async function updateProject(auth: AuthContext, workspaceId: string, projectId: string, input: UpdateProjectInput) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (['UPLOADING', 'QUEUED', 'PROCESSING'].includes(project.status)) throw AppError.conflict('Wait for the upload or job to finish (or cancel it) before editing');

  const options = project.options as unknown as ProjectOptions;
  const next: ProjectOptions = { ...options };
  if (input.directions !== undefined) {
    if (input.directions) next.directions = input.directions;
    else delete next.directions;
  }
  if (input.targetSeconds !== undefined) next.targetSeconds = input.targetSeconds;
  if (input.framing !== undefined) next.framing = input.framing;
  if (input.captionStyle !== undefined) next.captionStyle = input.captionStyle;
  if (input.style !== undefined) next.style = { ...options.style, ...input.style };
  const reels = input.reels ?? project.requestedReels;

  if (input.script !== undefined) {
    const scriptText = input.script.trim() ? input.script : undefined;
    const parsed = checkScript(scriptText, project.durationSec ?? options.declaredDurationSec, reels);
    if (parsed && scriptText) {
      next.script = scriptText;
      next.plan = parsed.script;
    } else {
      delete next.script;
      delete next.plan;
    }
  } else if (input.reels !== undefined && options.plan && options.plan.clips.length > reels) {
    throw AppError.badRequest(`Your script picks ${options.plan.clips.length} clips; keep at least that many reels or edit the script`);
  }

  const repick =
    reels !== project.requestedReels ||
    next.targetSeconds !== options.targetSeconds ||
    (next.directions ?? '') !== (options.directions ?? '') ||
    (next.script ?? '') !== (options.script ?? '');
  const rerender =
    !repick && (next.framing !== options.framing || next.captionStyle !== options.captionStyle || JSON.stringify(next.style ?? {}) !== JSON.stringify(options.style ?? {}));
  const title = input.title ?? project.title;

  // Nothing to regenerate: title change, or a project that never got past upload / transcription
  // (its next Retry / Resume picks the new settings up anyway).
  const existingReels = await prisma.reel.findMany({ where: { projectId }, select: { id: true, status: true, hookScore: true, index: true } });
  const canRegenerate = project.sourceKey !== 'pending' && (project.status === 'READY' || existingReels.length > 0);

  // Only the reel count changed: keep every finished reel. Fewer → drop the
  // weakest (free); more → pick and render just the extra ones (charged per new reel).
  // Compared with the reels that exist too, so a project that came up short can be topped up.
  const countOnly =
    canRegenerate &&
    input.reels !== undefined &&
    (reels !== project.requestedReels || reels !== existingReels.length) &&
    next.targetSeconds === options.targetSeconds &&
    (next.directions ?? '') === (options.directions ?? '') &&
    (next.script ?? '') === (options.script ?? '') &&
    next.framing === options.framing &&
    next.captionStyle === options.captionStyle &&
    JSON.stringify(next.style ?? {}) === JSON.stringify(options.style ?? {});
  if (countOnly && reels <= existingReels.length) {
    const drop = [...existingReels].sort((a, b) => a.hookScore - b.hookScore).slice(0, existingReels.length - reels);
    await Promise.all(drop.flatMap((reel) => [deleteObject(keys.reel(workspaceId, projectId, reel.id, 'mp4')), deleteObject(keys.reel(workspaceId, projectId, reel.id, 'jpg'))].map((task) => task.catch(() => undefined))));
    const billed = billedSoFar(project, existingReels);
    const readyDropped = drop.filter((reel) => reel.status === 'READY').length;
    for (const step of REEL_STEPS) if (billed[step]) billed[step] = Math.max(0, billed[step]! - readyDropped);
    await prisma.$transaction([
      prisma.reel.deleteMany({ where: { id: { in: drop.map((reel) => reel.id) } } }),
      prisma.mediaProject.update({ where: { id: projectId }, data: { title, requestedReels: reels, options: { ...next, billed } as unknown as Prisma.InputJsonValue } }),
    ]);
    logger.info({ projectId, dropped: drop.length }, 'reel count lowered');
    return projectView(projectId, true);
  }
  if (countOnly && reels > existingReels.length) {
    if (!(await headObject(project.sourceKey))) throw AppError.conflict('The source video is no longer in storage; upload it again');
    const billed = billedSoFar(project, existingReels);
    const minutes = (project.durationSec ?? options.declaredDurationSec ?? 60) / 60;
    await assertStorage(auth, reelBytes(reels - existingReels.length, options.targetSeconds), 'the new reels');
    const { reservation } = await reserve(auth, workspaceId, 'REEL_GENERATION', { sourceMinutes: minutes, reels }, billed);
    try {
      await prisma.mediaProject.update({
        where: { id: projectId },
        data: {
          title,
          requestedReels: reels,
          options: { ...next, billed, topUp: true } as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
          stage: null,
          progress: 0,
          error: null,
          cancelRequested: false,
          reservationId: reservation.id,
          startedAt: null,
          finishedAt: null,
        },
      });
      await requeueProject(projectId);
    } catch (error) {
      await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
      throw error;
    }
    logger.info({ projectId, from: existingReels.length, to: reels }, 'adding reels to project');
    return projectView(projectId, true);
  }
  if ((!repick && !rerender) || !canRegenerate) {
    await prisma.mediaProject.update({ where: { id: projectId }, data: { title, requestedReels: reels, options: next as unknown as Prisma.InputJsonValue } });
    return projectView(projectId, true);
  }

  if (!(await headObject(project.sourceKey))) throw AppError.conflict('The source video is no longer in storage; upload it again');
  const billed: BilledSteps = { ...billedSoFar(project, existingReels) };
  for (const step of repick ? HOOK_STEPS : RENDER_STEPS) delete billed[step];
  next.billed = billed;

  const minutes = (project.durationSec ?? options.declaredDurationSec ?? 60) / 60;
  await assertStorage(auth, reelBytes(reels, next.targetSeconds), 'the regenerated reels');
  const { reservation } = await reserve(auth, workspaceId, 'REEL_GENERATION', { sourceMinutes: minutes, reels }, billed);
  try {
    await deletePrefix(`${keys.project(workspaceId, projectId)}/reels/`);
    await prisma.$transaction([
      repick
        ? prisma.reel.deleteMany({ where: { projectId } })
        : prisma.reel.updateMany({ where: { projectId }, data: { status: 'RENDERING', videoKey: null, thumbKey: null, sizeBytes: null, error: null } }),
      prisma.mediaProject.update({
        where: { id: projectId },
        data: {
          title,
          requestedReels: reels,
          options: next as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
          stage: null,
          progress: 0,
          error: null,
          cancelRequested: false,
          reservationId: reservation.id,
          startedAt: null,
          finishedAt: null,
        },
      }),
    ]);
    await requeueProject(projectId);
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  logger.info({ projectId, repick, rerender, reserved: reservation.estimated }, 'project edited and regenerating');
  return projectView(projectId, true);
}

/* ------------------------------------------------------------------ single reels */

async function findReel(projectId: string, reelId: string) {
  const reel = await prisma.reel.findFirst({ where: { id: reelId, projectId } });
  if (!reel) throw AppError.notFound('Reel');
  return reel;
}

/**
 * Edits one reel.
 *
 *   caption / hashtags             → saved, nothing re-runs
 *   title                          → saved; re-rendered only when the script
 *                                    shows the title on screen
 *   hook headline / trim in / out  → just this reel is re-rendered (the
 *                                    transcript and other reels are kept);
 *                                    charged as one reel's captions + export
 */
export async function updateReel(auth: AuthContext, workspaceId: string, projectId: string, reelId: string, input: UpdateReelInput) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (['UPLOADING', 'QUEUED', 'PROCESSING'].includes(project.status)) throw AppError.conflict('Wait for the job to finish (or cancel it) before editing a reel');
  const reel = await findReel(projectId, reelId);
  const options = project.options as unknown as ProjectOptions;
  const duration = project.durationSec ?? options.declaredDurationSec;

  const startSec = input.startSec ?? reel.startSec;
  const endSec = input.endSec ?? reel.endSec;
  if (endSec <= startSec) throw AppError.badRequest('The reel must end after it starts');
  if (endSec - startSec < 3) throw AppError.badRequest('A reel must be at least 3 seconds long');
  if (endSec - startSec > 180) throw AppError.badRequest('A reel can be at most 3 minutes long');
  if (duration && endSec > duration + 0.5) throw AppError.badRequest(`The video is only ${duration.toFixed(1)} seconds long`);

  const plans = [...(options.reelPlans ?? [])];
  const plan = plans[reel.index] ?? { hookText: '', beats: [] };
  const hookText = input.hookText ?? plan.hookText;
  const retimed = startSec !== reel.startSec || endSec !== reel.endSec;
  const titleOnScreen = Boolean(options.plan?.titleSeconds) && input.title !== undefined && input.title !== reel.title;
  const rerender = retimed || hookText !== plan.hookText || titleOnScreen;

  const reelData = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    ...(input.hashtags !== undefined ? { hashtags: input.hashtags.map((tag) => tag.replace(/^#/, '').slice(0, 40)).filter(Boolean).slice(0, 8) } : {}),
    ...(retimed ? { startSec: +startSec.toFixed(2), endSec: +endSec.toFixed(2) } : {}),
  };
  if (!rerender) {
    await prisma.reel.update({ where: { id: reelId }, data: reelData });
    return projectView(projectId, true);
  }

  if (project.sourceKey === 'pending' || !(await headObject(project.sourceKey))) throw AppError.conflict('The source video is no longer in storage; upload it again');
  // Flashpoints outside the new trim are dropped; the rest keep their source times.
  plans[reel.index] = { hookText: hookText.slice(0, 80), beats: plan.beats.filter((beat) => beat.t > startSec + 0.8 && beat.t < endSec - 0.3) };
  const allReels = await prisma.reel.findMany({ where: { projectId }, select: { status: true } });
  const billed: BilledSteps = { ...billedSoFar(project, allReels) };
  // Charge this reel's render again (captions + export); minutes and titles stay paid.
  if (reel.status === 'READY') for (const step of ['CAPTIONS', 'EXPORT'] as const) billed[step] = Math.max(0, (billed[step] ?? 0) - 1);

  const minutes = (project.durationSec ?? options.declaredDurationSec ?? 60) / 60;
  await assertStorage(auth, reelBytes(1, endSec - startSec), 'this reel');
  const { reservation } = await reserve(auth, workspaceId, 'REEL_GENERATION', { sourceMinutes: minutes, reels: allReels.length }, billed);
  try {
    await prisma.$transaction([
      prisma.reel.update({ where: { id: reelId }, data: { ...reelData, status: 'RENDERING', error: null } }),
      prisma.mediaProject.update({
        where: { id: projectId },
        data: {
          options: { ...options, reelPlans: plans, billed } as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
          stage: null,
          progress: 0,
          error: null,
          cancelRequested: false,
          reservationId: reservation.id,
          startedAt: null,
          finishedAt: null,
        },
      }),
    ]);
    await requeueProject(projectId);
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  logger.info({ projectId, reelId, retimed }, 're-rendering one reel');
  return projectView(projectId, true);
}

/**
 * One-click variations for a single reel, re-using everything already paid for
 * (source video, transcript, the cut itself):
 *
 *   hook   the AI writes a new hook headline, title, caption and flashpoints
 *          for the same moment → charged AI titles + captions + export, 1 reel
 *   style  the reel re-renders with the next visual preset (colour look +
 *          caption style) → charged captions + export, 1 reel
 *
 * Transcription and hook detection (the per-minute steps) are never charged
 * again, so a variation costs a small fraction of the original job.
 */
export async function reelVariation(auth: AuthContext, workspaceId: string, projectId: string, reelId: string, input: ReelVariationInput) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (['UPLOADING', 'QUEUED', 'PROCESSING'].includes(project.status)) throw AppError.conflict('Wait for the job to finish (or cancel it) before making a variation');
  const reel = await findReel(projectId, reelId);
  if (reel.status !== 'READY' && reel.status !== 'FAILED') throw AppError.conflict('This reel is still rendering');
  if (!project.transcript) throw AppError.conflict('This project has no saved transcript yet; run it first');
  if (project.sourceKey === 'pending' || !(await headObject(project.sourceKey))) throw AppError.conflict('The source video is no longer in storage; upload it again');

  const options = project.options as unknown as ProjectOptions;
  const next: ProjectOptions = { ...options };
  const steps = input.kind === 'hook' ? (['AI_TITLES', 'CAPTIONS', 'EXPORT'] as const) : (['CAPTIONS', 'EXPORT'] as const);
  if (input.kind === 'hook') {
    next.rehook = [...new Set([...(options.rehook ?? []), reelId])];
  } else {
    const current = options.reelStyles?.[reel.index];
    const at = current ? VISUAL_PRESETS.findIndex((preset) => preset.look === current.look && preset.captionStyle === current.captionStyle) : -1;
    const preset = VISUAL_PRESETS[(input.preset ?? at + 1) % VISUAL_PRESETS.length]!;
    next.reelStyles = { ...options.reelStyles, [reel.index]: { look: preset.look, captionStyle: preset.captionStyle } };
  }

  const allReels = await prisma.reel.findMany({ where: { projectId }, select: { status: true } });
  const billed: BilledSteps = { ...billedSoFar(project, allReels) };
  if (reel.status === 'READY') for (const step of steps) billed[step] = Math.max(0, (billed[step] ?? 0) - 1);
  next.billed = billed;

  const minutes = (project.durationSec ?? options.declaredDurationSec ?? 60) / 60;
  await assertStorage(auth, reelBytes(1, reel.endSec - reel.startSec), 'this variation');
  const { reservation } = await reserve(auth, workspaceId, 'REEL_GENERATION', { sourceMinutes: minutes, reels: allReels.length }, billed);
  try {
    await prisma.$transaction([
      prisma.reel.update({ where: { id: reelId }, data: { status: 'RENDERING', error: null } }),
      prisma.mediaProject.update({
        where: { id: projectId },
        data: {
          options: next as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
          stage: null,
          progress: 0,
          error: null,
          cancelRequested: false,
          reservationId: reservation.id,
          startedAt: null,
          finishedAt: null,
        },
      }),
    ]);
    await requeueProject(projectId);
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  logger.info({ projectId, reelId, kind: input.kind, reserved: reservation.estimated }, 'one-click reel variation');
  return projectView(projectId, true);
}

/** Deletes one reel and its files (a project keeps at least one). */
export async function deleteReel(auth: AuthContext, workspaceId: string, projectId: string, reelId: string) {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (['UPLOADING', 'QUEUED', 'PROCESSING'].includes(project.status)) throw AppError.conflict('Wait for the job to finish (or cancel it) before deleting a reel');
  const reel = await findReel(projectId, reelId);
  const all = await prisma.reel.findMany({ where: { projectId }, select: { status: true } });
  if (all.length <= 1) throw AppError.badRequest('A project keeps at least one reel; delete the project instead');
  await Promise.all([deleteObject(keys.reel(workspaceId, projectId, reelId, 'mp4')), deleteObject(keys.reel(workspaceId, projectId, reelId, 'jpg'))].map((task) => task.catch(() => undefined)));
  const billed: BilledSteps = { ...billedSoFar(project, all) };
  if (reel.status === 'READY') for (const step of REEL_STEPS) if (billed[step]) billed[step] = Math.max(0, billed[step]! - 1);
  const options = project.options as unknown as ProjectOptions;
  await prisma.$transaction([
    prisma.reel.delete({ where: { id: reelId } }),
    prisma.mediaProject.update({ where: { id: projectId }, data: { requestedReels: all.length - 1, options: { ...options, billed } as unknown as Prisma.InputJsonValue } }),
  ]);
  return projectView(projectId, true);
}

export async function deleteProject(auth: AuthContext, workspaceId: string, projectId: string): Promise<void> {
  await canEdit(auth, workspaceId);
  const project = await findProject(workspaceId, projectId);
  if (['QUEUED', 'PROCESSING'].includes(project.status)) throw AppError.conflict('Cancel the job before deleting the project');
  if (project.status === 'UPLOADING' && project.uploadId) await abortMultipart(project.sourceKey, project.uploadId);
  if (project.reservationId) {
    const held = await prisma.tokenReservation.findFirst({ where: { id: project.reservationId, status: 'HELD' } });
    if (held) await releaseSystem(held.id, workspaceId).catch(() => undefined);
  }
  await deletePrefix(`${keys.project(workspaceId, projectId)}/`);
  await prisma.mediaProject.delete({ where: { id: projectId } });
}

/* ------------------------------------------------------------------ reads */

type ProjectRow = Prisma.MediaProjectGetPayload<{ include: { reels: true } }>;

async function reelView(reel: ProjectRow['reels'][number], options: ProjectOptions | null) {
  const plans = options?.reelPlans;
  const override = options?.reelStyles?.[reel.index];
  const preset = override ? VISUAL_PRESETS.find((item) => item.look === override.look && item.captionStyle === override.captionStyle) : undefined;
  return {
    /** Visual preset from "Swap visual style" (null = the project's own look and captions). */
    visualStyle: preset?.name ?? null,
    id: reel.id,
    index: reel.index,
    title: reel.title,
    hook: reel.hook,
    /** On-screen headline over the first seconds (editable). */
    hookText: plans?.[reel.index]?.hookText ?? '',
    hookScore: reel.hookScore,
    startSec: reel.startSec,
    endSec: reel.endSec,
    durationSec: +(reel.endSec - reel.startSec).toFixed(1),
    caption: reel.caption,
    hashtags: reel.hashtags,
    status: reel.status,
    error: reel.error,
    sizeBytes: reel.sizeBytes ? Number(reel.sizeBytes) : null,
    videoUrl: reel.videoKey ? await readUrl(reel.videoKey) : null,
    downloadUrl: reel.videoKey ? await readUrl(reel.videoKey, `${reel.title.slice(0, 60)}.mp4`) : null,
    thumbUrl: reel.thumbKey ? await readUrl(reel.thumbKey) : null,
  };
}

async function shape(project: ProjectRow, detail: boolean) {
  const options = project.options as unknown as ProjectOptions | null;
  const reels = await Promise.all(project.reels.sort((a, b) => a.index - b.index).map((reel) => reelView(reel, options)));
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    stage: project.stage,
    progress: project.progress,
    sourceName: project.sourceName,
    sourceSize: Number(project.sourceSize),
    durationSec: project.durationSec,
    width: project.width,
    height: project.height,
    requestedReels: project.requestedReels,
    options: project.options,
    tokensCharged: project.tokensCharged,
    language: project.language,
    error: project.error,
    cancelRequested: project.cancelRequested,
    /** A retry can pick up saved work (transcript / hooks / reels) instead of starting over. */
    resumable: project.transcript !== null || project.reels.length > 0,
    createdAt: project.createdAt.toISOString(),
    startedAt: project.startedAt?.toISOString() ?? null,
    finishedAt: project.finishedAt?.toISOString() ?? null,
    reels,
    ...(detail
      ? {
          engineLog: project.engineLog,
          transcriptPreview: ((project.transcript as { text?: string } | null)?.text ?? '').slice(0, 1200),
          wordCount: ((project.transcript as { words?: unknown[] } | null)?.words ?? []).length,
          variations: await variationInfo(),
        }
      : {}),
  };
}

/** What the one-click buttons cost (one reel's steps, before the reserve buffer). */
async function variationInfo() {
  const { taskCosts } = await getTokenSettings();
  return {
    hookCost: taskCosts.AI_TITLES + taskCosts.CAPTIONS + taskCosts.EXPORT,
    styleCost: taskCosts.CAPTIONS + taskCosts.EXPORT,
    presets: VISUAL_PRESETS.map((preset) => preset.name),
  };
}

async function projectView(projectId: string, detail = false) {
  const project = await prisma.mediaProject.findUniqueOrThrow({ where: { id: projectId }, include: { reels: true } });
  return shape(project, detail);
}

export async function listProjects(auth: AuthContext, workspaceId: string, page: number, pageSize: number) {
  await canView(auth, workspaceId);
  const [total, rows] = await prisma.$transaction([
    prisma.mediaProject.count({ where: { workspaceId } }),
    prisma.mediaProject.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { reels: true } }),
  ]);
  return { items: await Promise.all(rows.map((row) => shape(row, false))), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getProject(auth: AuthContext, workspaceId: string, projectId: string) {
  await canView(auth, workspaceId);
  await findProject(workspaceId, projectId);
  return projectView(projectId, true);
}
