/**
 * Emails the super admins when an AI provider call fails (fal.ai video / image / audio / LLM
 * endpoints, the OpenAI-compatible chat engine, speech-to-text).
 *
 * A burst of the same failure (a dead key, an empty balance, a provider outage) must not send a
 * hundred emails: failures are grouped by service + endpoint + the error's shape, the first one in
 * a 15-minute window emails at once, the rest are counted and reported with the next email.
 * Never throws and never delays the caller (fire and forget).
 */
import { createHash } from 'node:crypto';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { sendMail } from './mail/mail.service.js';
import { aiErrorMail } from './mail/templates.js';

const WINDOW_SECONDS = 15 * 60;

export interface AiFailure {
  /** "fal.ai", "LLM (chat)", "Transcription". */
  service: string;
  /** The model endpoint or model name. */
  endpoint: string;
  error: string;
  /** What was being done ("a generation request", "polling the result"). */
  where: string;
}

/** Errors that say nothing about the provider's health (the user stopped it). */
const IGNORED = /cancel+ed|aborted|stopped by/i;

/** The same failure with different ids / numbers groups together. */
const shape = (error: string): string => error.toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '#').replace(/\d+/g, '#').slice(0, 120);

export function reportAiError(failure: AiFailure): void {
  if (IGNORED.test(failure.error)) return;
  void notify(failure).catch((error: unknown) => logger.warn({ err: error }, 'AI error alert not sent'));
}

async function notify(failure: AiFailure): Promise<void> {
  const id = createHash('sha256').update(`${failure.service}|${failure.endpoint}|${shape(failure.error)}`).digest('hex').slice(0, 24);
  const counter = `${env.APP_SLUG}:ai-alert:${id}`;
  const lock = `${env.APP_SLUG}:ai-alert:lock:${id}`;
  await redis.hincrby(counter, 'count', 1);
  await redis.hsetnx(counter, 'since', new Date().toISOString());
  await redis.expire(counter, WINDOW_SECONDS * 8);
  // Only the first failure in the window emails; the others wait in the counter.
  if ((await redis.set(lock, '1', 'EX', WINDOW_SECONDS, 'NX')) !== 'OK') return;
  const seen = await redis.hgetall(counter);
  await redis.del(counter);
  const admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true } });
  const mail = aiErrorMail({
    service: failure.service,
    endpoint: failure.endpoint,
    error: failure.error.slice(0, 500),
    where: failure.where,
    count: Number(seen['count'] ?? 1),
    since: seen['since'] ? new Date(seen['since']).toUTCString() : new Date().toUTCString(),
    url: `${env.WEB_APP_URL}/dashboard/admin`,
  });
  for (const admin of admins) if (admin.email) await sendMail(admin.email, mail).catch((error: unknown) => logger.warn({ err: error }, 'AI error alert to an admin failed'));
  logger.warn({ service: failure.service, endpoint: failure.endpoint, count: seen['count'] }, 'AI provider error: super admins emailed');
}
