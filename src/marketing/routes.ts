/**
 * /api/v1/admin/marketing  (super admin: assets that promote the platform)
 *
 *   GET  /                                       slots (+ what was made for each), library, VeloBot chat
 *   POST /slots/:slotId/produce                  { workspaceId, prompt? } make a landing-page asset
 *   POST /chat                                   { message } ask VeloBot; proposals come back
 *   POST /messages/:messageId/proposals/:index   { workspaceId } produce one proposal
 *   POST /assets/:assetId/compose                fliers: set the words over the finished background
 *   POST /assets/:assetId/steps/:step/upload-url { contentType } tutorial screenshot upload
 *   PUT  /assets/:assetId/steps/:step            { key } attach the uploaded screenshot
 *   POST /assets/:assetId/render                 tutorials: cut the video
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import * as marketing from './service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};

export const adminMarketingRouter: Router = Router();
adminMarketingRouter.use(authenticate, authorize('SUPER_ADMIN'));

adminMarketingRouter.get('/', send(async () => marketing.studio()));

const slotParams = z.strictObject({ slotId: z.string().regex(/^[a-z0-9-]{3,120}$/) });
const produceBody = z.strictObject({ workspaceId: z.uuid(), prompt: z.string().trim().max(3000).optional() });
adminMarketingRouter.post('/slots/:slotId/produce', validate({ params: slotParams, body: produceBody }), send(async (req, res) => {
  const body = validBody(req, produceBody);
  return marketing.produceSlot(requireAuth(req), body.workspaceId, validParams(res, slotParams).slotId, body.prompt);
}));

const chatBody = z.strictObject({ message: z.string().trim().min(3).max(4000) });
adminMarketingRouter.post('/chat', validate({ body: chatBody }), send(async (req) => marketing.chat(requireAuth(req), validBody(req, chatBody).message)));

const proposalParams = z.strictObject({ messageId: z.uuid(), index: z.coerce.number().int().min(0).max(10) });
const workspaceBody = z.strictObject({ workspaceId: z.uuid() });
adminMarketingRouter.post('/messages/:messageId/proposals/:index', validate({ params: proposalParams, body: workspaceBody }), send(async (req, res) => {
  const { messageId, index } = validParams(res, proposalParams);
  return marketing.produceProposal(requireAuth(req), validBody(req, workspaceBody).workspaceId, messageId, index);
}));

const assetParams = z.strictObject({ assetId: z.uuid() });
adminMarketingRouter.post('/assets/:assetId/compose', validate({ params: assetParams }), send(async (_req, res) => marketing.composeFlier(validParams(res, assetParams).assetId)));
const stepParams = assetParams.extend({ step: z.coerce.number().int().min(0).max(11) });
const uploadBody = z.strictObject({ contentType: z.string().max(40) });
adminMarketingRouter.post('/assets/:assetId/steps/:step/upload-url', validate({ params: stepParams, body: uploadBody }), send(async (req, res) => {
  const { assetId, step } = validParams(res, stepParams);
  return marketing.stepUploadUrl(assetId, step, validBody(req, uploadBody).contentType);
}));
const stepBody = z.strictObject({ key: z.string().min(10).max(300) });
adminMarketingRouter.put('/assets/:assetId/steps/:step', validate({ params: stepParams, body: stepBody }), send(async (req, res) => {
  const { assetId, step } = validParams(res, stepParams);
  return marketing.setStepImage(assetId, step, validBody(req, stepBody).key);
}));
adminMarketingRouter.post('/assets/:assetId/render', validate({ params: assetParams }), send(async (_req, res) => marketing.renderTutorial(validParams(res, assetParams).assetId)));
