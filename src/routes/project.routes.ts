/**
 * /api/v1/workspaces/:workspaceId/projects
 *
 *   GET    /                         list projects (with reels)
 *   POST   /                         TOKEN GATE + start direct-to-R2 multipart upload
 *   GET    /:projectId               project detail (reels, engine log, transcript preview)
 *   POST   /:projectId/upload/complete   finish upload → queue processing
 *   POST   /:projectId/upload/abort      stop an upload, release tokens
 *   POST   /:projectId/cancel        stop processing (charges completed stages only)
 *   POST   /:projectId/retry         resume a failed/canceled project from its saved work
 *                                    ({ fresh: true } starts over); gated for what's left
 *   PATCH  /:projectId               edit title / directions / script / reels / length /
 *                                    framing / captions; regenerates what the change affects
 *   DELETE /:projectId               delete project + all its files
 *   PATCH  /:projectId/reels/:reelId edit one reel (caption/tags save; hook headline or
 *                                    trim re-renders only that reel)
 *   POST   /:projectId/reels/:reelId/variation  one click: { kind: 'hook' } rewrites the
 *                                    hook/title/caption from the cached transcript;
 *                                    { kind: 'style' } swaps to the next visual preset.
 *                                    Re-renders only that reel; charged for that reel only.
 *   DELETE /:projectId/reels/:reelId delete one reel
 *
 * /api/v1/admin/engines             super admin: engine status
 */
import { Router } from 'express';
import * as projects from '../controllers/project.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { completeUploadSchema, createProjectSchema, listProjectsQuery, projectParams, projectWorkspaceParams, reelParams, retryProjectSchema, updateProjectSchema, updateReelSchema, reelVariationSchema } from '../models/project.schemas.js';

export const projectRouter: Router = Router({ mergeParams: true });
projectRouter.use(authenticate);
projectRouter.get('/', validate({ params: projectWorkspaceParams, query: listProjectsQuery }), projects.list);
projectRouter.post('/', validate({ params: projectWorkspaceParams, body: createProjectSchema }), projects.create);
projectRouter.get('/:projectId', validate({ params: projectParams }), projects.detail);
projectRouter.post('/:projectId/upload/complete', validate({ params: projectParams, body: completeUploadSchema }), projects.complete);
projectRouter.post('/:projectId/upload/abort', validate({ params: projectParams }), projects.abort);
projectRouter.post('/:projectId/cancel', validate({ params: projectParams }), projects.cancel);
projectRouter.post('/:projectId/retry', validate({ params: projectParams, body: retryProjectSchema }), projects.retry);
projectRouter.patch('/:projectId', validate({ params: projectParams, body: updateProjectSchema }), projects.update);
projectRouter.delete('/:projectId', validate({ params: projectParams }), projects.remove);
projectRouter.patch('/:projectId/reels/:reelId', validate({ params: reelParams, body: updateReelSchema }), projects.updateReel);
projectRouter.post('/:projectId/reels/:reelId/variation', validate({ params: reelParams, body: reelVariationSchema }), projects.variation);
projectRouter.delete('/:projectId/reels/:reelId', validate({ params: reelParams }), projects.removeReel);

export const engineRouter: Router = Router();
engineRouter.get('/', authenticate, authorize('SUPER_ADMIN'), projects.engines);
