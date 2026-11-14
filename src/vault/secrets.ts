/**
 * Credential vault: provider keys the super admin enters in the console.
 *
 *   - Encrypted with AES-256-GCM (utils/encryption.ts) before the INSERT, so
 *     the database (and its backups) only ever hold ciphertext.
 *   - Written through row-level security as the super admin (withUser): the
 *     platform_secrets policy rejects anyone else in the database itself.
 *   - Never returned by the API: only the last 4 characters.
 *   - At runtime a vault value wins over the .env value (the console is where
 *     a wrong or missing key gets fixed without a redeploy).
 *
 * Reads are synchronous from an in-memory cache, refreshed at boot, every
 * minute, and immediately after each change.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { env } from '../config/env.js';
import { withUser } from '../storage/rls.js';
import { sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';

export const SECRET_DEFS = {
  FAL_KEY: { label: 'fal.ai API key', group: 'AI generation', purpose: 'Images, video, lip sync, upscaling and likeness training.', minLength: 20 },
  ANTHROPIC_API_KEY: { label: 'Anthropic (Claude) API key', group: 'AI generation', purpose: 'Reel hook picking, the AI director, likeness analysis and prompt direction.', minLength: 20 },
  TRANSCRIPTION_API_KEY: { label: 'Transcription API key', group: 'AI generation', purpose: 'Speech-to-text for reels (OpenAI-compatible; endpoint from TRANSCRIPTION_API_URL).', minLength: 20 },
  OPENAI_API_KEY: { label: 'OpenAI API key', group: 'AI generation', purpose: 'Optional: transcription fallback and selectable hook model.', minLength: 20 },
  PAYSTACK_TEST_SECRET_KEY: { label: 'Paystack test secret key', group: 'Payments', purpose: 'Test-mode token and storage checkouts (sk_test_…).', minLength: 20 },
  PAYSTACK_LIVE_SECRET_KEY: { label: 'Paystack live secret key', group: 'Payments', purpose: 'Live token and storage checkouts (sk_live_…).', minLength: 20 },
} as const;
export type SecretName = keyof typeof SECRET_DEFS;
export const SECRET_NAMES = Object.keys(SECRET_DEFS) as SecretName[];

const envValue = (name: SecretName): string | undefined => {
  const value = (env as unknown as Record<string, string | undefined>)[name];
  return value?.trim() ? value.trim() : undefined;
};

let cache = new Map<SecretName, string>();
let timer: NodeJS.Timeout | null = null;

/** The key to use right now: vault first, then .env. */
export function secret(name: SecretName): string | undefined {
  return cache.get(name) ?? envValue(name);
}

export async function loadSecrets(): Promise<void> {
  try {
    const rows = await sql<{ name: SecretName; valueEnc: string }[]>`SELECT name, value_enc FROM platform_secrets`;
    const next = new Map<SecretName, string>();
    for (const row of rows) {
      try {
        next.set(row.name, decryptSecret(row.valueEnc));
      } catch (error) {
        logger.error({ err: error, name: row.name }, 'vault secret could not be decrypted (check DATA_ENCRYPTION_KEY)');
      }
    }
    cache = next;
  } catch (error) {
    // Before migration 002 the table doesn't exist: .env values still work.
    logger.warn({ err: error }, 'credential vault not loaded');
  }
  timer ??= setInterval(() => void loadSecrets(), 60_000);
  timer.unref();
}

/* ------------------------------------------------------------------ console */

export interface SecretView {
  name: SecretName;
  label: string;
  group: string;
  purpose: string;
  /** Where the value in use comes from. */
  source: 'vault' | 'env' | 'missing';
  hint: string | null;
  envAlsoSet: boolean;
  updatedAt: string | null;
}

export async function listSecrets(auth: AuthContext): Promise<SecretView[]> {
  const rows = await withUser(auth, (tx) => tx<{ name: SecretName; last4: string; updatedAt: Date }[]>`SELECT name, last4, updated_at FROM platform_secrets`);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return SECRET_NAMES.map((name) => {
    const row = byName.get(name);
    const fromEnv = envValue(name);
    return {
      name,
      ...SECRET_DEFS[name],
      source: row ? 'vault' : fromEnv ? 'env' : 'missing',
      hint: row ? `••••${row.last4}` : fromEnv ? `••••${fromEnv.slice(-4)}` : null,
      envAlsoSet: Boolean(fromEnv),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
}

export async function saveSecret(auth: AuthContext, name: SecretName, value: string): Promise<void> {
  const clean = value.trim();
  if (clean.length < SECRET_DEFS[name].minLength) throw AppError.badRequest(`That doesn't look like a complete ${SECRET_DEFS[name].label}.`);
  if (name.startsWith('PAYSTACK_') && !clean.startsWith(name.includes('LIVE') ? 'sk_live_' : 'sk_test_')) {
    throw AppError.badRequest(`Paste the secret key (${name.includes('LIVE') ? 'sk_live_' : 'sk_test_'}…), not the public key.`);
  }
  // Encrypted here, in the app: the database only ever receives ciphertext.
  const encrypted = encryptSecret(clean);
  await withUser(auth, (tx) => tx`
    INSERT INTO platform_secrets (name, value_enc, last4, updated_by_id, updated_at)
    VALUES (${name}, ${encrypted}, ${clean.slice(-4)}, ${auth.userId}, now())
    ON CONFLICT (name) DO UPDATE SET value_enc = EXCLUDED.value_enc, last4 = EXCLUDED.last4, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`);
  await loadSecrets();
  logger.info({ actorId: auth.userId, name }, 'vault secret saved');
}

export async function deleteSecret(auth: AuthContext, name: SecretName): Promise<void> {
  await withUser(auth, (tx) => tx`DELETE FROM platform_secrets WHERE name = ${name}`);
  await loadSecrets();
  logger.info({ actorId: auth.userId, name }, 'vault secret removed');
}
