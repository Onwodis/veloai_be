/**
 * Shared Redis connection (ioredis).
 *
 * Used by the distributed rate limiter today and by the media job queues the
 * services layer builds on. A single connection is reused process-wide.
 */
import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export const redis = new Redis(env.REDIS_URL, {
  // Fail commands fast instead of queueing forever while Redis is down.
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
});

redis.on('error', (error: Error) => {
  logger.error({ err: error }, 'redis connection error');
});
redis.on('ready', () => {
  logger.info('redis connection ready');
});

export async function connectRedis(): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect();
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status !== 'end') {
    await redis.quit();
  }
}

/** Round-trips a PING; used by the readiness probe. */
export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
