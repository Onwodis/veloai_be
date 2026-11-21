/**
 * YouTube films API.
 *
 * /api/v1/workspaces/:workspaceId/youtube
 *   GET    /                         overview numbers + pricing + catalog + channels
 *   GET    /connect                  → { url } Google sign-in to connect a channel
 *   DELETE /channels/:channelId      disconnect (and revoke at Google)
 *   GET    /shows                    shows with counts and next publish time
 *   POST   /shows                    create a show (plans two weeks of films)
 *   GET    /shows/:showId            the show + its films
 *   PUT    /shows/:showId            edit (unmade films follow the new plan)
 *   DELETE /shows/:showId
 *   POST   /films/:filmId/write      { idea } (re)write the script (free)
 *   PUT    /films/:filmId            edit the script / YouTube details (free)
 *   POST   /films/:filmId/make       make it now (charged: the price is held, charged when finished)
 *   POST   /films/:filmId/approve    { approved } (review mode: publish on time once approved)
 *   POST   /films/:filmId/publish    publish now
 *   POST   /films/:filmId/skip       skip this slot
 *
 * /api/v1/youtube/oauth/callback     Google's redirect (public; signed state)
 * /api/v1/admin/youtube              GET / PUT the price and limits (super admin)
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import { VISUAL_STYLES } from '../studio/cinema.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { FILM_KINDS, MOODS, NARRATORS } from './catalog.js';
import * as channels from './channels.js';
import * as service from './service.js';
import { getYoutubeSettings, saveYoutubeSettings, youtubeSettingsSchema } from './settings.js';

const uuid = z.uuid();
const workspaceParams = z.strictObject({ workspaceId: uuid });
const showParams = workspaceParams.extend({ showId: uuid });
const filmParams = workspaceParams.extend({ filmId: uuid });
const channelParams = workspaceParams.extend({ channelId: uuid });

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};
const p = <S extends z.ZodType>(res: Response, schema: S) => validParams(res, schema);

const catalog = {
  filmKinds: Object.entries(FILM_KINDS).map(([id, kind]) => ({ id, label: kind.label, brief: kind.brief })),
  moods: Object.entries(MOODS).map(([id, mood]) => ({ id, label: mood.label })),
  visualStyles: Object.entries(VISUAL_STYLES).map(([id, style]) => ({ id, label: style.label })),
  narrators: [...NARRATORS],
};

export const youtubeRouter: Router = Router({ mergeParams: true });
youtubeRouter.use(authenticate);

youtubeRouter.get(
  '/',
  validate({ params: workspaceParams }),
  send(async (req, res) => {
    const auth = requireAuth(req);
    const { workspaceId } = p(res, workspaceParams);
    const [stats, pricing, list] = await Promise.all([service.overview(auth, workspaceId), service.pricing(), channels.listChannels(auth, workspaceId)]);
    return { stats, pricing, catalog, channels: list };
  }),
);
youtubeRouter.get('/connect', validate({ params: workspaceParams }), send(async (req, res) => ({ url: await channels.connectUrl(requireAuth(req), p(res, workspaceParams).workspaceId) })));
youtubeRouter.delete(
  '/channels/:channelId',
  validate({ params: channelParams }),
  send(async (req, res) => {
    const { workspaceId, channelId } = p(res, channelParams);
    await channels.disconnect(requireAuth(req), workspaceId, channelId);
    return { ok: true };
  }),
);

youtubeRouter.get('/shows', validate({ params: workspaceParams }), send(async (req, res) => ({ items: await service.listShows(requireAuth(req), p(res, workspaceParams).workspaceId) })));
youtubeRouter.post('/shows', validate({ params: workspaceParams, body: service.showSchema }), send(async (req, res) => service.createShow(requireAuth(req), p(res, workspaceParams).workspaceId, validBody(req, service.showSchema))));
youtubeRouter.get('/shows/:showId', validate({ params: showParams }), send(async (req, res) => service.getShow(requireAuth(req), p(res, showParams).workspaceId, p(res, showParams).showId)));
youtubeRouter.put('/shows/:showId', validate({ params: showParams, body: service.showSchema }), send(async (req, res) => service.updateShow(requireAuth(req), p(res, showParams).workspaceId, p(res, showParams).showId, validBody(req, service.showSchema))));
youtubeRouter.delete(
  '/shows/:showId',
  validate({ params: showParams }),
  send(async (req, res) => {
    await service.deleteShow(requireAuth(req), p(res, showParams).workspaceId, p(res, showParams).showId);
    return { ok: true };
  }),
);

const ideaSchema = z.strictObject({ idea: z.string().trim().max(600).default('') });
const approveSchema = z.strictObject({ approved: z.boolean() });
youtubeRouter.post('/films/:filmId/write', validate({ params: filmParams, body: ideaSchema }), send(async (req, res) => service.rewriteFilm(requireAuth(req), p(res, filmParams).workspaceId, p(res, filmParams).filmId, validBody(req, ideaSchema).idea)));
youtubeRouter.put('/films/:filmId', validate({ params: filmParams, body: service.filmEditSchema }), send(async (req, res) => service.editFilm(requireAuth(req), p(res, filmParams).workspaceId, p(res, filmParams).filmId, validBody(req, service.filmEditSchema))));
youtubeRouter.post('/films/:filmId/make', validate({ params: filmParams }), send(async (req, res) => service.makeNow(requireAuth(req), p(res, filmParams).workspaceId, p(res, filmParams).filmId)));
youtubeRouter.post('/films/:filmId/approve', validate({ params: filmParams, body: approveSchema }), send(async (req, res) => service.approveFilm(requireAuth(req), p(res, filmParams).workspaceId, p(res, filmParams).filmId, validBody(req, approveSchema).approved)));
youtubeRouter.post('/films/:filmId/publish', validate({ params: filmParams }), send(async (req, res) => service.publishNow(requireAuth(req), p(res, filmParams).workspaceId, p(res, filmParams).filmId)));
youtubeRouter.post(
  '/films/:filmId/skip',
  validate({ params: filmParams }),
  send(async (req, res) => {
    await service.skipFilm(requireAuth(req), p(res, filmParams).workspaceId, p(res, filmParams).filmId);
    return { ok: true };
  }),
);

/** Google's redirect after the channel owner approves (no session: the signed state says who). */
export const youtubeOauthRouter: Router = Router();
youtubeOauthRouter.get('/callback', async (req: Request, res: Response) => {
  const back = `${env.WEB_APP_URL}/dashboard/youtube`;
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : null;
  const state = typeof req.query['state'] === 'string' ? req.query['state'] : null;
  if (!code || !state) {
    res.redirect(`${back}?youtube=cancelled`);
    return;
  }
  try {
    res.redirect(await channels.finishConnect(code, state));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'youtube connect failed');
    res.redirect(`${back}?youtube=failed`);
  }
});

export const adminYoutubeRouter: Router = Router();
adminYoutubeRouter.use(authenticate, authorize('SUPER_ADMIN'));
adminYoutubeRouter.get('/', send(async () => ({ settings: await getYoutubeSettings(), redirectUri: channels.redirectUri(), configured: channels.youtubeConfigured() })));
adminYoutubeRouter.put('/', validate({ body: youtubeSettingsSchema }), send(async (req) => ({ settings: await saveYoutubeSettings(validBody(req, youtubeSettingsSchema), requireAuth(req).userId) })));
