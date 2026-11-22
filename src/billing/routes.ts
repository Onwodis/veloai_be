/**
 *   GET  /api/v1/me/trial                                   my trial: settings, eligibility, the grant and what is left
 *   POST /api/v1/me/trial/claim                             { workspaceId } claim it (once, into a workspace I own)
 *
 *   GET  /api/v1/workspaces/:ws/watermark/:projectId        removal price for the project (and whether it is watermarked)
 *   POST /api/v1/workspaces/:ws/watermark/:projectId        { fee } pay and remove (fee = the price shown)
 *
 *   GET  /api/v1/admin/offers                               trial + watermark settings              SUPER_ADMIN
 *   PUT  /api/v1/admin/offers/trial                         { enabled, tokens, days }
 *   PUT  /api/v1/admin/offers/watermark                     { enabled, removalPercent, minimumTokens }
 *   PUT  /api/v1/admin/offers/portraits                     { enabled, count, priceTokens }
 *   GET  /api/v1/admin/offers/users/:userId/portraits       a user's portraits + paid downloads
 *
 *   GET  /api/v1/me/portraits                               my professional portraits (watermarked previews)
 *   POST /api/v1/me/portraits/:itemId/download              { workspaceId, tokens } buy once, then a download link
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import { growthBaseline } from './growth.js';
import * as portraits from './portraits.js';
import { pricingAudit } from './pricingAudit.js';
import * as trial from './trial.js';
import * as watermark from './watermarkRemoval.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};

/* Professional portraits: GET /me/portraits, POST /me/portraits/:itemId/download { workspaceId, tokens } */
export const myPortraitsRouter: Router = Router();
myPortraitsRouter.use(authenticate);
myPortraitsRouter.get('/', send(async (req) => portraits.myPortraits(requireAuth(req).userId)));
const portraitParams = z.strictObject({ itemId: z.string().regex(/^[a-f0-9]{12}-[a-z-]{2,30}$/) });
const portraitBody = z.strictObject({ workspaceId: z.uuid(), tokens: z.number().int().min(0) });
myPortraitsRouter.post('/:itemId/download', validate({ params: portraitParams, body: portraitBody }), send(async (req, res) => {
  const body = validBody(req, portraitBody);
  return portraits.downloadPortrait(requireAuth(req), body.workspaceId, validParams(res, portraitParams).itemId, body.tokens);
}));

export const myTrialRouter: Router = Router();
myTrialRouter.use(authenticate);
myTrialRouter.get('/', send(async (req) => trial.trialStatus(requireAuth(req).userId)));
const claimBody = z.strictObject({ workspaceId: z.uuid() });
myTrialRouter.post('/claim', validate({ body: claimBody }), send(async (req) => trial.claimTrial(requireAuth(req), validBody(req, claimBody).workspaceId)));

export const watermarkRouter: Router = Router({ mergeParams: true });
watermarkRouter.use(authenticate);
const projectParams = z.strictObject({ workspaceId: z.uuid(), projectId: z.uuid() });
watermarkRouter.get('/:projectId', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  return watermark.watermarkQuote(requireAuth(req), workspaceId, projectId);
}));
const removeBody = z.strictObject({ fee: z.number().int().min(0) });
watermarkRouter.post('/:projectId', validate({ params: projectParams, body: removeBody }), send(async (req, res) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  return watermark.removeWatermark(requireAuth(req), workspaceId, projectId, validBody(req, removeBody).fee);
}));

export const adminOffersRouter: Router = Router();
adminOffersRouter.use(authenticate, authorize('SUPER_ADMIN'));
/* Pricing & token-gate audit (margin zones, recommended prices) and the growth advisor's baseline. */
adminOffersRouter.get('/pricing-audit', send(async () => pricingAudit()));
adminOffersRouter.get('/growth', send(async () => growthBaseline()));
adminOffersRouter.get('/', send(async () => ({ trial: await trial.getTrialSettings(), watermark: await watermark.getWatermarkSettings(), portraits: await portraits.getPortraitSettings() })));
adminOffersRouter.put('/portraits', validate({ body: portraits.portraitSettingsSchema }), send(async (req) => ({
  portraits: await portraits.savePortraitSettings(validBody(req, portraits.portraitSettingsSchema), requireAuth(req).userId),
})));
const userParams = z.strictObject({ userId: z.uuid() });
adminOffersRouter.get('/users/:userId/portraits', validate({ params: userParams }), send(async (_req, res) => portraits.adminUserPortraits(validParams(res, userParams).userId)));
adminOffersRouter.put('/trial', validate({ body: trial.trialSettingsSchema }), send(async (req) => ({
  trial: await trial.saveTrialSettings(validBody(req, trial.trialSettingsSchema), requireAuth(req).userId),
})));
adminOffersRouter.put('/watermark', validate({ body: watermark.watermarkSettingsSchema }), send(async (req) => ({
  watermark: await watermark.saveWatermarkSettings(validBody(req, watermark.watermarkSettingsSchema), requireAuth(req).userId),
})));
