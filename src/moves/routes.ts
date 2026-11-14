/**
 * /api/v1/moves                       the library (filters, pages), templates, my moves,
 *                                     sharing (move id + key), favourites
 * /api/v1/workspaces/:id/scene-moves  moves on characters in a scene, suggestions, templates
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import * as custom from './custom.js';
import { libraryMove, librarySize, listMoves, listTemplates } from './library.js';
import { addSceneMoveSchema, applyTemplateSchema, customMoveSchema, importSchema, libraryQuery, moveRef, templateQuery } from './schemas.js';
import * as scenes from './sceneMoves.js';
import { CATEGORY_INFO } from './types.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};

export const movesRouter: Router = Router();
movesRouter.use(authenticate);

movesRouter.get('/', validate({ query: libraryQuery }), send(async (req, res) => {
  const query = validQuery(res, libraryQuery);
  const favourites = await custom.favourites(requireAuth(req).userId);
  const result = query.favourites
    ? (() => {
        const items = favourites.flatMap((ref) => libraryMove(ref) ?? []).filter((move) => !query.domain || move.domain === query.domain);
        return { items, total: items.length, page: 1, pages: 1, facets: {} };
      })()
    : listMoves(query);
  return { ...result, favourites, categories: CATEGORY_INFO, librarySize: librarySize() };
}));

const refParams = z.strictObject({ ref: moveRef });
movesRouter.get('/library/:ref', validate({ params: refParams }), send(async (_req, res) => {
  const move = libraryMove(validParams(res, refParams).ref);
  if (!move) return { move: null };
  return { move };
}));

movesRouter.get('/templates', validate({ query: templateQuery }), send(async (_req, res) => ({ templates: listTemplates(validQuery(res, templateQuery)) })));

movesRouter.get('/mine', send(async (req) => custom.listMine(requireAuth(req))));
movesRouter.post('/mine', validate({ body: customMoveSchema }), send(async (req) => ({ move: await custom.createMove(requireAuth(req), validBody(req, customMoveSchema)) })));
const mineParams = z.strictObject({ moveId: z.string().regex(/^CM-[A-HJ-NP-Z2-9]{8}$/) });
movesRouter.put('/mine/:moveId', validate({ params: mineParams, body: customMoveSchema }), send(async (req, res) => ({
  move: await custom.updateMove(requireAuth(req), validParams(res, mineParams).moveId, validBody(req, customMoveSchema)),
})));
movesRouter.delete('/mine/:moveId', validate({ params: mineParams }), send(async (req, res) => {
  await custom.removeMove(requireAuth(req), validParams(res, mineParams).moveId);
  return { ok: true };
}));
movesRouter.post('/mine/:moveId/rotate-key', validate({ params: mineParams }), send(async (req, res) => ({ move: await custom.rotateKey(requireAuth(req), validParams(res, mineParams).moveId) })));
movesRouter.post('/import', validate({ body: importSchema }), send(async (req) => {
  const body = validBody(req, importSchema);
  return custom.importMove(requireAuth(req), body.moveId, body.key);
}));

const favouriteBody = z.strictObject({ on: z.boolean() });
movesRouter.put('/favourites/:ref', validate({ params: refParams, body: favouriteBody }), send(async (req, res) => ({
  favourites: await custom.setFavourite(requireAuth(req).userId, validParams(res, refParams).ref, validBody(req, favouriteBody).on),
})));

/* ------------------------------------------------------------------ scene moves */

export const sceneMovesRouter: Router = Router({ mergeParams: true });
sceneMovesRouter.use(authenticate);

const sceneParams = z.strictObject({ workspaceId: z.uuid(), projectId: z.uuid(), sceneId: z.uuid() });
const contextQuery = z.strictObject({ characterId: z.uuid().optional(), characterName: z.string().trim().max(60).optional() });
sceneMovesRouter.get('/:projectId/:sceneId', validate({ params: sceneParams, query: contextQuery }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = validParams(res, sceneParams);
  return scenes.sceneMoveContext(requireAuth(req), workspaceId, projectId, sceneId, validQuery(res, contextQuery));
}));
sceneMovesRouter.post('/:projectId/:sceneId', validate({ params: sceneParams, body: addSceneMoveSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = validParams(res, sceneParams);
  return scenes.addSceneMove(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, addSceneMoveSchema));
}));
const entryParams = sceneParams.extend({ entryId: z.uuid() });
sceneMovesRouter.delete('/:projectId/:sceneId/:entryId', validate({ params: entryParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId, entryId } = validParams(res, entryParams);
  return scenes.removeSceneMove(requireAuth(req), workspaceId, projectId, sceneId, entryId);
}));
sceneMovesRouter.post('/:projectId/:sceneId/template', validate({ params: sceneParams, body: applyTemplateSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = validParams(res, sceneParams);
  const body = validBody(req, applyTemplateSchema);
  return scenes.applyTemplate(requireAuth(req), workspaceId, projectId, sceneId, body.templateId, body.mode);
}));
