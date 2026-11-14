/**
 * `pnpm storage:check`: proves the R2 configuration end to end.
 *   1. bucket reachable with these credentials
 *   2. write a small object, read it back via a signed URL (and the public
 *      URL if configured), delete it
 *   3. bucket CORS allows the web app's origins to PUT upload parts
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { checkBucket, deletePrefix, ensureBucketCors, readUrl, uploadFile } from '../services/storage.service.js';

const steps: [string, boolean, string?][] = [];
const step = async (name: string, fn: () => Promise<string | void>): Promise<void> => {
  try {
    const detail = await fn();
    steps.push([name, true, detail ?? undefined]);
  } catch (error) {
    steps.push([name, false, error instanceof Error ? `${error.name}: ${error.message}` : String(error)]);
  }
};

const prefix = `_healthcheck/${Date.now()}`;
const key = `${prefix}/hello.txt`;
const body = `storage check ${new Date().toISOString()}`;
const dir = mkdtempSync(join(tmpdir(), 'r2-check-'));

await step('bucket reachable', async () => {
  await checkBucket();
  return `${env.CF_R2_BUCKET_NAME} @ ${env.CF_R2_ACCOUNT_ID?.slice(0, 6)}….r2.cloudflarestorage.com`;
});
await step('write object', async () => {
  writeFileSync(join(dir, 'hello.txt'), body);
  await uploadFile(key, join(dir, 'hello.txt'), 'text/plain');
  return key;
});
await step('read via signed URL', async () => {
  const response = await fetch(await readUrl(key, 'hello.txt'));
  const text = await response.text();
  if (text !== body) throw new Error(`HTTP ${response.status}, body mismatch`);
  return `HTTP ${response.status}`;
});
if (env.CF_R2_PUBLIC_URL) {
  await step('read via public URL', async () => {
    const response = await fetch(await readUrl(key));
    if (!response.ok) throw new Error(`HTTP ${response.status} (is public access enabled on the bucket?)`);
    return `HTTP ${response.status}`;
  });
}
await step('delete object', async () => `${await deletePrefix(prefix)} object(s) removed`);
await step('CORS for browser uploads', async () => `${await ensureBucketCors()} (origins: ${env.CORS_ORIGINS.join(', ')})`);

rmSync(dir, { recursive: true, force: true });
for (const [name, ok, detail] of steps) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
process.exitCode = steps.every(([, ok]) => ok) ? 0 : 1;
