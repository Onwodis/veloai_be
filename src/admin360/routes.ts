/**
 * /api/v1/admin/users/:userId/*   super admin: one user, every angle
 *
 *   GET    /overview                 identity, security, last seen, wallets, numbers
 *   GET    /assets?kind&page         studio | reels | creations | likeness | files
 *   GET    /billing?page             ledger, payments (receipts), holds, storage packs
 *   GET    /activity?page            requests, security events, sessions, visits
 *   GET    /tickets                  support tickets
 *   POST   /credits                  { amount (±), note, workspaceId? } audited ledger entry
 *   POST   /suspend                  { reason }  /  DELETE /suspend  reinstate
 *   POST   /sessions/revoke          sign the user out everywhere
 *   PUT    /storage-quota            { quotaBytes | null }
 *
 * /api/v1/admin/support            ticket queue (any user): list, get, reply, update, resolve
 * /api/v1/support                  the signed-in user's own tickets
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import * as support from '../support/service.js';
import { assetDetail, browseAssets } from './assetBrowser.js';
import { commandCenter } from './commandCenter.js';
import { insights } from './insights.js';
import * as admin360 from './service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};
const meta = (req: Request) => ({ ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

const userParams = z.strictObject({ userId: z.uuid() });
const pageQuery = z.strictObject({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(5).max(100).default(25) });
const assetsQuery = pageQuery.extend({ kind: z.enum(['studio', 'reels', 'creations', 'likeness', 'files']).default('studio') });
const creditSchema = z.strictObject({
  amount: z
    .number()
    .int()
    .min(-10_000_000)
    .max(10_000_000)
    .refine((value) => value !== 0, { error: 'Enter a non-zero amount' }),
  note: z.string().trim().min(3, { error: 'Say why (it is shown in the ledger)' }).max(200),
  workspaceId: z.uuid().optional(),
});
const suspendSchema = z.strictObject({ reason: z.string().trim().min(3).max(300) });
const deleteUserSchema = z.strictObject({ confirmEmail: z.string().trim().min(3).max(320) });
const quotaSchema = z.strictObject({ quotaBytes: z.number().int().min(0).max(10 * 1024 ** 4).nullable() });

export const adminUserRouter: Router = Router({ mergeParams: true });
adminUserRouter.use(authenticate, authorize('SUPER_ADMIN'));
const uid = (res: Response): string => validParams(res, userParams).userId;

adminUserRouter.get('/:userId/overview', validate({ params: userParams }), send(async (_req, res) => admin360.overview(uid(res))));
adminUserRouter.get('/:userId/assets', validate({ params: userParams, query: assetsQuery }), send(async (_req, res) => {
  const query = validQuery(res, assetsQuery);
  return { items: await admin360.assets(uid(res), query.kind, query.page, query.pageSize), page: query.page, pageSize: query.pageSize };
}));
adminUserRouter.get('/:userId/billing', validate({ params: userParams, query: pageQuery }), send(async (_req, res) => {
  const query = validQuery(res, pageQuery);
  return admin360.billing(uid(res), query.page, query.pageSize);
}));
adminUserRouter.get('/:userId/activity', validate({ params: userParams, query: pageQuery }), send(async (_req, res) => {
  const query = validQuery(res, pageQuery);
  return admin360.activity(uid(res), query.page, query.pageSize);
}));
adminUserRouter.get('/:userId/tickets', validate({ params: userParams }), send(async (_req, res) => admin360.tickets(uid(res))));
adminUserRouter.post('/:userId/credits', validate({ params: userParams, body: creditSchema }), send(async (req, res) => admin360.credit(requireAuth(req).userId, uid(res), validBody(req, creditSchema))));
adminUserRouter.post('/:userId/suspend', validate({ params: userParams, body: suspendSchema }), send(async (req, res) =>
  admin360.setSuspended(requireAuth(req).userId, uid(res), true, validBody(req, suspendSchema).reason, meta(req)),
));
adminUserRouter.delete('/:userId/suspend', validate({ params: userParams }), send(async (req, res) => admin360.setSuspended(requireAuth(req).userId, uid(res), false, undefined, meta(req))));
adminUserRouter.get('/:userId/deletion', validate({ params: userParams }), send(async (_req, res) => admin360.deletionPreview(uid(res))));
adminUserRouter.post('/:userId/delete', validate({ params: userParams, body: deleteUserSchema }), send(async (req, res) => admin360.scheduleDeletion(requireAuth(req).userId, uid(res), validBody(req, deleteUserSchema).confirmEmail, meta(req))));
adminUserRouter.post('/:userId/restore', validate({ params: userParams }), send(async (req, res) => admin360.restoreUser(requireAuth(req).userId, uid(res))));
adminUserRouter.post('/:userId/sessions/revoke', validate({ params: userParams }), send(async (req, res) => admin360.revokeSessions(uid(res), meta(req))));
adminUserRouter.put('/:userId/storage-quota', validate({ params: userParams, body: quotaSchema }), send(async (req, res) => admin360.setStorageQuota(uid(res), validBody(req, quotaSchema).quotaBytes)));

/* ------------------------------------------------------------------ support: staff queue */

const ticketParams = z.strictObject({ ticketId: z.uuid() });
const ticketsQuery = pageQuery.extend({ status: z.enum(support.STATUSES).optional(), search: z.string().trim().max(120).optional() });
const replySchema = z.strictObject({ body: z.string().trim().min(1).max(8000), internal: z.boolean().default(false) });
const ticketPatch = z.strictObject({ status: z.enum(support.STATUSES).optional(), priority: z.enum(support.PRIORITIES).optional(), category: z.enum(support.CATEGORIES).optional() });
const resolveSchema = z.strictObject({ resolution: z.string().trim().min(3).max(4000), creditTokens: z.number().int().min(0).max(10_000_000).optional() });

export const adminSupportRouter: Router = Router();
adminSupportRouter.use(authenticate, authorize('SUPER_ADMIN'));
const tid = (res: Response): string => validParams(res, ticketParams).ticketId;
adminSupportRouter.get('/', validate({ query: ticketsQuery }), send(async (_req, res) => support.listAll(validQuery(res, ticketsQuery))));
adminSupportRouter.get('/:ticketId', validate({ params: ticketParams }), send(async (req, res) => support.get(requireAuth(req), tid(res))));
adminSupportRouter.post('/:ticketId/messages', validate({ params: ticketParams, body: replySchema }), send(async (req, res) => {
  const body = validBody(req, replySchema);
  return support.reply(requireAuth(req), tid(res), body.body, body.internal);
}));
adminSupportRouter.patch('/:ticketId', validate({ params: ticketParams, body: ticketPatch }), send(async (req, res) => support.updateTicket(requireAuth(req), tid(res), validBody(req, ticketPatch))));
adminSupportRouter.post('/:ticketId/resolve', validate({ params: ticketParams, body: resolveSchema }), send(async (req, res) => support.resolve(requireAuth(req), tid(res), validBody(req, resolveSchema))));

/* ------------------------------------------------------------------ support: the user's own tickets */

const newTicket = z.strictObject({
  subject: z.string().trim().min(4, { error: 'Give the ticket a short subject' }).max(160),
  category: z.enum(support.CATEGORIES).default('GENERAL'),
  body: z.string().trim().min(10, { error: 'Describe the problem (at least 10 characters)' }).max(8000),
  workspaceId: z.uuid().optional(),
});
const userReply = z.strictObject({ body: z.string().trim().min(1).max(8000) });

export const supportRouter: Router = Router();
supportRouter.use(authenticate);
supportRouter.get('/tickets', send(async (req) => ({ items: await support.listMine(requireAuth(req)) })));
supportRouter.post('/tickets', validate({ body: newTicket }), send(async (req) => support.create(requireAuth(req), validBody(req, newTicket))));
supportRouter.get('/tickets/:ticketId', validate({ params: ticketParams }), send(async (req, res) => support.get(requireAuth(req), tid(res))));
supportRouter.post('/tickets/:ticketId/messages', validate({ params: ticketParams, body: userReply }), send(async (req, res) => support.reply(requireAuth(req), tid(res), validBody(req, userReply).body)));
supportRouter.post('/tickets/:ticketId/close', validate({ params: ticketParams }), send(async (req, res) => support.closeMine(requireAuth(req), tid(res))));

/* ------------------------------------------------------------------ command center */

const rangeQuery = z.strictObject({ range: z.coerce.number().int().refine((value) => [7, 30, 90, 365].includes(value)).default(30) });
export const commandCenterRouter: Router = Router();
commandCenterRouter.use(authenticate, authorize('SUPER_ADMIN'));
commandCenterRouter.get('/', validate({ query: rangeQuery }), send(async (_req, res) => commandCenter(validQuery(res, rangeQuery).range)));

/* ------------------------------------------------------------------ asset browser */

const browseQuery = z.strictObject({
  kind: z.enum(['TAKE', 'MASTER']).default('TAKE'),
  userId: z.uuid().optional(),
  projectKind: z.enum(['MUSIC_VIDEO', 'COMMERCIAL', 'AI_VIDEO']).optional(),
  status: z.enum(['READY', 'FAILED', 'RUNNING']).optional(),
  review: z.enum(['FLAG', 'GOOD', 'UNREVIEWED']).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(6).max(60).default(24),
});
const assetParams = z.strictObject({ kind: z.enum(['TAKE', 'MASTER']), id: z.uuid() });
export const assetBrowserRouter: Router = Router();
assetBrowserRouter.use(authenticate, authorize('SUPER_ADMIN'));
assetBrowserRouter.get('/', validate({ query: browseQuery }), send(async (_req, res) => browseAssets(validQuery(res, browseQuery))));
assetBrowserRouter.get('/:kind/:id', validate({ params: assetParams }), send(async (_req, res) => {
  const { kind, id } = validParams(res, assetParams);
  return assetDetail(kind, id);
}));

/* ------------------------------------------------------------------ traffic & security insights */

const insightsQuery = z.strictObject({ range: z.coerce.number().int().refine((value) => [1, 7, 30, 90].includes(value)).default(7) });
export const insightsRouter: Router = Router();
insightsRouter.use(authenticate, authorize('SUPER_ADMIN'));
insightsRouter.get('/', validate({ query: insightsQuery }), send(async (_req, res) => insights(validQuery(res, insightsQuery).range)));
