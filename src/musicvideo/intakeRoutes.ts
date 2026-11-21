/**
 * Public side of the artist upload link (no sign-in): /api/v1/public/artist-upload/:token
 *
 *   GET    /:token          what the link asks for (or that it was already used)
 *   POST   /:token/uploads  a one-shot upload address for the song or one photo
 *   POST   /:token/submit   the one submission (closes the link, emails the creator)
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { intakeLimiter } from '../middleware/rateLimit.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import * as intake from './intake.js';

const tokenParams = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) });

export const publicIntakeRouter: Router = Router();
publicIntakeRouter.use(intakeLimiter);

publicIntakeRouter.get('/:token', validate({ params: tokenParams }), async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await intake.publicIntake(validParams(res, tokenParams).token));
});
publicIntakeRouter.post('/:token/uploads', validate({ params: tokenParams, body: intake.uploadRequestSchema }), async (req: Request, res: Response) => {
  res.json(await intake.intakeUpload(validParams(res, tokenParams).token, validBody(req, intake.uploadRequestSchema)));
});
publicIntakeRouter.post('/:token/submit', validate({ params: tokenParams, body: intake.submissionSchema }), async (req: Request, res: Response) => {
  res.json(await intake.submitIntake(validParams(res, tokenParams).token, validBody(req, intake.submissionSchema)));
});
