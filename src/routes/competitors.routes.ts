/**
 *   GET  /api/v1/admin/competitors          super admin: the comparison matrix + positioning
 *   PUT  /api/v1/admin/competitors          super admin: save it
 *   POST /api/v1/admin/competitors/reset    super admin: back to the starting matrix
 */
import { Router, type Request, type Response } from 'express';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody } from '../middleware/validate.js';
import { competitorsSchema, DEFAULT_COMPETITORS, getCompetitors, saveCompetitors } from '../services/competitors.service.js';
import { benchmark } from '../admin360/benchmark.js';

export const adminCompetitorsRouter: Router = Router();
adminCompetitorsRouter.use(authenticate, authorize('SUPER_ADMIN'));
/* Benchmark & bottlenecks: scorecard vs named competitors, live bottlenecks, improvement plan. */
adminCompetitorsRouter.get('/benchmark', async (_req: Request, res: Response) => {
  res.json(await benchmark());
});
adminCompetitorsRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ competitors: await getCompetitors() });
});
adminCompetitorsRouter.put('/', validate({ body: competitorsSchema }), async (req: Request, res: Response) => {
  res.json({ competitors: await saveCompetitors(validBody(req, competitorsSchema), requireAuth(req).userId) });
});
adminCompetitorsRouter.post('/reset', async (req: Request, res: Response) => {
  res.json({ competitors: await saveCompetitors(DEFAULT_COMPETITORS, requireAuth(req).userId) });
});
