/**
 * Commercials studio API.
 *
 * /api/v1/workspaces/:workspaceId/companies
 *   GET    /                                          companies of the workspace
 *   POST   /                                          create a company (creator = OWNER)
 *   GET    /:companyId                                company + members + products
 *   PATCH  /:companyId                                edit details / brand kit
 *   DELETE /:companyId                                soft delete (its ads go to the bin)
 *   POST   /:companyId/members                        { email, role } add a workspace user
 *   DELETE /:companyId/members/:userId
 *   POST   /:companyId/products                       create a product
 *   GET    /:companyId/products/:productId            product + assets + its ads
 *   PATCH  /:companyId/products/:productId
 *   DELETE /:companyId/products/:productId
 *   POST   /:companyId/products/:productId/assets     { kind, fileName, contentType, size } → signed upload URL
 *   POST   /:companyId/products/:productId/assets/:assetId/complete
 *   DELETE /:companyId/products/:productId/assets/:assetId
 *   POST   /:companyId/products/:productId/ads        { title, aspect } new ad
 *
 * /api/v1/workspaces/:workspaceId/ads/:projectId
 *   GET    /                         the ad (stages, brief, cast, director's room, script)
 *   PUT    /brief                    objective, platform, length ≤ 60 s, goal, CTA, rules (+ cast on CHARACTERS)
 *   POST   /stages/:stage/approve    approve and move on
 *   POST   /stages/:stage/reopen
 *   POST   /messages                 { message, spoken } one director's-room turn (charged)
 *   POST   /script                   { notes? } the director writes the script (charged)
 *   PUT    /script                   the client's edits (free)
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import * as ads from './ads.js';
import * as companies from './companies.js';
import * as products from './products.js';
import { finishSchema } from '../studio/schemas.js';
import { projectVersion } from '../studio/version.js';
import { AD_STAGES, briefSchema, companySchema, createAdSchema, endCardSchema, memberSchema, productAssetSchema, productSchema, scriptRequestSchema, scriptSchema, versionsSchema } from './schemas.js';

const uuid = z.uuid();
const workspaceParams = z.strictObject({ workspaceId: uuid });
const companyParams = workspaceParams.extend({ companyId: uuid });
const memberParams = companyParams.extend({ userId: uuid });
const productParams = companyParams.extend({ productId: uuid });
const assetParams = productParams.extend({ assetId: uuid });
const adParams = workspaceParams.extend({ projectId: uuid });
const stageParams = adParams.extend({ stage: z.enum(AD_STAGES) });
const messageSchema = z.strictObject({ message: z.string().trim().min(1).max(2000), spoken: z.boolean().default(false) });

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};
const p = <S extends z.ZodType>(res: Response, schema: S) => validParams(res, schema);

/* ------------------------------------------------------------------ companies + products */

export const companyRouter: Router = Router({ mergeParams: true });
companyRouter.use(authenticate);

companyRouter.get('/', validate({ params: workspaceParams }), send(async (req, res) => ({ items: await companies.listCompanies(requireAuth(req), p(res, workspaceParams).workspaceId) })));
companyRouter.post('/', validate({ params: workspaceParams, body: companySchema }), send(async (req, res) => ({
  company: await companies.createCompany(requireAuth(req), p(res, workspaceParams).workspaceId, validBody(req, companySchema)),
})));
companyRouter.get('/:companyId', validate({ params: companyParams }), send(async (req, res) => {
  const { workspaceId, companyId } = p(res, companyParams);
  const auth = requireAuth(req);
  const company = await companies.companyAccess(auth, workspaceId, companyId, false);
  const [view, members, items] = await Promise.all([companies.companyView(company), companies.listMembers(auth, workspaceId, companyId), products.listProducts(auth, workspaceId, companyId)]);
  return { company: view, members, products: items };
}));
const companyPatch = companySchema.partial();
companyRouter.patch('/:companyId', validate({ params: companyParams, body: companyPatch }), send(async (req, res) => {
  const { workspaceId, companyId } = p(res, companyParams);
  return { company: await companies.updateCompany(requireAuth(req), workspaceId, companyId, validBody(req, companyPatch)) };
}));
companyRouter.delete('/:companyId', validate({ params: companyParams }), send(async (req, res) => {
  const { workspaceId, companyId } = p(res, companyParams);
  await companies.deleteCompany(requireAuth(req), workspaceId, companyId);
  return { ok: true };
}));
companyRouter.post('/:companyId/members', validate({ params: companyParams, body: memberSchema }), send(async (req, res) => {
  const { workspaceId, companyId } = p(res, companyParams);
  const body = validBody(req, memberSchema);
  return { members: await companies.addMember(requireAuth(req), workspaceId, companyId, body.email, body.role) };
}));
companyRouter.delete('/:companyId/members/:userId', validate({ params: memberParams }), send(async (req, res) => {
  const { workspaceId, companyId, userId } = p(res, memberParams);
  return { members: await companies.removeMember(requireAuth(req), workspaceId, companyId, userId) };
}));

companyRouter.post('/:companyId/products', validate({ params: companyParams, body: productSchema }), send(async (req, res) => {
  const { workspaceId, companyId } = p(res, companyParams);
  return { product: await products.createProduct(requireAuth(req), workspaceId, companyId, validBody(req, productSchema)) };
}));
companyRouter.get('/:companyId/products/:productId', validate({ params: productParams }), send(async (req, res) => {
  const { workspaceId, companyId, productId } = p(res, productParams);
  return { product: await products.getProduct(requireAuth(req), workspaceId, companyId, productId) };
}));
const productPatch = productSchema.partial();
companyRouter.patch('/:companyId/products/:productId', validate({ params: productParams, body: productPatch }), send(async (req, res) => {
  const { workspaceId, companyId, productId } = p(res, productParams);
  return { product: await products.updateProduct(requireAuth(req), workspaceId, companyId, productId, validBody(req, productPatch)) };
}));
companyRouter.delete('/:companyId/products/:productId', validate({ params: productParams }), send(async (req, res) => {
  const { workspaceId, companyId, productId } = p(res, productParams);
  await products.deleteProduct(requireAuth(req), workspaceId, companyId, productId);
  return { ok: true };
}));
companyRouter.post('/:companyId/products/:productId/assets', validate({ params: productParams, body: productAssetSchema }), send(async (req, res) => {
  const { workspaceId, companyId, productId } = p(res, productParams);
  return products.createProductAsset(requireAuth(req), workspaceId, companyId, productId, validBody(req, productAssetSchema));
}));
companyRouter.post('/:companyId/products/:productId/assets/:assetId/complete', validate({ params: assetParams }), send(async (req, res) => {
  const { workspaceId, companyId, productId, assetId } = p(res, assetParams);
  return { product: await products.completeProductAsset(requireAuth(req), workspaceId, companyId, productId, assetId) };
}));
companyRouter.delete('/:companyId/products/:productId/assets/:assetId', validate({ params: assetParams }), send(async (req, res) => {
  const { workspaceId, companyId, productId, assetId } = p(res, assetParams);
  return { product: await products.deleteProductAsset(requireAuth(req), workspaceId, companyId, productId, assetId) };
}));
companyRouter.post('/:companyId/products/:productId/ads', validate({ params: productParams, body: createAdSchema }), send(async (req, res) => {
  const { workspaceId, companyId, productId } = p(res, productParams);
  return { ad: await ads.createAd(requireAuth(req), workspaceId, companyId, productId, validBody(req, createAdSchema)) };
}));

/* ------------------------------------------------------------------ ads */

export const adRouter: Router = Router({ mergeParams: true });
adRouter.use(authenticate);

/** The change fingerprint: the ad page polls this and reloads only when it changes. */
adRouter.get('/:projectId/version', validate({ params: adParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  await companies.workspaceAccess(requireAuth(req), workspaceId, false);
  return { version: await projectVersion(workspaceId, projectId) };
}));
adRouter.get('/:projectId', validate({ params: adParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  return { ad: await ads.view(requireAuth(req), workspaceId, projectId) };
}));
adRouter.put('/:projectId/brief', validate({ params: adParams, body: briefSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  return { ad: await ads.updateBrief(requireAuth(req), workspaceId, projectId, validBody(req, briefSchema)) };
}));
adRouter.post('/:projectId/stages/:stage/approve', validate({ params: stageParams }), send(async (req, res) => {
  const { workspaceId, projectId, stage } = p(res, stageParams);
  return { ad: await ads.approveStage(requireAuth(req), workspaceId, projectId, stage) };
}));
adRouter.post('/:projectId/stages/:stage/reopen', validate({ params: stageParams }), send(async (req, res) => {
  const { workspaceId, projectId, stage } = p(res, stageParams);
  return { ad: await ads.reopenStage(requireAuth(req), workspaceId, projectId, stage) };
}));
adRouter.post('/:projectId/messages', validate({ params: adParams, body: messageSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  const body = validBody(req, messageSchema);
  const result = await ads.sendMessage(requireAuth(req), workspaceId, projectId, body.message, body.spoken);
  return { ad: result.project, reply: result.reply };
}));
adRouter.post('/:projectId/script', validate({ params: adParams, body: scriptRequestSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  return { ad: await ads.generateScript(requireAuth(req), workspaceId, projectId, validBody(req, scriptRequestSchema)?.notes) };
}));
adRouter.put('/:projectId/script', validate({ params: adParams, body: scriptSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  return { ad: await ads.saveScript(requireAuth(req), workspaceId, projectId, validBody(req, scriptSchema)) };
}));

/* Shoot: film a scene (dryRun = price), pick a take, record the spoken line. */
const sceneParams = adParams.extend({ sceneId: uuid });
const takeParams = sceneParams.extend({ takeId: uuid });
const dryRunSchema = z.strictObject({ dryRun: z.boolean().default(false) }).optional();
adRouter.post('/:projectId/scenes/:sceneId/shoot', validate({ params: sceneParams, body: dryRunSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return ads.shootScene(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, dryRunSchema)?.dryRun ?? false);
}));
adRouter.post('/:projectId/scenes/:sceneId/takes/:takeId/pick', validate({ params: takeParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId, takeId } = p(res, takeParams);
  return { ad: await ads.pickTake(requireAuth(req), workspaceId, projectId, sceneId, takeId) };
}));
adRouter.post('/:projectId/scenes/:sceneId/voice', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return ads.recordLine(requireAuth(req), workspaceId, projectId, sceneId);
}));

/* VeloBot's review of the ad takes: re-check a scene, keep a flagged take anyway. */
adRouter.post('/:projectId/scenes/:sceneId/review', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { ad: await ads.reviewAdScene(requireAuth(req), workspaceId, projectId, sceneId) };
}));
adRouter.post('/:projectId/scenes/:sceneId/takes/:takeId/keep', validate({ params: takeParams }), send(async (req, res) => {
  const { workspaceId, projectId, takeId } = p(res, takeParams);
  return { ad: await ads.keepAdTake(requireAuth(req), workspaceId, projectId, takeId) };
}));

/* End card (null = back to the defaults) and platform versions of the master. */
const endCardBody = z.strictObject({ endCard: endCardSchema.nullable() });
adRouter.put('/:projectId/end-card', validate({ params: adParams, body: endCardBody }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  return { ad: await ads.saveEndCard(requireAuth(req), workspaceId, projectId, validBody(req, endCardBody).endCard) };
}));
adRouter.post('/:projectId/versions', validate({ params: adParams, body: versionsSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  const body = validBody(req, versionsSchema);
  return { ad: await ads.makeVersions(requireAuth(req), workspaceId, projectId, body.aspects, body.fit) };
}));

/* Master: price (dryRun), start, pause / cancel. */
const adMasterSchema = z.strictObject({ finish: finishSchema.optional(), dryRun: z.boolean().default(false) });
adRouter.post('/:projectId/master', validate({ params: adParams, body: adMasterSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  const body = validBody(req, adMasterSchema);
  return ads.masterAd(requireAuth(req), workspaceId, projectId, body.finish, body.dryRun);
}));
const stopSchema = z.strictObject({ keep: z.boolean().default(true) }).optional();
adRouter.post('/:projectId/master/stop', validate({ params: adParams, body: stopSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, adParams);
  return { ad: await ads.stopAdMaster(requireAuth(req), workspaceId, projectId, validBody(req, stopSchema)?.keep ?? true) };
}));
