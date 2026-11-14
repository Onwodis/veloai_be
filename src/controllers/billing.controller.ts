/**
 * Billing handlers. Access rules live in billing.service.
 */
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate.js';
import { validBody, validParams } from '../middleware/validate.js';
import { changePlanSchema, workspaceParamsSchema } from '../models/billing.schemas.js';
import * as billing from '../services/billing.service.js';

export function plans(_req: Request, res: Response): void {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(billing.listPlans());
}

export async function overview(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, workspaceParamsSchema);
  res.json(await billing.getBillingOverview(requireAuth(req), workspaceId));
}

export async function changePlan(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, workspaceParamsSchema);
  res.json(await billing.changePlan(requireAuth(req), workspaceId, validBody(req, changePlanSchema)));
}

export async function resume(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, workspaceParamsSchema);
  res.json(await billing.resumeSubscription(requireAuth(req), workspaceId));
}
