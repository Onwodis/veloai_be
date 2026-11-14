/**
 * Studio job queue (BullMQ, separate from the reel queue so long video
 * generations never block reel renders).
 *
 *   take:<takeId>          generate one take (fal.ai, minutes each)
 *   assemble:<projectId>   join the chosen takes into the film
 *
 * attempts: 1. A take resumes its saved fal.ai request after a restart via
 * recoverStudio(); it is never blindly re-submitted (that would pay twice).
 */
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { runAssembly } from './assemble.js';
import { getStudioSettings } from './settings.js';
import { sql } from './sql.js';
import { runTake } from './takes.js';

const QUEUE = `${env.APP_SLUG}-studio`;
const connection = (): Redis => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

let queue: Queue | null = null;
function studioQueue(): Queue {
  queue ??= new Queue(QUEUE, { connection: connection(), defaultJobOptions: { attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 } });
  return queue;
}

async function add(name: 'take' | 'assemble' | 'likeness' | 'creation', id: string): Promise<void> {
  const jobId = `${name}-${id}`;
  const existing = await studioQueue().getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active' || state === 'waiting' || state === 'delayed') return;
    await existing.remove().catch(() => undefined);
  }
  await studioQueue().add(name, { id }, { jobId });
}

export const enqueueTake = (takeId: string): Promise<void> => add('take', takeId);
export const enqueueAssembly = (projectId: string): Promise<void> => add('assemble', projectId);
/** Build a user's likeness (frames, voice, analysis, identity training). */
export const enqueueLikeness = (userId: string): Promise<void> => add('likeness', userId);
/** One @me / prompt / enhancement creation. */
export const enqueueCreation = (creationId: string): Promise<void> => add('creation', creationId);

export async function studioQueueCounts(): Promise<Record<string, number>> {
  return studioQueue().getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
}

let worker: Worker | null = null;

export async function startStudioWorker(): Promise<void> {
  if (worker) return;
  const concurrency = await getStudioSettings()
    .then((settings) => settings.limits.concurrency)
    .catch(() => 3);
  worker = new Worker(
    QUEUE,
    async (job) => {
      const { id } = job.data as { id: string };
      if (job.name === 'take') await runTake(id);
      else if (job.name === 'assemble') await runAssembly(id);
      // Imported lazily: these modules import this queue to enqueue work.
      else if (job.name === 'likeness') await (await import('../likeness/job.js')).runLikeness(id);
      else if (job.name === 'creation') await (await import('../creations/job.js')).runCreation(id);
    },
    // Generations poll fal.ai for many minutes; the lock is renewed automatically while the job runs.
    { connection: connection(), concurrency, lockDuration: 10 * 60_000 },
  );
  worker.on('failed', (job, error) => logger.error({ err: error, jobId: job?.id }, 'studio job crashed'));
  logger.info({ queue: QUEUE, concurrency }, 'studio worker started');
}

export function studioWorkerRunning(): boolean {
  return worker !== null && worker.isRunning();
}

/** Puts takes / assemblies that lost their job (restart) back on the queue. */
export async function recoverStudio(): Promise<number> {
  const takes = await sql<{ id: string }[]>`SELECT id FROM studio_takes WHERE status IN ('QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING')`;
  for (const take of takes) await enqueueTake(take.id);
  // An interrupted cut is NEVER restarted on its own: a restart would pay for every upscale again
  // (the old requests keep running and billing). It becomes "paused"; the creator presses Continue,
  // which reuses every upscale already delivered (cached next to its take) or still in flight (pending marker).
  const projects = await sql<{ id: string; workspaceId: string; outputKey: string | null; assemblyReservationId: string | null }[]>`
    SELECT id, workspace_id, output_key, assembly_reservation_id FROM studio_projects WHERE status = 'ASSEMBLING'`;
  for (const project of projects) {
    // Still being cut by a live worker (another instance): leave it alone.
    const job = await studioQueue().getJob(`assemble-${project.id}`);
    if (job && (await job.getState()) === 'active') continue;
    await pauseInterruptedAssembly(project);
  }
  // Tables from migration 002; absent until it is applied.
  const likeness = await sql<{ userId: string }[]>`SELECT user_id FROM likeness_profiles WHERE status IN ('ANALYZING', 'TRAINING')`.catch(() => []);
  const creations = await sql<{ id: string }[]>`SELECT id FROM creations WHERE status IN ('QUEUED', 'DIRECTING', 'IMAGING', 'ANIMATING', 'ENHANCING', 'STORING')`.catch(() => []);
  for (const row of likeness) await enqueueLikeness(row.userId);
  for (const row of creations) await enqueueCreation(row.id);
  return takes.length + projects.length + likeness.length + creations.length;
}

/** True while a worker is actually cutting this project. */
export async function assemblyRunning(projectId: string): Promise<boolean> {
  const job = await studioQueue().getJob(`assemble-${projectId}`).catch(() => undefined);
  if (!job) return false;
  const state = await job.getState().catch(() => 'unknown');
  return state === 'active' || state === 'waiting' || state === 'delayed';
}

/** Marks a cut that lost its worker as paused and frees its token hold (nothing is charged). */
export async function pauseInterruptedAssembly(project: { id: string; workspaceId: string; outputKey: string | null; assemblyReservationId: string | null }): Promise<void> {
  if (project.assemblyReservationId) {
    const { releaseSystem } = await import('../services/token.service.js');
    await releaseSystem(project.assemblyReservationId, project.workspaceId).catch(() => undefined);
  }
  const entry = { at: new Date().toISOString(), stage: 'PAUSED', engine: 'paused: the cut was interrupted (server restart); nothing running or charged', ms: 0 };
  await sql`
    UPDATE studio_projects SET status = ${project.outputKey ? 'READY' : 'DRAFT'}, stage = NULL, progress = 0, cancel_requested = false, cancel_keep = false,
      assembly_reservation_id = NULL, engine_log = COALESCE(engine_log, '[]'::jsonb) || ${sql.json([entry])}, updated_at = now()
    WHERE id = ${project.id} AND status = 'ASSEMBLING'`;
  logger.warn({ projectId: project.id }, 'interrupted assembly paused (not restarted: Continue resumes it)');
}

export async function stopStudio(): Promise<void> {
  await Promise.allSettled([worker?.close(), queue?.close()]);
}
