/**
 * Launch guard: everything that must be true before the platform takes real
 * users, checked live. Each check is independent and reports ok / warn / fail
 * with what to do and where to fix it; one failing dependency never hides the
 * others.
 *
 * `runHandshakes()` goes further than "is a key saved": it calls every LLM the
 * platform is set to use with the chosen model (a few tokens, recorded in the
 * LLM wallet as source "handshake") and checks transcription models are
 * listed for the key, so a wrong model id or an unfunded account shows up
 * here instead of in a customer's failed job.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { pingRedis } from '../config/redis.js';
import { listCredentials, PROVIDER_LABEL, resolveEngine, verifyCredential, type ResolvedEngine } from '../services/ai.service.js';
import { keyStatus } from '../services/paystack.service.js';
import { getTokenSettings } from '../services/settings.service.js';
import { checkBucket } from '../services/storage.service.js';
import { studioEconomics } from '../studio/economics.js';
import { checkKey as checkFal } from '../studio/fal.js';
import { sql } from '../studio/sql.js';
import { secret } from '../vault/secrets.js';
import { recordLlmUsage } from './wallet.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface GuardCheck {
  id: string;
  group: 'Core' | 'Billing' | 'Mail' | 'Storage' | 'Payments' | 'AI engines' | 'LLM wallet';
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: { text: string; href?: string };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 240);

async function probe(check: Omit<GuardCheck, 'status' | 'detail'>, fn: () => Promise<{ status: CheckStatus; detail: string; fix?: GuardCheck['fix'] }>): Promise<GuardCheck> {
  try {
    const result = await fn();
    return { ...check, ...result, fix: result.status === 'ok' ? undefined : (result.fix ?? check.fix) };
  } catch (error) {
    return { ...check, status: 'fail', detail: message(error) };
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'studio', 'migrations');

export async function runChecks(): Promise<GuardCheck[]> {
  const isProd = env.NODE_ENV === 'production';
  return Promise.all([
    /* ---------------- core */
    probe({ id: 'database', group: 'Core', label: 'Database reachable', fix: { text: 'Check DATABASE_URL in be/.env (Neon pooler URL) and that the Neon project is not suspended.' } }, async () => {
      const started = performance.now();
      await sql`SELECT 1`;
      return { status: 'ok', detail: `Connected (${Math.round(performance.now() - started)} ms)` };
    }),
    probe({ id: 'redis', group: 'Core', label: 'Redis reachable (job queues)', fix: { text: 'Start Redis (docker compose up -d redis) and check REDIS_URL.' } }, async () =>
      (await pingRedis()) ? { status: 'ok', detail: 'PONG' } : { status: 'fail', detail: 'Redis did not answer' },
    ),
    probe({ id: 'migrations', group: 'Core', label: 'Database migrations applied', fix: { text: 'Run the migrate service: docker compose --profile app run --rm migrate (or pnpm prisma migrate deploy && pnpm studio:migrate).' } }, async () => {
      const files = (await readdir(MIGRATIONS_DIR).catch(() => [] as string[])).filter((file) => file.endsWith('.sql'));
      const done = new Set((await sql<{ name: string }[]>`SELECT name FROM studio_migrations`.catch(() => [])).map((row) => row.name));
      const missing = files.filter((file) => !done.has(file));
      const prismaFailed = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`.catch(() => [{ count: '0' }]);
      if (missing.length) return { status: 'fail', detail: `Not applied: ${missing.join(', ')}` };
      if (Number(prismaFailed[0]?.count ?? 0) > 0) return { status: 'fail', detail: `${prismaFailed[0]!.count} Prisma migration(s) failed or are unfinished` };
      return { status: 'ok', detail: `${files.length} SQL migrations and all Prisma migrations applied` };
    }),
    probe({ id: 'web-url', group: 'Core', label: 'Public web address', fix: { text: 'Set WEB_APP_URL (and CORS_ORIGINS) in be/.env to the https:// address users open; links in emails use it.' } }, async () => {
      const local = /localhost|127\.0\.0\.1/.test(env.WEB_APP_URL);
      if (local) return { status: isProd ? 'fail' : 'warn', detail: `WEB_APP_URL is ${env.WEB_APP_URL}` };
      if (!env.WEB_APP_URL.startsWith('https://')) return { status: 'warn', detail: `${env.WEB_APP_URL} is not https` };
      return { status: 'ok', detail: env.WEB_APP_URL };
    }),

    /* ---------------- money */
    probe({ id: 'studio-margins', group: 'Billing', label: 'No AI step sold below cost', fix: { text: 'Open Pricing & profit → AI studio economics and apply the suggested prices.', href: '/dashboard/admin/pricing' } }, async () => {
      const economics = await studioEconomics();
      if (economics.belowCost.length) {
        const worst = economics.lines.filter((line) => line.belowCost).map((line) => `${line.unit} (${line.floorMarginPercent ?? 0}%)`);
        return { status: 'fail', detail: `Sold below cost: ${worst.join(', ')}` };
      }
      const thin = economics.lines.filter((line) => (line.floorMarginPercent ?? 100) < 20);
      if (thin.length) return { status: 'warn', detail: `Margin under 20%: ${thin.map((line) => line.unit).join(', ')}` };
      return { status: 'ok', detail: `A 5 s lip-synced shot: ${economics.sampleShot.tokens} tokens, ${economics.sampleShot.marginPercent ?? 0}% margin at the cheapest pack` };
    }),

    /* ---------------- mail */
    probe({ id: 'smtp', group: 'Mail', label: 'Outgoing mail (password resets, alarms)', fix: { text: 'Add an SMTP account, verify it and make it active.', href: '/dashboard/admin/mail' } }, async () => {
      const active = await prisma.smtpCredential.findFirst({ where: { isActive: true } });
      if (!active) return { status: 'fail', detail: 'No active SMTP account' };
      if (active.lastVerifyOk === false) return { status: 'fail', detail: `“${active.label}” failed its last check: ${active.lastVerifyError ?? 'unknown error'}` };
      if (active.lastVerifyOk === null) return { status: 'warn', detail: `“${active.label}” is active but has never been verified` };
      return { status: 'ok', detail: `“${active.label}” is active and verified` };
    }),

    /* ---------------- storage */
    probe({ id: 'r2', group: 'Storage', label: 'Cloudflare R2 bucket', fix: { text: 'Check CF_R2_* in be/.env, then add the CORS rule in the Cloudflare dashboard (pnpm storage:check prints it).', href: '/dashboard/admin/storage' } }, async () => {
      await checkBucket();
      return { status: 'ok', detail: `Bucket ${env.CF_R2_BUCKET_NAME ?? ''} reachable` };
    }),

    /* ---------------- payments */
    probe({ id: 'paystack', group: 'Payments', label: 'Paystack checkout', fix: { text: 'Save the secret key for the current mode, then switch to LIVE before launch.', href: '/dashboard/admin/credentials' } }, async () => {
      const { paystackMode } = await getTokenSettings();
      const keys = keyStatus();
      if (!keys[paystackMode]) return { status: 'fail', detail: `Mode is ${paystackMode} but no ${paystackMode.toLowerCase()} secret key is set: customers cannot buy tokens` };
      if (paystackMode === 'TEST') return { status: 'warn', detail: 'Paystack is in TEST mode: payments are not real', fix: { text: 'Switch to LIVE on the Tokens page once the live key is saved.', href: '/dashboard/admin/tokens' } };
      return { status: 'ok', detail: 'LIVE mode with a live key' };
    }),

    /* ---------------- AI */
    probe({ id: 'fal', group: 'AI engines', label: 'fal.ai (images, video, lip sync)', fix: { text: 'Save FAL_KEY in Credentials.', href: '/dashboard/admin/credentials' } }, async () => {
      const result = await checkFal();
      return { status: result.ok ? 'ok' : 'fail', detail: result.detail };
    }),
    probe({ id: 'transcription', group: 'AI engines', label: 'Transcription engine', fix: { text: 'Assign an OpenAI-compatible key and a whisper model to transcription.', href: '/dashboard/admin/models' } }, async () => {
      const engine = await resolveEngine('transcription');
      if (!engine) return { status: 'fail', detail: 'No transcription engine: reels cannot be made' };
      return { status: 'ok', detail: engine.label };
    }),
    probe({ id: 'hooks', group: 'AI engines', label: 'Hook-picking LLM', fix: { text: 'Assign an LLM (Claude recommended) to hook picking.', href: '/dashboard/admin/models' } }, async () => {
      const engine = await resolveEngine('hooks');
      if (!engine) return { status: 'warn', detail: 'No LLM assigned: reels use the built-in heuristic (weaker picks)' };
      return { status: 'ok', detail: engine.label };
    }),
    probe({ id: 'anthropic', group: 'AI engines', label: 'Claude for the AI director, likeness and prompts', fix: { text: 'Save an Anthropic API key (see the guide below).', href: '/dashboard/admin/credentials' } }, async () => {
      const hooks = await resolveEngine('hooks').catch(() => null);
      const key = hooks?.provider === 'ANTHROPIC' ? hooks.apiKey : secret('ANTHROPIC_API_KEY');
      if (!key) return { status: 'fail', detail: 'No Anthropic key: studio planning, @me likeness and Create prompt direction are unavailable' };
      if (key.length < 40 || !key.startsWith('sk-ant-')) return { status: 'fail', detail: `The key in use (••••${key.slice(-4)}) does not look like an Anthropic key (sk-ant-…)` };
      return { status: 'ok', detail: `Key ••••${key.slice(-4)} present (run handshakes to prove it works)` };
    }),
    probe({ id: 'ai-keys', group: 'AI engines', label: 'Saved AI keys verified', fix: { text: 'Run handshakes, or re-verify keys on the AI models page.', href: '/dashboard/admin/models' } }, async () => {
      const keys = await listCredentials();
      if (!keys.length) return { status: 'fail', detail: 'No AI keys saved' };
      const bad = keys.filter((key) => key.lastVerifyOk === false);
      const never = keys.filter((key) => key.lastVerifyOk === null);
      if (bad.length) return { status: 'fail', detail: `Rejected: ${bad.map((key) => `${key.label} (${key.providerLabel})`).join(', ')}` };
      if (never.length) return { status: 'warn', detail: `Never verified: ${never.map((key) => `${key.label} (${key.providerLabel})`).join(', ')}` };
      return { status: 'ok', detail: `${keys.length} key(s) verified` };
    }),

    /* ---------------- wallet */
    probe({ id: 'wallet', group: 'LLM wallet', label: 'LLM token wallet funded', fix: { text: 'Record the tokens you bought from your provider.', href: '/dashboard/admin/launch/wallet' } }, async () => {
      const [row] = await sql<{ balanceTokens: string; fundedTokens: string; alarmPercent: number; alarmFiredAt: Date | null; configuredAt: Date | null }[]>`
        SELECT balance_tokens, funded_tokens, alarm_percent, alarm_fired_at, configured_at FROM llm_wallet WHERE id = 1`;
      if (!row) return { status: 'fail', detail: 'Wallet table missing: run migrations' };
      const balance = Number(row.balanceTokens);
      const funded = Number(row.fundedTokens);
      if (!row.configuredAt) return { status: 'warn', detail: 'Not set up yet: usage is counted but there is no balance or alarm' };
      if (balance <= 0) return { status: 'fail', detail: `Depleted (${balance.toLocaleString('en')} tokens): provider charges are now beyond what you recorded` };
      const used = funded > 0 ? Math.round(((funded - balance) / funded) * 100) : 0;
      if (row.alarmFiredAt) return { status: 'warn', detail: `${used}% used: the ${row.alarmPercent}% alarm has fired` };
      return { status: 'ok', detail: `${balance.toLocaleString('en')} tokens left (${used}% used, alarm at ${row.alarmPercent}%)` };
    }),
  ]);
}

/* ------------------------------------------------------------------ handshakes */

export interface Handshake {
  role: string;
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

let lastHandshakes: { at: string; results: Handshake[] } | null = null;
export const getLastHandshakes = (): typeof lastHandshakes => lastHandshakes;

async function timed(role: string, provider: string, model: string, fn: () => Promise<string>, secretValue?: string): Promise<Handshake> {
  const started = performance.now();
  try {
    const detail = await fn();
    return { role, provider, model, ok: true, latencyMs: Math.round(performance.now() - started), detail };
  } catch (error) {
    let detail = message(error);
    if (secretValue) detail = detail.replaceAll(secretValue, '***');
    return { role, provider, model, ok: false, latencyMs: Math.round(performance.now() - started), detail };
  }
}

/** A real 1-message call to the exact model: proves key, model access and credit. */
async function claudeHandshake(apiKey: string, model: string): Promise<string> {
  const client = new Anthropic({ apiKey, authToken: null, timeout: 30_000, maxRetries: 0 });
  const response = await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
  void recordLlmUsage({ source: 'handshake', provider: 'ANTHROPIC', model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });
  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('').trim();
  return `Replied “${text.slice(0, 20) || '…'}” (${response.usage.input_tokens + response.usage.output_tokens} tokens)`;
}

/** OpenAI-compatible: the model must be listed for this key. */
async function listedHandshake(engine: ResolvedEngine): Promise<string> {
  const response = await fetch(`${engine.baseUrl}/models`, { headers: { Authorization: `Bearer ${engine.apiKey}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const ids = ((await response.json()) as { data?: { id: string }[] }).data?.map((item) => item.id) ?? [];
  if (ids.length && !ids.includes(engine.model)) throw new Error(`Key works, but model “${engine.model}” is not available to it`);
  return `Key accepted, model available (${ids.length} models listed)`;
}

export async function runHandshakes(): Promise<{ at: string; results: Handshake[] }> {
  const results: Handshake[] = [];
  const [hooks, transcription] = await Promise.all([resolveEngine('hooks').catch(() => null), resolveEngine('transcription').catch(() => null)]);

  const jobs: Promise<Handshake>[] = [];
  if (hooks) {
    jobs.push(
      hooks.provider === 'ANTHROPIC'
        ? timed('Hook picking', PROVIDER_LABEL[hooks.provider], hooks.model, () => claudeHandshake(hooks.apiKey, hooks.model), hooks.apiKey)
        : timed('Hook picking', PROVIDER_LABEL[hooks.provider], hooks.model, () => listedHandshake(hooks), hooks.apiKey),
    );
  }
  if (transcription) jobs.push(timed('Transcription', PROVIDER_LABEL[transcription.provider], transcription.model, () => listedHandshake(transcription), transcription.apiKey));
  // The director uses the hooks engine when it is Claude, else ANTHROPIC_API_KEY with CLAUDE_MODEL.
  const directorKey = secret('ANTHROPIC_API_KEY');
  if (!(hooks?.provider === 'ANTHROPIC') && directorKey) {
    jobs.push(timed('AI director / likeness', PROVIDER_LABEL.ANTHROPIC, env.CLAUDE_MODEL, () => claudeHandshake(directorKey, env.CLAUDE_MODEL), directorKey));
  }
  jobs.push(
    timed('Video generation', 'fal.ai', 'queue', async () => {
      const result = await checkFal();
      if (!result.ok) throw new Error(result.detail);
      return result.detail;
    }),
  );
  results.push(...(await Promise.all(jobs)));

  // Refresh every saved key's verified state + model list.
  const keys = await listCredentials();
  const verified = await Promise.all(keys.map((key) => verifyCredential(key.id).catch(() => null)));
  for (const key of verified) {
    if (!key) continue;
    results.push({
      role: `Key: ${key.label}`,
      provider: key.providerLabel,
      model: key.models.length ? `${key.models.length} models` : '-',
      ok: Boolean(key.lastVerifyOk),
      latencyMs: 0,
      detail: key.lastVerifyOk ? `Accepted ${key.keyHint}` : (key.lastVerifyError ?? 'Rejected'),
    });
  }

  lastHandshakes = { at: new Date().toISOString(), results };
  return lastHandshakes;
}
