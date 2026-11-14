/**
 * `pnpm storage:backfill`: lists every object in the bucket and records it in
 * the storage ledger (owner resolved by the database from the key), so files
 * stored before per-user accounting existed count towards their owner.
 * Also removes ledger rows whose object no longer exists. Idempotent.
 */
import { listObjects } from '../services/storage.service.js';
import { closeSql, sql } from '../studio/sql.js';

let added = 0;
try {
  const objects = (await Promise.all(['workspaces/', 'users/', 'avatars/'].map((prefix) => listObjects(prefix)))).flat();
  for (const object of objects) {
    const rows = await sql`
      INSERT INTO storage_objects (key, bytes, kind) VALUES (${object.key}, ${object.size}, 'GENERATED')
      ON CONFLICT (key) DO UPDATE SET bytes = EXCLUDED.bytes WHERE storage_objects.bytes <> EXCLUDED.bytes RETURNING key`;
    added += rows.length;
  }
  const present = new Set(objects.map((object) => object.key));
  const ledger = await sql<{ key: string }[]>`SELECT key FROM storage_objects`;
  const stale = ledger.filter((row) => !present.has(row.key)).map((row) => row.key);
  if (stale.length) await sql`DELETE FROM storage_objects WHERE key IN ${sql(stale)}`;
  const totals = await sql<{ email: string; usedBytes: string; files: number }[]>`
    SELECT u.email, a.used_bytes::text, a.files FROM storage_accounts a JOIN users u ON u.id = a.user_id ORDER BY a.used_bytes DESC LIMIT 20`;
  process.stdout.write(`Scanned ${objects.length} objects: ${added} recorded/updated, ${stale.length} stale rows removed.\n`);
  for (const row of totals) process.stdout.write(`  ${row.email.padEnd(36)} ${(Number(row.usedBytes) / 1048576).toFixed(1).padStart(9)} MB  ${row.files} files\n`);
} catch (error) {
  process.stderr.write(`Backfill failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await closeSql();
}
