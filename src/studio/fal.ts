/**
 * fal.ai queue API over plain fetch (no SDK).
 *
 *   submit  POST https://queue.fal.run/<endpoint>   → request id + status/response URLs
 *   wait    poll the status URL until COMPLETED, then GET the response URL
 *
 * The handle is persisted on the take before waiting, so a worker restart
 * resumes polling the same request instead of paying fal for it twice.
 */
import { secret } from '../vault/secrets.js';
import { clampText } from './cinema.js';

const QUEUE_URL = 'https://queue.fal.run';
const POLL_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 25 * 60_000;

export interface FalHandle {
  endpoint: string;
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

export class FalError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FalError';
  }
}

export function falConfigured(): boolean {
  return Boolean(secret('FAL_KEY'));
}

function headers(): Record<string, string> {
  if (!secret('FAL_KEY')) throw new FalError('No fal.ai key is configured (add it in Console → Credentials), so AI generation is unavailable.');
  return { Authorization: `Key ${secret('FAL_KEY')}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

/** fal's validation errors come back as { detail: [{ loc, msg }] } or { detail: "..." }. */
async function errorText(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown; error?: unknown; message?: unknown };
    const detail = body.detail ?? body.error ?? body.message;
    if (Array.isArray(detail)) return detail.map((item: { loc?: unknown[]; msg?: string }) => `${(item.loc ?? []).slice(1).join('.')}: ${item.msg ?? ''}`).join('; ');
    if (typeof detail === 'string') return detail;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || `HTTP ${response.status}`;
}

/** Most fal video models reject prompts over 2500 chars (Kling, among others). */
const PROMPT_LIMIT = 2500;

/** Last line of defence: no prompt field ever goes out over the model's limit. */
function clampPrompts(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  for (const field of ['prompt', 'negative_prompt']) {
    const value = out[field];
    if (typeof value === 'string' && value.length > PROMPT_LIMIT) out[field] = clampText(value, PROMPT_LIMIT - 20);
  }
  return out;
}

export async function submit(endpoint: string, input: Record<string, unknown>): Promise<FalHandle> {
  const response = await fetch(`${QUEUE_URL}/${endpoint}`, { method: 'POST', headers: headers(), body: JSON.stringify(clampPrompts(input)), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new FalError(`${endpoint} rejected the request: ${await errorText(response)}`, response.status);
  const body = (await response.json()) as { request_id: string; status_url?: string; response_url?: string };
  // Older responses omit the URLs; they live under the app id (first two path segments).
  const app = endpoint.split('/').slice(0, 2).join('/');
  return {
    endpoint,
    requestId: body.request_id,
    statusUrl: body.status_url ?? `${QUEUE_URL}/${app}/requests/${body.request_id}/status`,
    responseUrl: body.response_url ?? `${QUEUE_URL}/${app}/requests/${body.request_id}`,
  };
}

export async function cancel(handle: FalHandle): Promise<void> {
  await fetch(`${handle.responseUrl}/cancel`, { method: 'PUT', headers: headers(), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
}

interface WaitOptions {
  timeoutMs?: number;
  /** Called on every poll; throw from it to stop (e.g. the take was canceled). */
  onTick?: (status: string) => Promise<void>;
}

export async function wait<T = Record<string, unknown>>(handle: FalHandle, options: WaitOptions = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    const response = await fetch(`${handle.statusUrl}?logs=0`, { headers: headers(), signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
      // A network blip while polling isn't a failed generation.
      return { ok: false, status: 0, error } as const;
    });
    let status = 'UNKNOWN';
    if ('json' in response && response.ok) {
      const body = (await response.json()) as { status?: string; error?: string };
      status = body.status ?? 'UNKNOWN';
      if (body.error) throw new FalError(`${handle.endpoint}: ${body.error}`);
    } else if ('json' in response && response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new FalError(`${handle.endpoint} status check failed: ${await errorText(response)}`, response.status);
    }
    await options.onTick?.(status);
    if (status === 'COMPLETED') break;
    if (Date.now() > deadline) {
      await cancel(handle);
      throw new FalError(`${handle.endpoint} did not finish within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} minutes`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const result = await fetch(handle.responseUrl, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  if (!result.ok) throw new FalError(`${handle.endpoint} failed: ${await errorText(result)}`, result.status);
  return (await result.json()) as T;
}

/** The media URL in a fal result, whatever shape the model returns. */
export function outputUrl(result: unknown, kind: 'video' | 'image'): string {
  const body = result as { video?: { url?: string }; videos?: { url?: string }[]; image?: { url?: string }; images?: { url?: string }[]; output?: unknown };
  const url = kind === 'video' ? (body.video?.url ?? body.videos?.[0]?.url) : (body.images?.[0]?.url ?? body.image?.url);
  if (url) return url;
  if (body.output && body.output !== result) return outputUrl(body.output, kind);
  throw new FalError(`The model returned no ${kind} (keys: ${Object.keys(body ?? {}).join(', ') || 'none'})`);
}

/** Cheap authenticated call used by the console's "check key" button. */
export async function checkKey(): Promise<{ ok: boolean; detail: string }> {
  if (!secret('FAL_KEY')) return { ok: false, detail: 'FAL_KEY is not set' };
  // A status lookup for a request id that doesn't exist: 401/403 means a bad key, 404 a good one.
  const response = await fetch(`${QUEUE_URL}/fal-ai/fast-sdxl/requests/00000000-0000-0000-0000-000000000000/status`, { headers: headers(), signal: AbortSignal.timeout(15_000) }).catch(
    (error: unknown) => ({ status: -1, error }) as const,
  );
  if (response.status === 401 || response.status === 403) return { ok: false, detail: 'fal.ai rejected the key' };
  if (response.status === -1) return { ok: false, detail: 'fal.ai is unreachable from the API server' };
  return { ok: true, detail: 'Key accepted by fal.ai' };
}
