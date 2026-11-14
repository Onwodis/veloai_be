/**
 * Media job queue (BullMQ on the existing Redis).
 *
 * - One job per project, id = project id (enqueueing twice is a no-op).
 * - attempts: 1 - the pipeline settles tokens itself, so an automatic retry
 *   could double-charge; users retry explicitly instead.
 * - The worker runs inside the API process when MEDIA_WORKER_INLINE=true
 *   (local dev) or as its own process via `pnpm worker` (production).
 */
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { runProject } from './pipeline.js';

const QUEUE = `${env.APP_SLUG}-media`;

// BullMQ needs its own connections with maxRetriesPerRequest disabled.
const connection = (): Redis => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

let queue: Queue | null = null;
function mediaQueue(): Queue {
  queue ??= new Queue(QUEUE, { connection: connection(), defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 } });
  return queue;
}

export async function enqueueProject(projectId: string): Promise<void> {
  await mediaQueue().add('process', { projectId }, { jobId: projectId });
}

/** Re-runs a project (after a failure); the old job id must be cleared first. */
export async function requeueProject(projectId: string): Promise<void> {
  const existing = await mediaQueue().getJob(projectId);
  if (existing) await existing.remove().catch(() => undefined);
  await enqueueProject(projectId);
}

export async function queueCounts(): Promise<Record<string, number>> {
  return mediaQueue().getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
}

/** Latest failed jobs, for the admin console. */
export async function recentFailedJobs(limit = 6): Promise<Array<{ id: string; reason: string; failedAt: string | null }>> {
  const jobs = await mediaQueue().getFailed(0, limit - 1);
  return jobs.map((job) => ({
    id: String(job.id),
    reason: (job.failedReason ?? 'unknown').slice(0, 300),
    failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  }));
}

export function workerRunning(): boolean {
  return worker !== null && worker.isRunning();
}

let worker: Worker | null = null;

export function startWorker(): Worker {
  worker ??= new Worker(
    QUEUE,
    async (job) => {
      await runProject((job.data as { projectId: string }).projectId);
    },
    { connection: connection(), concurrency: env.MEDIA_WORKER_CONCURRENCY, lockDuration: 5 * 60_000 },
  );
  worker.on('failed', (job, error) => logger.error({ err: error, jobId: job?.id }, 'media job crashed'));
  logger.info({ queue: QUEUE, concurrency: env.MEDIA_WORKER_CONCURRENCY }, 'media worker started');
  return worker;
}

/**
 * After a restart, projects that were mid-flight have no live job: put them
 * back on the queue so nothing is stuck at "processing" forever.
 */
export async function recoverStuckProjects(): Promise<number> {
  const stuck = await prisma.mediaProject.findMany({ where: { status: { in: ['QUEUED', 'PROCESSING'] } }, select: { id: true } });
  for (const project of stuck) {
    const job = await mediaQueue().getJob(project.id);
    const state = job ? await job.getState() : 'missing';
    if (state === 'missing' || state === 'completed' || state === 'failed') {
      await prisma.mediaProject.update({ where: { id: project.id }, data: { status: 'QUEUED', progress: 0, stage: null } });
      await requeueProject(project.id);
    }
  }
  return stuck.length;
}

export async function stopMedia(): Promise<void> {
  await Promise.allSettled([worker?.close(), queue?.close()]);
}
