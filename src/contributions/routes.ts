/**
 * /api/v1/workspaces/:id/pushes                    the creator's inbox
 * /api/v1/workspaces/:id/pushes/:projectId         history (+ unpushed changes), push
 * /api/v1/workspaces/:id/pushes/:projectId/:push   diff, accept, revert, restore
 * /api/v1/me/push-prefs                            "push for me" setting
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import * as contributions from './service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};

export const pushesRouter: Router = Router({ mergeParams: true });
pushesRouter.use(authenticate);

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const projectParams = workspaceParams.extend({ projectId: z.uuid() });
const pushParams = projectParams.extend({ pushId: z.uuid() });
const pushBody = z.strictObject({ message: z.string().trim().max(300).default(''), auto: z.boolean().default(false) });

pushesRouter.get('/', validate({ params: workspaceParams }), send(async (req, res) => contributions.inbox(requireAuth(req), validParams(res, workspaceParams).workspaceId)));
pushesRouter.get('/:projectId', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  return contributions.listPushes(requireAuth(req), workspaceId, projectId);
}));
pushesRouter.post('/:projectId', validate({ params: projectParams, body: pushBody }), send(async (req, res) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  const body = validBody(req, pushBody);
  return contributions.push(requireAuth(req), workspaceId, projectId, body.message, body.auto);
}));
pushesRouter.get('/:projectId/:pushId', validate({ params: pushParams }), send(async (req, res) => {
  const { workspaceId, projectId, pushId } = validParams(res, pushParams);
  return contributions.diffPush(requireAuth(req), workspaceId, projectId, pushId);
}));
pushesRouter.post('/:projectId/:pushId/accept', validate({ params: pushParams }), send(async (req, res) => {
  const { workspaceId, projectId, pushId } = validParams(res, pushParams);
  return contributions.acceptPush(requireAuth(req), workspaceId, projectId, pushId);
}));
pushesRouter.post('/:projectId/:pushId/revert', validate({ params: pushParams }), send(async (req, res) => {
  const { workspaceId, projectId, pushId } = validParams(res, pushParams);
  return contributions.revertPush(requireAuth(req), workspaceId, projectId, pushId);
}));
pushesRouter.post('/:projectId/:pushId/restore', validate({ params: pushParams }), send(async (req, res) => {
  const { workspaceId, projectId, pushId } = validParams(res, pushParams);
  return contributions.restorePush(requireAuth(req), workspaceId, projectId, pushId);
}));

export const pushPrefsRouter: Router = Router();
pushPrefsRouter.use(authenticate);
const prefsBody = z.strictObject({ autoPush: z.boolean() });
pushPrefsRouter.put('/', validate({ body: prefsBody }), send(async (req) => contributions.setAutoPush(requireAuth(req), validBody(req, prefsBody).autoPush)));
