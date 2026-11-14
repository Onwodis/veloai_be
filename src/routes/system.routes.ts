/**
 * /api/v1/admin/system — super admin console.
 *
 *   GET   /                          live health: process, database, Redis, queue, jobs, logs, requests, integrations
 *   POST  /jobs/:name/run            run a scheduled job now
 *   GET   /insights?range=30         most active customers, assets generated
 *   GET   /pricing?range=30          pricing model, unit economics, revenue / cost / profit
 *   PATCH /pricing                   update cost prices, running costs, margin target and
 *                                    (optionally) token prices: taskCosts / packages
 *   POST  /paystack/:mode/verify     authenticate a Paystack key (read-only /balance call)
 *   PUT   /paystack/mode             switch Paystack between TEST and LIVE
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pricingSchema } from '../config/pricing.js';
import { TASK_STEPS, tokenSettingsSchema } from '../config/tokenSettings.js';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import { hasJob, runJobNow } from '../services/jobs.service.js';
import * as paystack from '../services/paystack.service.js';
import { pricingOverview } from '../services/pricing.service.js';
import { getTokenSettings, updatePricing, updateTokenSettings } from '../services/settings.service.js';
import { insights, systemSnapshot } from '../services/system.service.js';
import { AppError } from '../utils/AppError.js';

const rangeQuery = z.strictObject({
  range: z.coerce.number().int().refine((value) => [7, 30, 90, 365].includes(value), { error: 'range must be 7, 30, 90 or 365' }).default(30),
});
const jobParams = z.strictObject({ name: z.string().regex(/^[a-z0-9-]{2,64}$/) });
const modeParams = z.strictObject({ mode: z.enum(['test', 'live']).transform((value) => value.toUpperCase() as 'TEST' | 'LIVE') });
const modeBody = z.strictObject({ mode: z.enum(['TEST', 'LIVE']) });

const pricingPatch = pricingSchema.partial().extend({
  taskCosts: z.strictObject(Object.fromEntries(TASK_STEPS.map((step) => [step, z.number().int().min(0).max(100_000)])) as Record<(typeof TASK_STEPS)[number], z.ZodNumber>).optional(),
  packages: tokenSettingsSchema.shape.packages.optional(),
});

export const systemRouter: Router = Router();
systemRouter.use(authenticate, authorize('SUPER_ADMIN'));

systemRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await systemSnapshot());
});

systemRouter.post('/jobs/:name/run', validate({ params: jobParams }), async (_req: Request, res: Response) => {
  const { name } = validParams(res, jobParams);
  if (!hasJob(name)) throw AppError.notFound('Job');
  res.json({ job: await runJobNow(name) });
});

systemRouter.get('/insights', validate({ query: rangeQuery }), async (_req: Request, res: Response) => {
  res.json(await insights(validQuery(res, rangeQuery).range));
});

systemRouter.get('/pricing', validate({ query: rangeQuery }), async (_req: Request, res: Response) => {
  res.json(await pricingOverview(validQuery(res, rangeQuery).range));
});

systemRouter.patch('/pricing', validate({ body: pricingPatch, query: rangeQuery }), async (req: Request, res: Response) => {
  const { taskCosts, packages, ...pricing } = validBody(req, pricingPatch);
  const actor = requireAuth(req).userId;
  if (taskCosts || packages) await updateTokenSettings({ ...(taskCosts ? { taskCosts } : {}), ...(packages ? { packages } : {}) }, actor);
  if (Object.keys(pricing).length > 0) await updatePricing(pricing, actor);
  res.json(await pricingOverview(30));
});

systemRouter.post('/paystack/:mode/verify', validate({ params: modeParams }), async (_req: Request, res: Response) => {
  res.json({ check: await paystack.verifyKey(validParams(res, modeParams).mode) });
});

systemRouter.put('/paystack/mode', validate({ body: modeBody }), async (req: Request, res: Response) => {
  const { mode } = validBody(req, modeBody);
  if (mode === 'LIVE' && !paystack.keyStatus().LIVE) {
    throw AppError.badRequest('Set PAYSTACK_LIVE_SECRET_KEY in the API .env before switching to live mode');
  }
  const current = await getTokenSettings();
  const settings = current.paystackMode === mode ? current : await updateTokenSettings({ paystackMode: mode }, requireAuth(req).userId);
  res.json({ mode: settings.paystackMode, keys: paystack.keyStatus() });
});
