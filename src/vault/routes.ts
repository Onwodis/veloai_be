/**
 * /api/v1/admin/credentials  (super admin)
 *   GET    /               every known credential: source (vault / .env / missing), last 4 only
 *   PUT    /:name          { value } → encrypted, then stored (RLS: super admin only)
 *   DELETE /:name          remove the vault value (falls back to .env, if set)
 *   POST   /:name/test     check the key in use against the provider
 */
import Anthropic from '@anthropic-ai/sdk';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import { syncEnvAiCredentials } from '../services/ai.service.js';
import { verifyKey } from '../services/paystack.service.js';
import { checkKey } from '../studio/fal.js';
import { env } from '../config/env.js';
import { deleteSecret, listSecrets, saveSecret, secret, SECRET_NAMES, type SecretName } from './secrets.js';

const nameParams = z.strictObject({ name: z.enum(SECRET_NAMES as [SecretName, ...SecretName[]]) });
const valueSchema = z.strictObject({ value: z.string().min(1).max(4000) });

/** AI keys are mirrored into the AI models list, so the Models page sees them too. */
const AI_KEYS = new Set<SecretName>(['ANTHROPIC_API_KEY', 'TRANSCRIPTION_API_KEY', 'OPENAI_API_KEY']);

async function test(name: SecretName): Promise<{ ok: boolean; detail: string }> {
  const value = secret(name);
  if (!value) return { ok: false, detail: 'Not configured' };
  try {
    if (name === 'FAL_KEY') return await checkKey();
    if (name === 'ANTHROPIC_API_KEY') {
      const client = new Anthropic({ apiKey: value, authToken: null, timeout: 20_000, maxRetries: 0 });
      const page = await client.models.list({ limit: 5 });
      return { ok: true, detail: `Key accepted · ${page.data.map((model) => model.id).slice(0, 3).join(', ')}` };
    }
    if (name === 'PAYSTACK_TEST_SECRET_KEY' || name === 'PAYSTACK_LIVE_SECRET_KEY') {
      const result = await verifyKey(name === 'PAYSTACK_LIVE_SECRET_KEY' ? 'LIVE' : 'TEST');
      return { ok: result.ok, detail: result.ok ? `Key accepted (${result.latencyMs} ms)` : (result.error ?? 'Rejected') };
    }
    const base = name === 'OPENAI_API_KEY' ? 'https://api.openai.com/v1' : env.TRANSCRIPTION_API_URL.replace(/\/+$/, '');
    const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(15_000) });
    return response.ok ? { ok: true, detail: 'Key accepted' } : { ok: false, detail: `Rejected (HTTP ${response.status})` };
  } catch (error) {
    return { ok: false, detail: (error instanceof Error ? error.message : String(error)).replace(value, '***').slice(0, 200) };
  }
}

export const credentialsRouter: Router = Router();
credentialsRouter.use(authenticate, authorize('SUPER_ADMIN'));

credentialsRouter.get('/', async (req: Request, res: Response) => {
  res.json({ credentials: await listSecrets(requireAuth(req)) });
});
credentialsRouter.put('/:name', validate({ params: nameParams, body: valueSchema }), async (req: Request, res: Response) => {
  const { name } = validParams(res, nameParams);
  await saveSecret(requireAuth(req), name, validBody(req, valueSchema).value);
  if (AI_KEYS.has(name)) await syncEnvAiCredentials();
  res.json({ credentials: await listSecrets(requireAuth(req)), test: await test(name) });
});
credentialsRouter.delete('/:name', validate({ params: nameParams }), async (req: Request, res: Response) => {
  const { name } = validParams(res, nameParams);
  await deleteSecret(requireAuth(req), name);
  if (AI_KEYS.has(name)) await syncEnvAiCredentials();
  res.json({ credentials: await listSecrets(requireAuth(req)) });
});
credentialsRouter.post('/:name/test', validate({ params: nameParams }), async (_req: Request, res: Response) => {
  res.json(await test(validParams(res, nameParams).name));
});
