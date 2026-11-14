/**
 * /api/v1/likeness  (the signed-in user's own likeness; RLS-scoped)
 *
 *   GET    /                         profile, files, rates
 *   POST   /assets                   { fileName, contentType, size } → presigned PUT (max 10 files, storage-checked)
 *   POST   /assets/:assetId/complete { width?, height?, durationSec? }
 *   DELETE /assets/:assetId
 *   POST   /build                    { workspaceId, consent: true, heightCm?, selfDescription?, train } (token + storage gated)
 *   PATCH  /                         { heightCm?, profile? } the user's corrections
 *   DELETE /                         delete the likeness and every file behind it
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import * as likeness from './service.js';

const assetSchema = z.strictObject({ fileName: z.string().trim().min(1).max(255), contentType: z.string().trim().max(100), size: z.number().int().min(1) });
const completeSchema = z.strictObject({ width: z.number().int().min(1).optional(), height: z.number().int().min(1).optional(), durationSec: z.number().min(0).optional() });
const assetParams = z.strictObject({ assetId: z.uuid() });
const buildSchema = z.strictObject({
  workspaceId: z.uuid(),
  consent: z.literal(true, { error: 'Confirm that these are photos of you and that you agree to them being used to portray you.' }),
  heightCm: z.number().int().min(80).max(260).optional(),
  selfDescription: z.string().trim().max(1200).optional(),
  train: z.boolean().default(true),
});
const trait = z.string().trim().max(1500);
const patchSchema = z.strictObject({
  heightCm: z.number().int().min(80).max(260).nullable().optional(),
  profile: z
    .strictObject({
      summary: trait.optional(),
      face: trait.optional(),
      skeleton: trait.optional(),
      body: trait.optional(),
      proportions: trait.optional(),
      heightImpression: trait.optional(),
      posture: trait.optional(),
      gait: trait.optional(),
      hair: trait.optional(),
      wardrobe: trait.optional(),
      voice: trait.optional(),
    })
    .optional(),
});

export const likenessRouter: Router = Router();
likenessRouter.use(authenticate);

likenessRouter.get('/', async (req: Request, res: Response) => {
  res.json({ likeness: await likeness.getLikeness(requireAuth(req)) });
});
likenessRouter.post('/assets', validate({ body: assetSchema }), async (req: Request, res: Response) => {
  res.status(201).json(await likeness.createAsset(requireAuth(req), validBody(req, assetSchema)));
});
likenessRouter.post('/assets/:assetId/complete', validate({ params: assetParams, body: completeSchema }), async (req: Request, res: Response) => {
  res.json({ likeness: await likeness.completeAsset(requireAuth(req), validParams(res, assetParams).assetId, validBody(req, completeSchema)) });
});
likenessRouter.delete('/assets/:assetId', validate({ params: assetParams }), async (req: Request, res: Response) => {
  res.json({ likeness: await likeness.deleteAsset(requireAuth(req), validParams(res, assetParams).assetId) });
});
likenessRouter.post('/build', validate({ body: buildSchema }), async (req: Request, res: Response) => {
  res.json({ likeness: await likeness.buildLikeness(requireAuth(req), validBody(req, buildSchema), req.ip ?? null) });
});
likenessRouter.patch('/', validate({ body: patchSchema }), async (req: Request, res: Response) => {
  res.json({ likeness: await likeness.updateProfile(requireAuth(req), validBody(req, patchSchema)) });
});
likenessRouter.delete('/', async (req: Request, res: Response) => {
  res.json({ likeness: await likeness.deleteLikeness(requireAuth(req)) });
});
