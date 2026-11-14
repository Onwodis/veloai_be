/**
 * Billing.
 *
 *   GET  /api/v1/billing/plans                                public plan catalogue
 *   GET  /api/v1/workspaces/:workspaceId/billing              subscription, usage, invoices (members)
 *   POST /api/v1/workspaces/:workspaceId/billing/plan         change plan (owner / platform admin)
 *   POST /api/v1/workspaces/:workspaceId/billing/resume       undo a scheduled downgrade (owner)
 */
import { Router } from 'express';
import * as billing from '../controllers/billing.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { changePlanSchema, workspaceParamsSchema } from '../models/billing.schemas.js';

export const billingRouter: Router = Router();
billingRouter.get('/plans', billing.plans);

export const workspaceBillingRouter: Router = Router({ mergeParams: true });
workspaceBillingRouter.use(authenticate);
workspaceBillingRouter.get('/', validate({ params: workspaceParamsSchema }), billing.overview);
workspaceBillingRouter.post(
  '/plan',
  validate({ params: workspaceParamsSchema, body: changePlanSchema }),
  billing.changePlan,
);
workspaceBillingRouter.post('/resume', validate({ params: workspaceParamsSchema }), billing.resume);
