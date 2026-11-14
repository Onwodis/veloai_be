/**
 *   GET  /api/v1/public/branding        parent-company line for every page (no auth)
 *   GET  /api/v1/admin/branding         super admin: current setting
 *   PUT  /api/v1/admin/branding         super admin: switch it off / on, change the company
 */
import { Router, type Request, type Response } from 'express';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody } from '../middleware/validate.js';
import { brandingSchema, getBranding, saveBranding } from '../services/branding.service.js';

export const publicBrandingRouter: Router = Router();
publicBrandingRouter.get('/', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ branding: await getBranding() });
});

export const adminBrandingRouter: Router = Router();
adminBrandingRouter.use(authenticate, authorize('SUPER_ADMIN'));
adminBrandingRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ branding: await getBranding() });
});
adminBrandingRouter.put('/', validate({ body: brandingSchema }), async (req: Request, res: Response) => {
  res.json({ branding: await saveBranding(validBody(req, brandingSchema), requireAuth(req).userId) });
});
