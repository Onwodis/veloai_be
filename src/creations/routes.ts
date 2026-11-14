/**
 * /api/v1/workspaces/:workspaceId/creations
 *   POST /                 { mode, prompt, aspect, durationSec?, sourceKey?, upscale, direct, dryRun }
 *                          dryRun → token + storage preflight; else storage → tokens → queue
 *
 * /api/v1/creations  (the signed-in user's own; RLS-scoped)
 *   GET    /               list
 *   POST   /uploads        { fileName, contentType, size } → presigned PUT for a picture to enhance
 *   POST   /uploads/complete { key }
 *   GET    /:id
 *   POST   /:id/cancel
 *   DELETE /:id
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import * as creations from './service.js';

const createSchema = z.strictObject({
  mode: z.enum(['IMAGE', 'VIDEO', 'ENHANCE']),
  prompt: z.string().trim().min(3, { error: 'Describe what you want.' }).max(2000),
  aspect: z.enum(['16:9', '9:16', '1:1']).default('9:16'),
  durationSec: z.number().min(2).max(15).optional(),
  sourceKey: z.string().max(600).optional(),
  upscale: z.boolean().default(true),
  direct: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const idParams = z.strictObject({ id: z.uuid() });
const listQuery = z.strictObject({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(48).default(24) });
const uploadSchema = z.strictObject({ fileName: z.string().trim().min(1).max(255), contentType: z.string().trim().max(100), size: z.number().int().min(1) });
const completeSchema = z.strictObject({ key: z.string().min(1).max(600) });

export const workspaceCreationRouter: Router = Router({ mergeParams: true });
workspaceCreationRouter.use(authenticate);
workspaceCreationRouter.post('/', validate({ params: workspaceParams, body: createSchema }), async (req: Request, res: Response) => {
  const result = await creations.createCreation(requireAuth(req), validParams(res, workspaceParams).workspaceId, validBody(req, createSchema));
  res.status(result.creation ? 201 : 200).json(result);
});

export const creationRouter: Router = Router();
creationRouter.use(authenticate);
creationRouter.get('/', validate({ query: listQuery }), async (req: Request, res: Response) => {
  const { page, pageSize } = validQuery(res, listQuery);
  res.json(await creations.listCreations(requireAuth(req), page, pageSize));
});
creationRouter.post('/uploads', validate({ body: uploadSchema }), async (req: Request, res: Response) => {
  res.status(201).json(await creations.createUpload(requireAuth(req), validBody(req, uploadSchema)));
});
creationRouter.post('/uploads/complete', validate({ body: completeSchema }), async (req: Request, res: Response) => {
  res.json(await creations.completeUpload(requireAuth(req), validBody(req, completeSchema).key));
});
creationRouter.get('/:id', validate({ params: idParams }), async (req: Request, res: Response) => {
  res.json({ creation: await creations.getCreation(requireAuth(req), validParams(res, idParams).id) });
});
creationRouter.post('/:id/cancel', validate({ params: idParams }), async (req: Request, res: Response) => {
  res.json({ creation: await creations.cancelCreation(requireAuth(req), validParams(res, idParams).id) });
});
creationRouter.delete('/:id', validate({ params: idParams }), async (req: Request, res: Response) => {
  await creations.deleteCreation(requireAuth(req), validParams(res, idParams).id);
  res.status(204).end();
});
