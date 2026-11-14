/**
 * /api/v1/me/layouts/:pageKey — the signed-in user's arrangement of a page
 * (section order, widths, heights, hidden sections), so it always opens the
 * way they left it.
 *
 *   GET     → { layout | null }
 *   PUT     { layout } (≤ 16 KB) → saved
 *   DELETE  → back to the page default
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';

const params = z.strictObject({ pageKey: z.string().regex(/^[a-z0-9:_-]{2,80}$/) });
const sectionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  span: z.number().int().min(3).max(12),
  height: z.number().int().min(80).max(4000).nullable(),
  hidden: z.boolean(),
});
const layoutSchema = z.strictObject({ version: z.literal(1), sections: z.array(sectionSchema).max(30) });
const body = z.strictObject({ layout: layoutSchema });

export const layoutRouter: Router = Router();
layoutRouter.use(authenticate);

layoutRouter.get('/:pageKey', validate({ params }), async (req: Request, res: Response) => {
  const { pageKey } = validParams(res, params);
  const [row] = await sql<{ layout: unknown }[]>`SELECT layout FROM user_layouts WHERE user_id = ${requireAuth(req).userId} AND page_key = ${pageKey}`;
  res.json({ layout: row?.layout ?? null });
});

layoutRouter.put('/:pageKey', validate({ params, body }), async (req: Request, res: Response) => {
  const { pageKey } = validParams(res, params);
  const { layout } = validBody(req, body);
  if (JSON.stringify(layout).length > 16_000) throw AppError.badRequest('That layout is too large to save.');
  await sql`
    INSERT INTO user_layouts (user_id, page_key, layout, updated_at) VALUES (${requireAuth(req).userId}, ${pageKey}, ${json(layout)}, now())
    ON CONFLICT (user_id, page_key) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()`;
  res.json({ layout });
});

layoutRouter.delete('/:pageKey', validate({ params }), async (req: Request, res: Response) => {
  const { pageKey } = validParams(res, params);
  await sql`DELETE FROM user_layouts WHERE user_id = ${requireAuth(req).userId} AND page_key = ${pageKey}`;
  res.json({ layout: null });
});
