/**
 * AI engines: credentials (encrypted keys) and which model runs each step.
 *
 * Steps
 *   transcription - speech-to-text with word timestamps; needs an
 *                   OpenAI-compatible provider (OpenAI, Groq, custom)
 *   hooks         - picks moments, writes titles/captions/hashtags; any LLM
 *                   provider (Anthropic Claude, OpenAI, Groq, custom), or
 *                   none = built-in heuristic
 *
 * Keys are encrypted with AES-256-GCM (DATA_ENCRYPTION_KEY) before they are
 * written and are decrypted only in memory when a job calls the provider.
 * The API never returns a key, only its last four characters.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AiCredential, AiProvider, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { secret } from '../vault/secrets.js';
import { AppError } from '../utils/AppError.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';

export const PROVIDER_BASE_URL: Partial<Record<AiProvider, string>> = {
  OPENAI: 'https://api.openai.com/v1',
  GROQ: 'https://api.groq.com/openai/v1',
};

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  ANTHROPIC: 'Anthropic (Claude)',
  OPENAI: 'OpenAI',
  GROQ: 'Groq',
  OPENAI_COMPATIBLE: 'OpenAI-compatible',
};

/** Suggested models shown before a key has been verified. */
export const SUGGESTED_MODELS = {
  transcription: { OPENAI: ['whisper-1'], GROQ: ['whisper-large-v3-turbo', 'whisper-large-v3'] } as Partial<Record<AiProvider, string[]>>,
  hooks: { ANTHROPIC: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] } as Partial<Record<AiProvider, string[]>>,
};

export type AiStep = 'transcription' | 'hooks';

const assignmentSchema = z.object({ credentialId: z.uuid().nullable(), model: z.string().trim().max(120) });
const aiSettingsSchema = z.object({ transcription: assignmentSchema, hooks: assignmentSchema });
export type AiSettings = z.infer<typeof aiSettingsSchema>;

const SETTINGS_KEY = 'ai';

export interface ResolvedEngine {
  provider: AiProvider;
  baseUrl: string | null;
  apiKey: string;
  model: string;
  label: string;
}

/* ------------------------------------------------------------------ views */

export interface PublicAiCredential {
  id: string;
  provider: AiProvider;
  providerLabel: string;
  label: string;
  source: 'ENV' | 'DASHBOARD';
  baseUrl: string | null;
  keyHint: string;
  models: string[];
  lastVerifiedAt: string | null;
  lastVerifyOk: boolean | null;
  lastVerifyError: string | null;
  createdAt: string;
}

const view = (row: AiCredential): PublicAiCredential => ({
  id: row.id,
  provider: row.provider,
  providerLabel: PROVIDER_LABEL[row.provider],
  label: row.label,
  source: row.source,
  baseUrl: row.baseUrl,
  keyHint: `••••${row.keyLast4}`,
  models: row.models,
  lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
  lastVerifyOk: row.lastVerifyOk,
  lastVerifyError: row.lastVerifyError,
  createdAt: row.createdAt.toISOString(),
});

const baseUrlFor = (row: Pick<AiCredential, 'provider' | 'baseUrl'>): string | null => row.baseUrl ?? PROVIDER_BASE_URL[row.provider] ?? null;

/* ------------------------------------------------------------------ settings */

let cache: { value: AiSettings; at: number } | null = null;

export async function getAiSettings(): Promise<AiSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const parsed = row ? aiSettingsSchema.safeParse(row.value) : null;
  const value = parsed?.success ? parsed.data : await defaultSettings();
  cache = { value, at: Date.now() };
  return value;
}

/** First run: use whatever the .env provided. */
async function defaultSettings(): Promise<AiSettings> {
  const envRows = await prisma.aiCredential.findMany({ where: { source: 'ENV' } });
  const transcriber = envRows.find((row) => row.provider !== 'ANTHROPIC');
  const claude = envRows.find((row) => row.provider === 'ANTHROPIC');
  return {
    transcription: { credentialId: transcriber?.id ?? null, model: env.TRANSCRIPTION_MODEL },
    hooks: { credentialId: claude?.id ?? null, model: env.CLAUDE_MODEL },
  };
}

export async function updateAiSettings(patch: Partial<AiSettings>, actorId: string): Promise<AiSettings> {
  const next = aiSettingsSchema.parse({ ...(await getAiSettings()), ...patch });
  for (const step of ['transcription', 'hooks'] as const) {
    const { credentialId, model } = next[step];
    if (!credentialId) {
      if (step === 'transcription') throw AppError.badRequest('Transcription needs an engine: there is no built-in fallback for speech-to-text.');
      continue;
    }
    const credential = await prisma.aiCredential.findUnique({ where: { id: credentialId } });
    if (!credential) throw AppError.badRequest(`The ${step} credential no longer exists`);
    if (step === 'transcription' && credential.provider === 'ANTHROPIC') throw AppError.badRequest('Anthropic has no speech-to-text API; choose OpenAI, Groq or an OpenAI-compatible provider for transcription.');
    if (!model) throw AppError.badRequest(`Choose a model for ${step}`);
  }
  await prisma.platformSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue, updatedById: actorId },
    create: { key: SETTINGS_KEY, value: next as unknown as Prisma.InputJsonValue, updatedById: actorId },
  });
  cache = { value: next, at: Date.now() };
  logger.info({ actorId, transcription: next.transcription.model, hooks: next.hooks.model || 'heuristic' }, 'AI engine settings updated');
  return next;
}

/** What a pipeline step should call right now, or null (hooks → heuristic). */
export async function resolveEngine(step: AiStep): Promise<ResolvedEngine | null> {
  const { credentialId, model } = (await getAiSettings())[step];
  if (!credentialId) return null;
  const row = await prisma.aiCredential.findUnique({ where: { id: credentialId } });
  if (!row) return null;
  return { provider: row.provider, baseUrl: baseUrlFor(row), apiKey: decryptSecret(row.keyEnc), model, label: `${model} · ${PROVIDER_LABEL[row.provider]}${row.source === 'ENV' ? ' (.env)' : ''}` };
}

/* ------------------------------------------------------------------ credentials */

export async function listCredentials(): Promise<PublicAiCredential[]> {
  return (await prisma.aiCredential.findMany({ orderBy: [{ source: 'asc' }, { createdAt: 'asc' }] })).map(view);
}

export async function createCredential(input: { provider: AiProvider; label: string; apiKey: string; baseUrl?: string | undefined }, actorId: string): Promise<PublicAiCredential> {
  if (input.provider === 'OPENAI_COMPATIBLE' && !input.baseUrl) throw AppError.badRequest('A base URL is required for an OpenAI-compatible provider');
  const row = await prisma.aiCredential.create({
    data: {
      provider: input.provider,
      label: input.label,
      baseUrl: input.provider === 'OPENAI_COMPATIBLE' ? input.baseUrl!.replace(/\/+$/, '') : null,
      keyEnc: encryptSecret(input.apiKey.trim()),
      keyLast4: input.apiKey.trim().slice(-4),
      createdById: actorId,
    },
  });
  return verifyCredential(row.id);
}

export async function deleteCredential(id: string): Promise<void> {
  const row = await prisma.aiCredential.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('Credential');
  if (row.source === 'ENV') throw AppError.badRequest('This key comes from the API .env; remove it there instead');
  const settings = await getAiSettings();
  if (settings.transcription.credentialId === id || settings.hooks.credentialId === id) throw AppError.badRequest('This key is in use; switch the step to another engine first');
  await prisma.aiCredential.delete({ where: { id } });
}

/** Calls the provider with the key and records which models it can use. */
export async function verifyCredential(id: string): Promise<PublicAiCredential> {
  const row = await prisma.aiCredential.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('Credential');
  const apiKey = decryptSecret(row.keyEnc);
  let models: string[] = [];
  let error: string | null = null;
  try {
    if (row.provider === 'ANTHROPIC') {
      const client = new Anthropic({ apiKey, authToken: null, timeout: 20_000, maxRetries: 1 });
      for await (const model of client.models.list()) models.push(model.id);
    } else {
      const base = baseUrlFor(row);
      const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const body = (await response.json()) as { data?: { id: string }[] };
      models = (body.data ?? []).map((item) => item.id);
    }
    models = [...new Set(models)].sort();
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : String(caught)).replace(apiKey, '***').slice(0, 480);
  }
  const updated = await prisma.aiCredential.update({
    where: { id },
    data: { lastVerifiedAt: new Date(), lastVerifyOk: error === null, lastVerifyError: error, ...(error === null ? { models } : {}) },
  });
  logger.info({ credentialId: id, provider: row.provider, ok: error === null, models: models.length }, 'AI credential verified');
  return view(updated);
}

/* ------------------------------------------------------------------ .env sync */

function providerFromUrl(url: string): AiProvider {
  if (url.includes('api.openai.com')) return 'OPENAI';
  if (url.includes('api.groq.com')) return 'GROQ';
  return 'OPENAI_COMPATIBLE';
}

async function upsertEnvRow(provider: AiProvider, apiKey: string, baseUrl: string | null): Promise<void> {
  const existing = await prisma.aiCredential.findFirst({ where: { source: 'ENV', provider } });
  const data = { keyEnc: encryptSecret(apiKey), keyLast4: apiKey.slice(-4), baseUrl: provider === 'OPENAI_COMPATIBLE' ? baseUrl : null };
  if (existing && decryptSecret(existing.keyEnc) === apiKey && existing.baseUrl === data.baseUrl) return;
  if (existing) await prisma.aiCredential.update({ where: { id: existing.id }, data: { ...data, models: [], lastVerifyOk: null, lastVerifyError: null, lastVerifiedAt: null } });
  else await prisma.aiCredential.create({ data: { ...data, provider, label: 'From .env', source: 'ENV' } });
}

/** Mirrors ANTHROPIC_API_KEY / TRANSCRIPTION_API_KEY / OPENAI_API_KEY into credentials. */
export async function syncEnvAiCredentials(): Promise<void> {
  const anthropicKey = secret('ANTHROPIC_API_KEY');
  if (anthropicKey) await upsertEnvRow('ANTHROPIC', anthropicKey, null);
  const transcriptionKey = secret('TRANSCRIPTION_API_KEY') ?? secret('OPENAI_API_KEY');
  if (transcriptionKey) {
    const url = secret('TRANSCRIPTION_API_KEY') ? env.TRANSCRIPTION_API_URL : 'https://api.openai.com/v1';
    await upsertEnvRow(providerFromUrl(url), transcriptionKey, url.replace(/\/+$/, ''));
  }
  if (secret('OPENAI_API_KEY') && secret('TRANSCRIPTION_API_KEY') && providerFromUrl(env.TRANSCRIPTION_API_URL) !== 'OPENAI') {
    await upsertEnvRow('OPENAI', secret('OPENAI_API_KEY')!, null);
  }
  cache = null;
}
