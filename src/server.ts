/**
 * Process entry point: connects dependencies, starts HTTP, and shuts down
 * gracefully on SIGTERM/SIGINT (drain connections → close DB/Redis → exit).
 */
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase, prisma } from './config/database.js';
import { env } from './config/env.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { recoverStuckProjects, startWorker, stopMedia } from './media/queue.js';
import { recoverStudio, startStudioWorker, stopStudio } from './studio/queue.js';
import { closeSql } from './studio/sql.js';
import { BIN_DAYS, purgeExpiredBin } from './studio/service.js';
import { runStorageLifecycle } from './storage/lifecycle.js';
import { migrate } from './studio/sql.js';
import { attachRealtime } from './realtime/ws.js';
import { purgeExpiredRefreshTokens } from './services/auth.service.js';
import { syncEnvAiCredentials } from './services/ai.service.js';
import { loadSecrets } from './vault/secrets.js';
import { scheduleJob, stopJobs } from './services/jobs.service.js';
import { syncEnvCredential, verifyAllCredentials } from './services/mail/mail.service.js';
import { keyStatus, verifyKey } from './services/paystack.service.js';
import { seedSuperAdmin } from './services/seed.service.js';
import { expireReservations } from './services/token.service.js';
import { logger } from './utils/logger.js';
import { getDummyHash } from './utils/password.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const PURGE_INTERVAL_MS = HOUR;
const ACTIVITY_RETENTION_DAYS = 180;

async function main(): Promise<void> {
  await Promise.all([connectDatabase(), connectRedis(), getDummyHash()]);
  for (const warning of env.CONFIG_WARNINGS) logger.warn(warning);

  // Idempotent bootstrap. Failures (e.g. migrations not applied yet) are
  // logged rather than fatal so the API still serves health checks.
  await seedSuperAdmin().catch((error: unknown) => logger.error({ err: error }, 'super admin seed failed'));
  await syncEnvCredential().catch((error: unknown) => logger.error({ err: error }, 'SMTP credential sync failed'));
  await loadSecrets();
  await syncEnvAiCredentials().catch((error: unknown) => logger.error({ err: error }, 'AI credential sync failed'));

  // Direct-SQL migrations at boot (idempotent, one transaction per file). Code that ships with a
  // migration must never run against the old schema: if this fails the studio worker stays off,
  // so nothing paid (video, upscale, master) can start against missing columns.
  const schemaReady = await migrate()
    .then((applied) => {
      if (applied.length) logger.info({ applied }, 'studio migrations applied at boot');
      return true;
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'studio migrations failed at boot: studio worker NOT started (fix, then restart or run pnpm studio:migrate)');
      return false;
    });

  if (env.MEDIA_WORKER_INLINE) {
    startWorker();
    if (schemaReady) await startStudioWorker().catch((error: unknown) => logger.error({ err: error }, 'studio worker failed to start'));
    await recoverStudio()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'requeued unfinished studio jobs');
      })
      .catch((error: unknown) => logger.error({ err: error }, 'studio recovery failed (run pnpm studio:migrate?)'));
    await recoverStuckProjects()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'requeued unfinished media projects');
      })
      .catch((error: unknown) => logger.error({ err: error }, 'media project recovery failed'));
  }

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, `${env.APP_NAME} api listening`);
  });
  // Keep-alive must outlive any load balancer idle timeout (typically 60s).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Relayed uploads (large videos on slow links) can take longer than Node's 5-minute default.
  server.requestTimeout = 2 * 60 * 60 * 1000;
  // Live job progress over WebSockets (/api/v1/ws).
  const stopRealtime = attachRealtime(server);

  // Recurring work, visible (and runnable) in the super admin console.
  scheduleJob({
    name: 'purge-refresh-tokens',
    description: 'Deletes expired refresh tokens',
    intervalMs: PURGE_INTERVAL_MS,
    run: async () => `${await purgeExpiredRefreshTokens()} token(s) purged`,
  });
  scheduleJob({
    name: 'expire-token-reservations',
    description: 'Releases token holds whose task never settled (crash, abandoned upload)',
    intervalMs: 5 * MINUTE,
    run: async () => `${await expireReservations()} reservation(s) released`,
  });
  scheduleJob({
    name: 'verify-mail-handshakes',
    description: 'Re-runs the SMTP handshake on every mail account',
    intervalMs: 6 * HOUR,
    run: async () => {
      const { ok, failed } = await verifyAllCredentials();
      return `${ok} ok, ${failed} failed`;
    },
  });
  scheduleJob({
    name: 'verify-paystack-keys',
    description: 'Authenticates the configured Paystack test/live keys',
    intervalMs: 6 * HOUR,
    runOnBoot: true,
    run: async () => {
      const modes = (['TEST', 'LIVE'] as const).filter((mode) => keyStatus()[mode]);
      const checks = await Promise.all(modes.map((mode) => verifyKey(mode)));
      return checks.length ? checks.map((check) => `${check.mode.toLowerCase()} ${check.ok ? 'ok' : 'failed'}`).join(', ') : 'no keys configured';
    },
  });
  scheduleJob({
    name: 'prune-activity-logs',
    description: `Deletes request activity logs older than ${ACTIVITY_RETENTION_DAYS} days`,
    intervalMs: 24 * HOUR,
    run: async () => {
      const { count } = await prisma.activityLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - ACTIVITY_RETENTION_DAYS * 24 * HOUR) } } });
      return `${count} row(s) deleted`;
    },
  });
  scheduleJob({
    name: 'purge-project-bin',
    description: `Permanently deletes studio / music video projects left in the bin for ${BIN_DAYS} days`,
    intervalMs: 24 * HOUR,
    runOnBoot: true,
    run: async () => `${await purgeExpiredBin()} project(s) purged`,
  });
  scheduleJob({
    name: 'storage-lifecycle',
    description: 'Paid storage: renewal reminders before a pack ends, over-quota warnings, and removal of the oldest generated files after the grace period',
    intervalMs: HOUR,
    run: runStorageLifecycle,
  });
  if (env.MEDIA_WORKER_INLINE) {
    scheduleJob({
      name: 'recover-media-jobs',
      description: 'Requeues media projects left without a live job',
      intervalMs: 10 * MINUTE,
      run: async () => `${await recoverStuckProjects()} project(s) checked`,
    });
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopJobs();
    void stopRealtime();

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((closeError) => {
      if (closeError) logger.error({ err: closeError }, 'error while closing http server');
      Promise.allSettled([stopMedia(), stopStudio(), disconnectDatabase(), closeSql(), disconnectRedis()])
        .then(() => {
          logger.info('shutdown complete');
          process.exit(closeError ? 1 : 0);
        })
        .catch(() => process.exit(1));
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  process.exit(1);
});

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
