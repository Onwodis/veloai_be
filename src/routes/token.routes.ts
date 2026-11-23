/**
 * Tokens & payments.
 *
 * Workspace (members; buying = owner; reserving = owner/editor):
 *   GET  /api/v1/workspaces/:workspaceId/tokens                         wallet, packages, ledger, payments
 *   POST /api/v1/workspaces/:workspaceId/tokens/preflight               can this task start? (estimate vs available)
 *   POST /api/v1/workspaces/:workspaceId/tokens/reservations            THE GATE: hold tokens before creating an asset
 *   POST /api/v1/workspaces/:workspaceId/tokens/reservations/:id/settle charge actual usage, release the rest
 *   POST /api/v1/workspaces/:workspaceId/tokens/reservations/:id/release cancel: release the hold
 *   POST /api/v1/workspaces/:workspaceId/tokens/checkout                start a Paystack purchase
 *
 * Payments:
 *   GET  /api/v1/payments/paystack/verify/:reference                    verify + credit (callback page)
 *   POST /api/v1/payments/paystack/webhook                              mounted in app.ts with a raw body
 *
 * Super admin (/api/v1/admin/tokens/...):
 *   GET   /settings      PATCH /settings      POST /estimate
 *   GET   /payments      POST  /grant         GET  /workspaces
 */
import { Router } from 'express';
import * as tokens from '../controllers/token.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { mfaLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
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

export const workspaceTokenRouter: Router = Router({ mergeParams: true });
workspaceTokenRouter.use(authenticate);
workspaceTokenRouter.get('/', validate({ params: tokenWorkspaceParamsSchema }), tokens.overview);
workspaceTokenRouter.get('/wallet', validate({ params: tokenWorkspaceParamsSchema }), tokens.wallet);
workspaceTokenRouter.post('/preflight', validate({ params: tokenWorkspaceParamsSchema, body: estimateInputSchema }), tokens.preflight);
workspaceTokenRouter.post('/proceed', validate({ params: tokenWorkspaceParamsSchema }), tokens.proceedLowBalance);
workspaceTokenRouter.post('/reservations', validate({ params: tokenWorkspaceParamsSchema, body: reserveSchema }), tokens.reserve);
workspaceTokenRouter.post('/reservations/:reservationId/settle', validate({ params: reservationParamsSchema, body: settleSchema }), tokens.settle);
workspaceTokenRouter.post('/reservations/:reservationId/release', validate({ params: reservationParamsSchema }), tokens.release);
// Checkout reuses the per-IP 2FA limiter (30 / 15 min): plenty for humans, stops scripted abuse.
workspaceTokenRouter.post('/checkout', mfaLimiter, validate({ params: tokenWorkspaceParamsSchema, body: checkoutSchema }), tokens.checkout);

export const paymentRouter: Router = Router();
paymentRouter.get('/paystack/verify/:reference', authenticate, validate({ params: referenceParamsSchema }), tokens.verifyPayment);

export const adminTokenRouter: Router = Router();
adminTokenRouter.use(authenticate, authorize('SUPER_ADMIN'));
adminTokenRouter.get('/settings', tokens.adminSettings);
adminTokenRouter.patch('/settings', validate({ body: tokenSettingsPatchSchema }), tokens.adminUpdateSettings);
adminTokenRouter.post('/estimate', validate({ body: estimateInputSchema }), tokens.adminEstimate);
adminTokenRouter.get('/payments', tokens.adminPayments);
adminTokenRouter.post('/grant', validate({ body: grantSchema }), tokens.adminGrant);
adminTokenRouter.get('/workspaces', validate({ query: workspacesQuerySchema }), tokens.adminWorkspaces);
