/**
 * Re-encrypts every secret at rest with the current DATA_ENCRYPTION_KEY.
 *
 *   pnpm secrets:rotate
 *
 * Run after setting or changing DATA_ENCRYPTION_KEY (keep the old key in
 * DATA_ENCRYPTION_KEY_PREVIOUS until this has run). Values already on the
 * current key are left alone; anything no configured key can open is
 * reported and skipped. Safe to run more than once.
 */
import 'dotenv/config';
import { connectDatabase, prisma } from '../config/database.js';
import { decryptSecretWithInfo, encryptSecret } from '../utils/encryption.js';

interface Tally {
  rotated: number;
  current: number;
  failed: string[];
}

async function rotate(label: string, rows: { id: string; value: string }[], save: (id: string, value: string) => Promise<unknown>): Promise<Tally> {
  const tally: Tally = { rotated: 0, current: 0, failed: [] };
  for (const row of rows) {
    try {
      const { plaintext, rotated } = decryptSecretWithInfo(row.value);
      if (!rotated) {
        tally.current += 1;
        continue;
      }
      await save(row.id, encryptSecret(plaintext));
      tally.rotated += 1;
    } catch {
      tally.failed.push(row.id);
    }
  }
  console.log(`${label.padEnd(16)} rotated ${tally.rotated}, already current ${tally.current}${tally.failed.length ? `, UNREADABLE ${tally.failed.length} (${tally.failed.join(', ')})` : ''}`);
  return tally;
}

await connectDatabase(); // retries while a suspended Neon compute wakes up

const users = await prisma.user.findMany({ where: { totpSecretEnc: { not: null } }, select: { id: true, totpSecretEnc: true } });
const smtp = await prisma.smtpCredential.findMany({ select: { id: true, passwordEnc: true } });
const ai = await prisma.aiCredential.findMany({ select: { id: true, keyEnc: true } });

const results = [
  await rotate('2FA secrets', users.map((row) => ({ id: row.id, value: row.totpSecretEnc! })), (id, value) => prisma.user.update({ where: { id }, data: { totpSecretEnc: value } })),
  await rotate('SMTP passwords', smtp.map((row) => ({ id: row.id, value: row.passwordEnc })), (id, value) => prisma.smtpCredential.update({ where: { id }, data: { passwordEnc: value } })),
  await rotate('AI keys', ai.map((row) => ({ id: row.id, value: row.keyEnc })), (id, value) => prisma.aiCredential.update({ where: { id }, data: { keyEnc: value } })),
];

await prisma.$disconnect();
const failed = results.reduce((sum, tally) => sum + tally.failed.length, 0);
if (failed > 0) {
  console.error(`\n${failed} secret(s) could not be decrypted with any configured key; they were left unchanged.`);
  process.exit(1);
}
console.log('\nAll secrets are on the current key. DATA_ENCRYPTION_KEY_PREVIOUS (if set) can now be removed.');
