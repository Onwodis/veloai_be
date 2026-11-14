/**
 * `pnpm studio:migrate`: applies src/studio/migrations/*.sql to the database
 * over the direct (non-pooled) Neon host. Idempotent.
 */
import { closeSql, directUrl, migrate } from '../studio/sql.js';

const host = new URL(directUrl()).host;
try {
  const applied = await migrate();
  process.stdout.write(applied.length ? `Applied on ${host}:\n${applied.map((name) => `  ${name}`).join('\n')}\n` : `Studio schema is up to date on ${host}.\n`);
} catch (error) {
  process.stderr.write(`Studio migration failed on ${host}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await closeSql();
}
