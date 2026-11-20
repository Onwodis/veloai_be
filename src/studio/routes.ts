/**
 * /api/v1/workspaces/:workspaceId/studio
 *
 *   GET    /                               list studio projects
 *   POST   /                               create (AI_VIDEO | MUSIC_VIDEO)
 *   GET    /:projectId                     full project (assets, scenes, takes, output, rates)
 *   PATCH  /:projectId                     title / aspect / brief / finish
 *   DELETE /:projectId                     delete project + files
 *   POST   /:projectId/cancel              stop running takes / assembly
 *   POST   /:projectId/assets              start an upload → presigned PUT URL
 *   POST   /:projectId/assets/:assetId/complete
 *   PATCH  /:projectId/assets/:assetId     { subject, caption }
 *   DELETE /:projectId/assets/:assetId
 *   POST   /:projectId/identity            { consent: true } → Claude body-frame profile (token-gated)
 *   PATCH  /:projectId/identity            { profile } creator's corrections
 *   PUT    /:projectId/scenes              replace the shot list
 *   POST   /:projectId/direct              { mode: plan | refine } AI director (token-gated)
 *   POST   /:projectId/generate            { sceneIds, takes, dryRun } (token-gated)
 *   POST   /:projectId/takes/:takeId/select
 *   DELETE /:projectId/takes/:takeId
 *   POST   /:projectId/assemble            { finish, dryRun } (token-gated)
 *
 * /api/v1/admin/studio                    super admin: models, costs, limits, status
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import { clipEditsSchema } from './clipEdits.js';
import { applySuggestedPrices, economicsSchema, saveEconomicsSettings, studioEconomics } from './economics.js';
import { checkKey, falConfigured } from './fal.js';
import { studioQueueCounts, studioWorkerRunning } from './queue.js';
import {
  assembleSchema,
  assetParams,
  createAssetSchema,
  createStudioSchema,
  directSchema,
  generateSchema,
  listQuery,
  projectParams,
  scenesSchema,
  takeParams,
  updateAssetSchema,
  updateStudioSchema,
  workspaceParams,
  identitySchema,
} from './schemas.js';
import * as studio from './service.js';
import { getStudioSettings, saveStudioSettings, studioSettingsSchema } from './settings.js';
import { activeModels, getVideoModelSettings, JOB_LABEL, saveVideoModelSettings, useModel, VIDEO_JOBS, VIDEO_MODELS, videoModelAdvice, videoModelSettingsSchema } from './videoModels.js';
import { AppError } from '../utils/AppError.js';
import { sql } from './sql.js';

const profileSchema = z.strictObject({ profile: z.string().trim().min(10).max(3000) });

export const studioRouter: Router = Router({ mergeParams: true });
studioRouter.use(authenticate);

studioRouter.get('/', validate({ params: workspaceParams, query: listQuery }), async (req: Request, res: Response) => {
  const { workspaceId } = validParams(res, workspaceParams);
  const { page, pageSize } = validQuery(res, listQuery);
  res.json(await studio.listProjects(requireAuth(req), workspaceId, page, pageSize));
});

studioRouter.post('/', validate({ params: workspaceParams, body: createStudioSchema }), async (req: Request, res: Response) => {
  const { workspaceId } = validParams(res, workspaceParams);
  res.status(201).json({ project: await studio.createProject(requireAuth(req), workspaceId, validBody(req, createStudioSchema)) });
});

studioRouter.get('/:projectId', validate({ params: projectParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await studio.getProject(requireAuth(req), workspaceId, projectId) });
});

studioRouter.patch('/:projectId', validate({ params: projectParams, body: updateStudioSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await studio.updateProject(requireAuth(req), workspaceId, projectId, validBody(req, updateStudioSchema)) });
});

studioRouter.delete('/:projectId', validate({ params: projectParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  await studio.deleteProject(requireAuth(req), workspaceId, projectId);
  res.status(204).end();
});

studioRouter.post('/:projectId/cancel', validate({ params: projectParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await studio.cancel(requireAuth(req), workspaceId, projectId) });
});

studioRouter.post('/:projectId/assets', validate({ params: projectParams, body: createAssetSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.status(201).json(await studio.createAsset(requireAuth(req), workspaceId, projectId, validBody(req, createAssetSchema)));
});

studioRouter.post('/:projectId/assets/:assetId/complete', validate({ params: assetParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, assetId } = validParams(res, assetParams);
  res.json({ project: await studio.completeAsset(requireAuth(req), workspaceId, projectId, assetId) });
});

studioRouter.patch('/:projectId/assets/:assetId', validate({ params: assetParams, body: updateAssetSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, assetId } = validParams(res, assetParams);
  res.json({ project: await studio.updateAsset(requireAuth(req), workspaceId, projectId, assetId, validBody(req, updateAssetSchema)) });
});

studioRouter.delete('/:projectId/assets/:assetId', validate({ params: assetParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, assetId } = validParams(res, assetParams);
  res.json({ project: await studio.deleteAsset(requireAuth(req), workspaceId, projectId, assetId) });
});

studioRouter.post('/:projectId/identity', validate({ params: projectParams, body: identitySchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await studio.analyzeIdentity(requireAuth(req), workspaceId, projectId, req.ip ?? null) });
});

studioRouter.patch('/:projectId/identity', validate({ params: projectParams, body: profileSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await studio.updateIdentityProfile(requireAuth(req), workspaceId, projectId, validBody(req, profileSchema).profile) });
});

studioRouter.put('/:projectId/scenes', validate({ params: projectParams, body: scenesSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  res.json({ project: await studio.saveScenes(requireAuth(req), workspaceId, projectId, validBody(req, scenesSchema).scenes) });
});

studioRouter.post('/:projectId/direct', validate({ params: projectParams, body: directSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  const { mode, sceneCount } = validBody(req, directSchema);
  res.json({ project: await studio.direct(requireAuth(req), workspaceId, projectId, mode, sceneCount) });
});

studioRouter.post('/:projectId/generate', validate({ params: projectParams, body: generateSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  const { sceneIds, takes, dryRun } = validBody(req, generateSchema);
  res.json(await studio.generate(requireAuth(req), workspaceId, projectId, sceneIds, takes, dryRun));
});

studioRouter.post('/:projectId/takes/:takeId/select', validate({ params: takeParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, takeId } = validParams(res, takeParams);
  res.json({ project: await studio.selectTake(requireAuth(req), workspaceId, projectId, takeId) });
});

studioRouter.delete('/:projectId/takes/:takeId', validate({ params: takeParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, takeId } = validParams(res, takeParams);
  res.json({ project: await studio.deleteTake(requireAuth(req), workspaceId, projectId, takeId) });
});

studioRouter.post('/:projectId/assemble', validate({ params: projectParams, body: assembleSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = validParams(res, projectParams);
  const { finish, dryRun } = validBody(req, assembleSchema);
  res.json(await studio.assemble(requireAuth(req), workspaceId, projectId, finish, dryRun));
});

/* ------------------------------------------------------------------ super admin */

studioRouter.post('/:projectId/takes/:takeId/resume', validate({ params: takeParams }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, takeId } = validParams(res, takeParams);
  res.json({ project: await studio.resumeTake(requireAuth(req), workspaceId, projectId, takeId) });
});

const sceneEditParams = z.strictObject({ workspaceId: z.uuid(), projectId: z.uuid(), sceneId: z.uuid() });
/** CapCut-style clip edits for one scene (rendered when the film is assembled). */
studioRouter.put('/:projectId/scenes/:sceneId/edits', validate({ params: sceneEditParams, body: clipEditsSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, sceneId } = validParams(res, sceneEditParams);
  res.json({ project: await studio.setClipEdits(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, clipEditsSchema)) });
});

const postProcessSchema = z.strictObject({
  kind: z.enum(['remove-text', 'likeness', 'fix-artifacts', 'custom']),
  note: z.string().trim().max(1200).optional(),
  characterId: z.uuid().optional(),
  relipSync: z.boolean().optional(),
  dryRun: z.boolean().default(false),
});
/** Post-processing: a finished take → a new edited take (remove text, match a look, fix glitches, custom). */
studioRouter.post('/:projectId/takes/:takeId/post-process', validate({ params: takeParams, body: postProcessSchema }), async (req: Request, res: Response) => {
  const { workspaceId, projectId, takeId } = validParams(res, takeParams);
  res.json(await studio.postProcessTake(requireAuth(req), workspaceId, projectId, takeId, validBody(req, postProcessSchema)));
});

export const adminStudioRouter: Router = Router();

/* Bin (soft-deleted projects): super admin only (the router is guarded below). */
const binParams = z.strictObject({ projectId: z.uuid() });
adminStudioRouter.use(authenticate, authorize('SUPER_ADMIN'));

adminStudioRouter.get('/', async (_req: Request, res: Response) => {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [settings, queue, takes, projects] = await Promise.all([
    getStudioSettings(),
    studioQueueCounts().catch(() => null),
    sql<{ status: string; count: number; tokens: number; avgSeconds: number | null }[]>`
      SELECT status, count(*)::int AS count, COALESCE(sum(cost) FILTER (WHERE status = 'READY'), 0)::int AS tokens,
        avg(EXTRACT(EPOCH FROM (finished_at - created_at))) FILTER (WHERE status = 'READY')::float AS avg_seconds
      FROM studio_takes WHERE created_at >= ${since} GROUP BY status`.catch(() => []),
    sql<{ kind: string; status: string; count: number }[]>`
      SELECT kind, status, count(*)::int AS count FROM studio_projects WHERE created_at >= ${since} GROUP BY kind, status`.catch(() => []),
  ]);
  res.json({
    settings,
    falConfigured: falConfigured(),
    worker: { inline: env.MEDIA_WORKER_INLINE, running: studioWorkerRunning(), queue },
    last30Days: { takes, projects },
  });
});

adminStudioRouter.put('/', validate({ body: studioSettingsSchema }), async (req: Request, res: Response) => {
  res.json({ settings: await saveStudioSettings(validBody(req, studioSettingsSchema), requireAuth(req).userId) });
});

/* Video models: the catalog, which are switched on, what each job uses, measured performance and advice. */
async function videoModelsView(days: number) {
  const [settings, active, advice] = await Promise.all([getVideoModelSettings(), activeModels(), videoModelAdvice(days)]);
  return { catalog: VIDEO_MODELS, jobs: JOB_LABEL, settings, active, days, ...advice };
}
const videoModelsQuery = z.strictObject({ days: z.coerce.number().int().min(7).max(365).default(90) });
adminStudioRouter.get('/video-models', validate({ query: videoModelsQuery }), async (_req: Request, res: Response) => {
  res.json(await videoModelsView(validQuery(res, videoModelsQuery).days));
});
adminStudioRouter.put('/video-models', validate({ body: videoModelSettingsSchema }), async (req: Request, res: Response) => {
  try {
    const { moved } = await saveVideoModelSettings(validBody(req, videoModelSettingsSchema), requireAuth(req).userId);
    res.json({ ...(await videoModelsView(90)), moved });
  } catch (error) {
    throw AppError.badRequest(error instanceof Error ? error.message : 'Could not save.');
  }
});
const useModelBody = z.strictObject({ job: z.enum(VIDEO_JOBS), modelId: z.string().trim().min(1).max(60) });
adminStudioRouter.post('/video-models/use', validate({ body: useModelBody }), async (req: Request, res: Response) => {
  const body = validBody(req, useModelBody);
  try {
    await useModel(body.job, body.modelId, requireAuth(req).userId);
  } catch (error) {
    throw AppError.badRequest(error instanceof Error ? error.message : 'Could not switch the model.');
  }
  res.json(await videoModelsView(90));
});

adminStudioRouter.post('/check-key', async (_req: Request, res: Response) => {
  res.json(await checkKey());
});

/* Unit economics: provider cost vs token price for every studio step. */
adminStudioRouter.get('/economics', async (_req: Request, res: Response) => {
  res.json(await studioEconomics());
});
adminStudioRouter.put('/economics', validate({ body: economicsSchema }), async (req: Request, res: Response) => {
  await saveEconomicsSettings(validBody(req, economicsSchema), requireAuth(req).userId);
  res.json(await studioEconomics());
});
const applySchema = z.strictObject({ onlyBelowCost: z.boolean().default(false) });
adminStudioRouter.post('/economics/apply', validate({ body: applySchema }), async (req: Request, res: Response) => {
  res.json(await applySuggestedPrices(requireAuth(req).userId, validBody(req, applySchema).onlyBelowCost));
});

adminStudioRouter.get('/bin', async (_req: Request, res: Response) => {
  res.json({ items: await studio.listBin(), days: studio.BIN_DAYS });
});
adminStudioRouter.post('/bin/:projectId/restore', validate({ params: binParams }), async (_req: Request, res: Response) => {
  await studio.restoreProject(validParams(res, binParams).projectId);
  res.json({ items: await studio.listBin(), days: studio.BIN_DAYS });
});
adminStudioRouter.delete('/bin/:projectId', validate({ params: binParams }), async (_req: Request, res: Response) => {
  await studio.purgeProject(validParams(res, binParams).projectId);
  res.json({ items: await studio.listBin(), days: studio.BIN_DAYS });
});
