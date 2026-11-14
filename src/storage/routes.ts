/**
 * /api/v1/storage  (the signed-in user's own storage; RLS-scoped)
 *   GET  /                  quota, usage, level, monthly charge, packs on offer
 *   GET  /files             usage by category + largest files (with download links)
 *   GET  /purchases         storage purchase history
 *   POST /checkout          { packId } → Paystack checkout URL
 *   POST /verify            { reference } → activate after Paystack redirect
 *
 * /api/v1/admin/storage  (super admin)
 *   GET   /                 settings, totals, per-user usage (?search=)
 *   PUT   /settings         default quota, warn %, period, packs
 *   PATCH /users/:userId    { quotaMb: number | null } per-user override
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import * as storage from './service.js';

const filesQuery = z.strictObject({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) });
const checkoutSchema = z.strictObject({ packId: z.string().trim().min(1).max(40) });
const verifySchema = z.strictObject({ reference: z.string().trim().min(6).max(80) });
const adminQuery = z.strictObject({ search: z.string().trim().max(120).optional() });
const userParams = z.strictObject({ userId: z.uuid() });
const quotaSchema = z.strictObject({ quotaMb: z.number().int().min(0).max(10_000_000).nullable() });

export const storageRouter: Router = Router();
storageRouter.use(authenticate);
storageRouter.get('/', async (req: Request, res: Response) => {
  const [status, settings] = await Promise.all([storage.storageStatus(requireAuth(req)), storage.getStorageSettings()]);
  res.json({ status, packs: settings.packs, periodDays: settings.periodDays });
});
storageRouter.get('/files', validate({ query: filesQuery }), async (req: Request, res: Response) => {
  const { page, pageSize } = validQuery(res, filesQuery);
  res.json(await storage.storageFiles(requireAuth(req), page, pageSize));
});
storageRouter.get('/purchases', async (req: Request, res: Response) => {
  res.json({ purchases: await storage.purchaseHistory(requireAuth(req)) });
});
storageRouter.post('/checkout', validate({ body: checkoutSchema }), async (req: Request, res: Response) => {
  res.json(await storage.startStorageCheckout(requireAuth(req), validBody(req, checkoutSchema).packId));
});
storageRouter.post('/verify', validate({ body: verifySchema }), async (req: Request, res: Response) => {
  res.json(await storage.verifyStorageForUser(requireAuth(req), validBody(req, verifySchema).reference));
});

export const adminStorageRouter: Router = Router();
adminStorageRouter.use(authenticate, authorize('SUPER_ADMIN'));
adminStorageRouter.get('/', validate({ query: adminQuery }), async (req: Request, res: Response) => {
  res.json(await storage.adminOverview(requireAuth(req), validQuery(res, adminQuery).search));
});
adminStorageRouter.put('/settings', validate({ body: storage.storageSettingsSchema }), async (req: Request, res: Response) => {
  res.json({ settings: await storage.saveStorageSettings(validBody(req, storage.storageSettingsSchema), requireAuth(req).userId) });
});
adminStorageRouter.patch('/users/:userId', validate({ params: userParams, body: quotaSchema }), async (req: Request, res: Response) => {
  await storage.setUserQuota(requireAuth(req), validParams(res, userParams).userId, validBody(req, quotaSchema).quotaMb);
  res.status(204).end();
});
