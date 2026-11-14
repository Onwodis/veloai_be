/**
 * `pnpm db:seed`: seeds the super admin and syncs the .env SMTP account.
 * The API also runs both on boot, so this is for fresh databases and CI.
 */
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { syncEnvCredential } from '../services/mail/mail.service.js';
import { seedSuperAdmin } from '../services/seed.service.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  await connectDatabase();
  const admin = await seedSuperAdmin();
  await syncEnvCredential();
  logger.info({ admin }, 'seed complete');
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
