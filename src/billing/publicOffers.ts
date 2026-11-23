/**
 * What the public site may promise (no auth): whether the free trial is on, and the welcome tokens.
 * The landing page's "Start free" wording follows it, so it never promises a trial that is off.
 */
import { Router, type Request, type Response } from 'express';
import { getTokenSettings } from '../services/settings.service.js';
import { getTrialSettings } from './trial.js';

export const publicOffersRouter: Router = Router();
publicOffersRouter.get('/', async (_req: Request, res: Response) => {
  const [trial, tokens] = await Promise.all([getTrialSettings(), getTokenSettings()]);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ trial: { enabled: trial.enabled, tokens: trial.tokens, days: trial.days }, welcomeTokens: tokens.signupBonus });
});
