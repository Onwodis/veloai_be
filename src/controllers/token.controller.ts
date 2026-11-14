/**
 * Token wallet, gating, Paystack checkout and super admin token controls.
 */
import type { Request, Response } from 'express';
import { estimateTask } from '../config/tokenSettings.js';
import { requireAuth } from '../middleware/authenticate.js';
import { validBody, validParams, validQuery } from '../middleware/validate.js';
import {
  checkoutSchema,
  estimateInputSchema,
  grantSchema,
  referenceParamsSchema,
  reservationParamsSchema,
  reserveSchema,
  settleSchema,
  tokenSettingsPatchSchema,
  tokenWorkspaceParamsSchema,
  workspacesQuerySchema,
} from '../models/token.schemas.js';
import * as paystack from '../services/paystack.service.js';
import { getTokenSettings, updateTokenSettings } from '../services/settings.service.js';
import * as tokens from '../services/token.service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

/* ------------------------------------------------------------------ workspace */

export async function overview(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, tokenWorkspaceParamsSchema);
  res.json(await tokens.overview(requireAuth(req), workspaceId));
}

/** Just the balance, for the navbar chip (polled; the overview is much heavier). */
export async function wallet(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, tokenWorkspaceParamsSchema);
  res.json(await tokens.walletFor(requireAuth(req), workspaceId));
}

export async function preflight(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, tokenWorkspaceParamsSchema);
  res.json(await tokens.preflight(requireAuth(req), workspaceId, validBody(req, estimateInputSchema)));
}

export async function reserve(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, tokenWorkspaceParamsSchema);
  const { taskType, ...input } = validBody(req, reserveSchema);
  // Marked so the browser may release this hold (and only this kind).
  res.status(201).json(await tokens.reserve(requireAuth(req), workspaceId, taskType, { ...input, [tokens.CLIENT_HELD]: true } as typeof input));
}

export async function settle(req: Request, res: Response): Promise<void> {
  const { workspaceId, reservationId } = validParams(res, reservationParamsSchema);
  const { actualTokens } = validBody(req, settleSchema);
  res.json({ reservation: await tokens.settle(requireAuth(req), workspaceId, reservationId, actualTokens) });
}

export async function release(req: Request, res: Response): Promise<void> {
  const { workspaceId, reservationId } = validParams(res, reservationParamsSchema);
  res.json({ reservation: await tokens.release(requireAuth(req), workspaceId, reservationId) });
}

export async function checkout(req: Request, res: Response): Promise<void> {
  const { workspaceId } = validParams(res, tokenWorkspaceParamsSchema);
  const { packageId } = validBody(req, checkoutSchema);
  res.status(201).json(await paystack.startCheckout(requireAuth(req), workspaceId, packageId));
}

/* ------------------------------------------------------------------ payments */

export async function verifyPayment(req: Request, res: Response): Promise<void> {
  const { reference } = validParams(res, referenceParamsSchema);
  res.json(await paystack.verifyForUser(requireAuth(req), reference));
}

/** Mounted with express.raw() so the HMAC is computed over the exact bytes. */
export async function paystackWebhook(req: Request, res: Response): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  try {
    await paystack.handleWebhook(raw, req.get('x-paystack-signature'));
    res.sendStatus(200);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) logger.error({ err: error }, 'paystack webhook processing failed');
    // 401 for bad signatures; 5xx makes Paystack retry later.
    res.sendStatus(status === 401 ? 401 : status >= 500 ? 500 : 200);
  }
}

/* ------------------------------------------------------------------ super admin */

export async function adminSettings(_req: Request, res: Response): Promise<void> {
  res.json({ settings: await getTokenSettings(), keys: paystack.keyStatus() });
}

export async function adminUpdateSettings(req: Request, res: Response): Promise<void> {
  const patch = validBody(req, tokenSettingsPatchSchema);
  if (patch.paystackMode === 'LIVE' && !paystack.keyStatus().LIVE) {
    throw AppError.badRequest('Set PAYSTACK_LIVE_SECRET_KEY in the API .env before switching to live mode');
  }
  res.json({ settings: await updateTokenSettings(patch, requireAuth(req).userId), keys: paystack.keyStatus() });
}

/** Token calculator: cost of a task under current (or proposed) costs. */
export async function adminEstimate(req: Request, res: Response): Promise<void> {
  const input = validBody(req, estimateInputSchema);
  res.json({ estimate: estimateTask(await getTokenSettings(), input) });
}

export async function adminPayments(_req: Request, res: Response): Promise<void> {
  res.json(await paystack.paymentStats());
}

export async function adminGrant(req: Request, res: Response): Promise<void> {
  const { workspaceId, amount, note } = validBody(req, grantSchema);
  res.json({ wallet: await tokens.grant(requireAuth(req).userId, workspaceId, amount, note) });
}

export async function adminWorkspaces(_req: Request, res: Response): Promise<void> {
  const { page, pageSize, search } = validQuery(res, workspacesQuerySchema);
  res.json(await tokens.listWorkspacesWithWallets(search, page, pageSize));
}
