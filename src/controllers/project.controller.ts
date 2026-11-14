/**
 * Media project handlers + the super admin engine status.
 */
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../config/database.js';
import { requireAuth } from '../middleware/authenticate.js';
import { validBody, validParams, validQuery } from '../middleware/validate.js';
import { versions } from '../media/ffmpeg.js';
import { queueCounts } from '../media/queue.js';
import { resolveEngine } from '../services/ai.service.js';
import { completeUploadSchema, createProjectSchema, listProjectsQuery, projectParams, projectWorkspaceParams, reelParams, retryProjectSchema, updateProjectSchema, updateReelSchema, reelVariationSchema } from '../models/project.schemas.js';
import * as projects from '../services/project.service.js';

export async function create(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, projectWorkspaceParams);
  res.status(201).json(await projects.createProject(requireAuth(req), workspaceId, validBody(req, createProjectSchema)));
}

export async function complete(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await projects.completeUpload(requireAuth(req), workspaceId, projectId, validBody(req, completeUploadSchema).parts) });
}

export async function abort(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await projects.abortUpload(requireAuth(req), workspaceId, projectId) });
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await projects.cancelProject(requireAuth(req), workspaceId, projectId) });
}

export async function retry(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await projects.retryProject(requireAuth(req), workspaceId, projectId, validBody(req, retryProjectSchema)) });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await projects.updateProject(requireAuth(req), workspaceId, projectId, validBody(req, updateProjectSchema)) });
}

export async function updateReel(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId, reelId } = validParams(res, reelParams);
  res.json({ project: await projects.updateReel(requireAuth(req), workspaceId, projectId, reelId, validBody(req, updateReelSchema)) });
}

export async function variation(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId, reelId } = validParams(res, reelParams);
  res.json({ project: await projects.reelVariation(requireAuth(req), workspaceId, projectId, reelId, validBody(req, reelVariationSchema)) });
}

export async function removeReel(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId, reelId } = validParams(res, reelParams);
  res.json({ project: await projects.deleteReel(requireAuth(req), workspaceId, projectId, reelId) });
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId } = validParams(res, projectParams);
  await projects.deleteProject(requireAuth(req), workspaceId, projectId);
  res.status(204).end();
}

export async function list(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, projectWorkspaceParams);
  const { page, pageSize } = validQuery(res, listProjectsQuery);
  res.json(await projects.listProjects(requireAuth(req), workspaceId, page, pageSize));
}

export async function detail(req: Request, res: Response): Promise<void> {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await projects.getProject(requireAuth(req), workspaceId, projectId) });
}

/** Super admin: which engine runs each stage, whether it's configured, and live throughput. */
export async function engines(_req: Request, res: Response): Promise<void> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [transcriber, hooks, binaries, queue, byStatus, finished, reels] = await Promise.all([
    resolveEngine('transcription').catch(() => null),
    resolveEngine('hooks').catch(() => null),
    versions(),
    queueCounts().catch(() => null),
    prisma.mediaProject.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.mediaProject.findMany({
      where: { status: 'READY', finishedAt: { gte: since }, startedAt: { not: null } },
      select: { startedAt: true, finishedAt: true, durationSec: true },
      take: 200,
      orderBy: { finishedAt: 'desc' },
    }),
    prisma.reel.count({ where: { status: 'READY', createdAt: { gte: since } } }),
  ]);
  const ratios = finished
    .filter((row) => row.startedAt && row.finishedAt && row.durationSec)
    .map((row) => (row.finishedAt!.getTime() - row.startedAt!.getTime()) / 1000 / row.durationSec!);
  res.json({
    stages: [
      { stage: 'UPLOAD', engine: 'Browser → Cloudflare R2 (presigned multipart, 16 MiB parts)', configured: env.R2_ENABLED, detail: env.CF_R2_BUCKET_NAME ?? 'CF_R2_* not set' },
      { stage: 'PROBE', engine: binaries.ffprobe, configured: !binaries.ffprobe.includes('not found'), detail: 'Duration, resolution, rotation, audio presence' },
      { stage: 'AUDIO', engine: binaries.ffmpeg, configured: !binaries.ffmpeg.includes('not found'), detail: '16 kHz mono speech MP3, 20-min chunks' },
      {
        stage: 'TRANSCRIBE',
        engine: transcriber?.label ?? 'not configured',
        configured: transcriber !== null,
        detail: 'OpenAI-compatible /audio/transcriptions with word timestamps. Choose the key and model on the Models page.',
      },
      {
        stage: 'HOOKS',
        engine: hooks?.label ?? 'built-in heuristic scorer',
        configured: true,
        detail: hooks ? (hooks.provider === 'ANTHROPIC' ? 'Claude structured output, adaptive thinking' : 'Chat Completions, strict JSON schema') : 'No AI model selected: rules pick the moments. Choose a model on the Models page.',
      },
      { stage: 'RENDER', engine: `${binaries.ffmpeg} · libx264 · libass`, configured: !binaries.ffmpeg.includes('not found'), detail: '1080×1920 @30fps, CRF 21, AAC 128k, −14 LUFS, +faststart' },
      { stage: 'DELIVER', engine: env.CF_R2_PUBLIC_URL ? 'Cloudflare R2 public URL' : 'Cloudflare R2 signed URLs (1 h)', configured: env.R2_ENABLED, detail: env.CF_R2_PUBLIC_URL ?? 'Private bucket' },
    ],
    worker: { inline: env.MEDIA_WORKER_INLINE, concurrency: env.MEDIA_WORKER_CONCURRENCY, queue },
    last30Days: {
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      reelsProduced: reels,
      medianProcessingRatio: ratios.length ? ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] : null,
    },
  });
}
