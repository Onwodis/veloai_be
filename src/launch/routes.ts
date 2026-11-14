/**
 * /api/v1/admin/launch  (super admin)
 *
 *   GET   /                     launch checks + wallet + last handshakes
 *   POST  /handshake            call every active LLM / engine now
 *   GET   /wallet/usage?range=  usage by day / model / source, burn rate, ledger
 *   POST  /wallet/fund          { mode: set|topup|adjust, tokens, recalibrate, note }
 *   PATCH /wallet/alarm         { alarmPercent, alarmEmails, input/outputUsdPerMtok, providerNote }
 *   POST  /wallet/alarm/test    send the alarm email now
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validQuery } from '../middleware/validate.js';
import { getLastHandshakes, runChecks, runHandshakes } from './guard.js';
import { fundWallet, getWallet, testAlarm, updateAlarm, usageReport } from './wallet.js';

const rangeQuery = z.strictObject({
  range: z.coerce.number().int().refine((value) => [7, 30, 90].includes(value), { error: 'range must be 7, 30 or 90' }).default(30),
});
const fundSchema = z.strictObject({
  mode: z.enum(['set', 'topup', 'adjust']),
  tokens: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
  recalibrate: z.boolean().default(true),
  note: z.string().trim().max(300).default(''),
});
const alarmSchema = z.strictObject({
  alarmPercent: z.number().int().min(1).max(100).optional(),
  alarmEmails: z.array(z.email().max(254)).max(10).optional(),
  inputUsdPerMtok: z.number().min(0).max(10_000).optional(),
  outputUsdPerMtok: z.number().min(0).max(10_000).optional(),
  providerNote: z.string().trim().max(200).optional(),
});

export const launchRouter: Router = Router();
launchRouter.use(authenticate, authorize('SUPER_ADMIN'));

launchRouter.get('/', async (req: Request, res: Response) => {
  const checks = await runChecks();
  const wallet = await getWallet(requireAuth(req)).catch(() => null);
  res.json({ checks, ready: checks.every((check) => check.status !== 'fail'), wallet, handshakes: getLastHandshakes() });
});

launchRouter.post('/handshake', async (_req: Request, res: Response) => {
  res.json(await runHandshakes());
});

launchRouter.get('/wallet/usage', validate({ query: rangeQuery }), async (req: Request, res: Response) => {
  res.json(await usageReport(requireAuth(req), validQuery(res, rangeQuery).range));
});

launchRouter.post('/wallet/fund', validate({ body: fundSchema }), async (req: Request, res: Response) => {
  res.json({ wallet: await fundWallet(requireAuth(req), validBody(req, fundSchema)) });
});

launchRouter.patch('/wallet/alarm', validate({ body: alarmSchema }), async (req: Request, res: Response) => {
  res.json({ wallet: await updateAlarm(requireAuth(req), validBody(req, alarmSchema)) });
});

launchRouter.post('/wallet/alarm/test', async (req: Request, res: Response) => {
  res.json(await testAlarm(requireAuth(req)));
});
