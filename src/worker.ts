/**
 * Standalone media worker: `pnpm worker`. Run one (or more) of these next to
 * the API in production and set MEDIA_WORKER_INLINE=false on the API.
 * Processes both queues: reels and the AI video studio.
 */
// Must run before any socket opens (slow-link connect timeouts).
import './config/network.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { recoverStuckProjects, startWorker, stopMedia } from './media/queue.js';
import { recoverStudio, startStudioWorker, stopStudio } from './studio/queue.js';
import { closeSql, migrate } from './studio/sql.js';
import { logger } from './utils/logger.js';
import { loadSecrets } from './vault/secrets.js';

await connectDatabase();
await loadSecrets();
startWorker();
// Same gate as the API: the studio worker never runs against an old schema.
const schemaReady = await migrate()
  .then((applied) => {
    if (applied.length) logger.info({ applied }, 'studio migrations applied at boot');
    return true;
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, 'studio migrations failed: studio worker NOT started');
    return false;
  });
if (schemaReady) await startStudioWorker();
const recovered = await recoverStuckProjects();
if (recovered) logger.info({ recovered }, 'requeued unfinished projects');
const studioRecovered = await recoverStudio().catch((error: unknown) => {
  logger.error({ err: error }, 'studio recovery failed (run pnpm studio:migrate?)');
  return 0;
});
if (studioRecovered) logger.info({ studioRecovered }, 'requeued unfinished studio jobs');

const shutdown = (): void => {
  logger.info('media worker shutting down');
  void Promise.allSettled([stopMedia(), stopStudio()]).finally(() => void Promise.allSettled([disconnectDatabase(), closeSql()]).finally(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
