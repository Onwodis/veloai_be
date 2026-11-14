/**
 * Scheduled jobs ("cron") registry.
 *
 * Every recurring task the API runs is registered here with its interval, so
 * the super admin console can list them, see when each last ran, how long it
 * took, what it did or why it failed, and trigger one immediately.
 *
 * State is in-memory per API process (it resets on restart). A run that is
 * still in progress is never started twice.
 */
import { logger } from '../utils/logger.js';

export interface JobDefinition {
  name: string;
  description: string;
  intervalMs: number;
  /** Returns a short human summary of what the run did. */
  run: () => Promise<string>;
  /** Also run once shortly after boot. */
  runOnBoot?: boolean;
}

export interface JobStatus {
  name: string;
  description: string;
  intervalMs: number;
  running: boolean;
  runs: number;
  failures: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastResult: string | null;
  lastError: string | null;
  nextRunAt: string | null;
}

interface JobState extends JobDefinition {
  timer: NodeJS.Timeout | null;
  running: boolean;
  runs: number;
  failures: number;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastResult: string | null;
  lastError: string | null;
  nextRunAt: Date | null;
}

const jobs = new Map<string, JobState>();

/** Prisma codes for "database unreachable / connection dropped / pool timeout". */
const TRANSIENT = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

async function execute(job: JobState, trigger: 'schedule' | 'manual' | 'boot'): Promise<JobStatus> {
  if (job.running) return toStatus(job);
  job.running = true;
  job.lastStartedAt = new Date();
  const started = Date.now();
  try {
    const result = await job.run();
    job.lastOk = true;
    job.lastResult = result.slice(0, 300);
    job.lastError = null;
    if (trigger === 'manual') logger.info({ job: job.name, result }, 'job run manually');
  } catch (error) {
    job.failures += 1;
    job.lastOk = false;
    // Prisma messages end with the useful line; keep that, not the stack.
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.trim().split('\n').filter(Boolean).pop() ?? raw;
    const code = (error as { code?: string; errorCode?: string }).code ?? (error as { errorCode?: string }).errorCode;
    job.lastError = `${code ? `${code}: ` : ''}${message}`.slice(0, 400);
    // Lost database/Redis connections (restart, sleep) heal on the next run.
    const transient = TRANSIENT.has(code ?? '') || /can't reach|connection (closed|refused|terminated)|ECONNRESET|ECONNREFUSED|timed out/i.test(raw);
    logger[transient ? 'warn' : 'error']({ job: job.name, code, error: job.lastError }, transient ? 'scheduled job skipped: dependency unavailable' : 'scheduled job failed');
  } finally {
    job.runs += 1;
    job.running = false;
    job.lastFinishedAt = new Date();
    job.lastDurationMs = Date.now() - started;
    if (job.timer) job.nextRunAt = new Date(Date.now() + job.intervalMs);
  }
  return toStatus(job);
}

function toStatus(job: JobState): JobStatus {
  const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
  return {
    name: job.name,
    description: job.description,
    intervalMs: job.intervalMs,
    running: job.running,
    runs: job.runs,
    failures: job.failures,
    lastStartedAt: iso(job.lastStartedAt),
    lastFinishedAt: iso(job.lastFinishedAt),
    lastDurationMs: job.lastDurationMs,
    lastOk: job.lastOk,
    lastResult: job.lastResult,
    lastError: job.lastError,
    nextRunAt: iso(job.nextRunAt),
  };
}

/** Registers and starts a job. Re-registering a name replaces the old one. */
export function scheduleJob(definition: JobDefinition): void {
  const previous = jobs.get(definition.name);
  if (previous?.timer) clearInterval(previous.timer);
  const job: JobState = {
    ...definition,
    timer: null,
    running: false,
    runs: 0,
    failures: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    lastOk: null,
    lastResult: null,
    lastError: null,
    nextRunAt: new Date(Date.now() + definition.intervalMs),
  };
  job.timer = setInterval(() => void execute(job, 'schedule'), definition.intervalMs);
  job.timer.unref();
  jobs.set(definition.name, job);
  if (definition.runOnBoot) setTimeout(() => void execute(job, 'boot'), 5_000).unref();
}

export function listJobs(): JobStatus[] {
  return [...jobs.values()].map(toStatus);
}

export function hasJob(name: string): boolean {
  return jobs.has(name);
}

export async function runJobNow(name: string): Promise<JobStatus | null> {
  const job = jobs.get(name);
  return job ? execute(job, 'manual') : null;
}

export function stopJobs(): void {
  for (const job of jobs.values()) {
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
    job.nextRunAt = null;
  }
}
