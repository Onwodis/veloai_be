/**
 * /api/v1/workspaces/:id/share-links   make, list, rotate, re-time, revoke links
 * /api/v1/me/share-links               my default lifetime, expire every link I made
 * /api/v1/public/share/:token          the public side (no sign-in): info, stream, download
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';
import * as sharing from './service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};

const days = z.number().int().min(1).max(365).nullable();
const kind = z.enum(['PROJECT_OUTPUT', 'TAKE', 'AD_VERSION', 'ASSET']);

export const shareLinksRouter: Router = Router({ mergeParams: true });
shareLinksRouter.use(authenticate);

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const linkParams = workspaceParams.extend({ linkId: z.uuid() });
const listQuery = z.strictObject({ projectId: z.uuid().optional(), assetKind: kind.optional(), assetRef: z.string().max(64).optional() });
const createBody = z.strictObject({
  projectId: z.uuid(),
  assetKind: kind,
  assetRef: z.string().trim().max(64).default(''),
  mode: z.enum(['VIEW', 'DOWNLOAD']),
  /** Omitted = the user's default; null = never expires. */
  expiresInDays: days.optional(),
});

shareLinksRouter.get('/', validate({ params: workspaceParams, query: listQuery }), send(async (req, res) => sharing.listLinks(requireAuth(req), validParams(res, workspaceParams).workspaceId, validQuery(res, listQuery))));
shareLinksRouter.post('/', validate({ params: workspaceParams, body: createBody }), send(async (req, res) => ({
  link: await sharing.createLink(requireAuth(req), validParams(res, workspaceParams).workspaceId, validBody(req, createBody)),
})));
shareLinksRouter.post('/:linkId/rotate', validate({ params: linkParams }), send(async (req, res) => {
  const { workspaceId, linkId } = validParams(res, linkParams);
  return { link: await sharing.rotateLink(requireAuth(req), workspaceId, linkId) };
}));
const expiryBody = z.strictObject({ expiresInDays: days });
shareLinksRouter.put('/:linkId/expiry', validate({ params: linkParams, body: expiryBody }), send(async (req, res) => {
  const { workspaceId, linkId } = validParams(res, linkParams);
  return { link: await sharing.updateExpiry(requireAuth(req), workspaceId, linkId, validBody(req, expiryBody).expiresInDays) };
}));
shareLinksRouter.delete('/:linkId', validate({ params: linkParams }), send(async (req, res) => {
  const { workspaceId, linkId } = validParams(res, linkParams);
  return { link: await sharing.revokeLink(requireAuth(req), workspaceId, linkId) };
}));

export const myShareLinksRouter: Router = Router();
myShareLinksRouter.use(authenticate);
const prefsBody = z.strictObject({ defaultDays: days });
myShareLinksRouter.get('/', send(async (req) => ({ defaultDays: await sharing.defaultDays(requireAuth(req).userId) })));
myShareLinksRouter.put('/', validate({ body: prefsBody }), send(async (req) => sharing.setDefaultDays(requireAuth(req), validBody(req, prefsBody).defaultDays)));
myShareLinksRouter.post('/expire-all', send(async (req) => sharing.expireAll(requireAuth(req))));

/* ------------------------------------------------------------------ public (no sign-in) */

export const publicShareRouter: Router = Router();
const tokenParams = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{40,400}$/) });

publicShareRouter.get('/:token', validate({ params: tokenParams }), async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.json(await sharing.publicInfo(validParams(res, tokenParams).token));
});

publicShareRouter.get('/:token/stream', validate({ params: tokenParams }), async (req: Request, res: Response) => {
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const stream = await sharing.publicStream(validParams(res, tokenParams).token, range);
  res.status(stream.status);
  for (const [name, value] of Object.entries(stream.headers)) res.setHeader(name, value);
  res.setHeader('X-Robots-Tag', 'noindex');
  // The browser drops the connection on every seek: stop reading from storage, quietly.
  req.on('close', () => stream.body.destroy());
  stream.body.on('error', (error) => {
    logger.debug({ err: error }, 'share stream ended');
    res.destroy();
  });
  stream.body.pipe(res);
});

publicShareRouter.get('/:token/download', validate({ params: tokenParams }), async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, await sharing.publicDownload(validParams(res, tokenParams).token));
});
