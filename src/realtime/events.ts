/**
 * Live job progress, published over Redis pub/sub.
 *
 * The pipeline runs in the worker process (or inline in the API in dev);
 * browsers are connected to the API. Redis pub/sub joins the two: the worker
 * publishes, every API instance subscribes and fans the event out to the
 * WebSocket clients watching that project (realtime/ws.ts).
 *
 * Publishing is fire-and-forget and throttled per project: progress is a
 * nice-to-have and must never slow a render or fail a job.
 */
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

export const PROGRESS_CHANNEL = `${env.APP_SLUG}:progress`;

export interface ProgressEvent {
  /** reels = media project, studio = AI video studio project. */
  kind: 'reels' | 'studio';
  workspaceId: string;
  projectId: string;
  status?: string;
  stage?: string | null;
  /** 0-100 overall. */
  progress?: number;
  /** Human detail for the active node, e.g. "Reel 2 of 5". */
  detail?: string;
  /** Per-reel progress inside RENDER (0-1). */
  reel?: { index: number; total: number; fraction: number };
  /** Studio: one generated take changed state (KEYFRAME → ANIMATING → LIPSYNC → STORING → READY). */
  take?: { id: string; sceneId: string; status: string };
  at: number;
}

const lastSent = new Map<string, number>();

/**
 * Publishes a progress event. `throttleMs` drops events closer together than
 * that for the same project (stage changes pass 0 so they are never dropped).
 */
export function publishProgress(event: Omit<ProgressEvent, 'at'>, throttleMs = 0): void {
  const key = `${event.kind}:${event.projectId}`;
  const now = Date.now();
  if (throttleMs > 0 && now - (lastSent.get(key) ?? 0) < throttleMs) return;
  lastSent.set(key, now);
  if (lastSent.size > 5000) lastSent.clear();
  redis.publish(PROGRESS_CHANNEL, JSON.stringify({ ...event, at: now })).catch((error: unknown) => logger.debug({ err: error }, 'progress publish failed'));
}
