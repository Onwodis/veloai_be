/**
 * /api/v1/admin/ai — super admin: AI engine keys and per-step model choice.
 *
 *   GET    /                            credentials (masked), current choices, suggestions
 *   POST   /credentials                 add a key (encrypted, then verified live)
 *   POST   /credentials/:id/verify      re-check a key, refresh its model list
 *   DELETE /credentials/:id             remove a dashboard key (not in use, not from .env)
 *   PATCH  /settings                    choose the key + model for each step
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/authenticate.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import * as ai from '../services/ai.service.js';

const credentialSchema = z.strictObject({
  provider: z.enum(['ANTHROPIC', 'OPENAI', 'GROQ', 'OPENAI_COMPATIBLE']),
  label: z.string().trim().min(2).max(80),
  apiKey: z.string().trim().min(10, { error: 'That key looks too short' }).max(400),
  baseUrl: z.url({ protocol: /^https?$/ }).max(255).optional(),
});
const idParams = z.strictObject({ id: z.uuid() });
const assignment = z.strictObject({ credentialId: z.uuid().nullable(), model: z.string().trim().max(120) });
const settingsSchema = z.strictObject({ transcription: assignment.optional(), hooks: assignment.optional() });

async function overview(): Promise<unknown> {
  const [credentials, settings] = await Promise.all([ai.listCredentials(), ai.getAiSettings()]);
  return { credentials, settings, suggestions: ai.SUGGESTED_MODELS, providers: ai.PROVIDER_LABEL };
}

export const aiRouter: Router = Router();
aiRouter.use(authenticate, authorize('SUPER_ADMIN'));

aiRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await overview());
});

aiRouter.post('/credentials', validate({ body: credentialSchema }), async (req: Request, res: Response) => {
  const credential = await ai.createCredential(validBody(req, credentialSchema), requireAuth(req).userId);
  res.status(201).json({ credential });
});

aiRouter.post('/credentials/:id/verify', validate({ params: idParams }), async (_req: Request, res: Response) => {
  res.json({ credential: await ai.verifyCredential(validParams(res, idParams).id) });
});

aiRouter.delete('/credentials/:id', validate({ params: idParams }), async (_req: Request, res: Response) => {
  await ai.deleteCredential(validParams(res, idParams).id);
  res.status(204).end();
});

aiRouter.patch('/settings', validate({ body: settingsSchema }), async (req: Request, res: Response) => {
  const patch = validBody(req, settingsSchema);
  await ai.updateAiSettings(
    { ...(patch.transcription ? { transcription: patch.transcription } : {}), ...(patch.hooks ? { hooks: patch.hooks } : {}) },
    requireAuth(req).userId,
  );
  res.json(await overview());
});
