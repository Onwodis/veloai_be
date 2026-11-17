/**
 *   GET    /api/v1/public/privacy                       the privacy notice (versions, purposes, processing, rights)
 *
 *   GET    /api/v1/me/privacy                           my consents + my data requests
 *   PUT    /api/v1/me/privacy/consents/:purpose         grant / withdraw an optional consent
 *   POST   /api/v1/me/privacy/accept-policies           accept the current terms / privacy versions
 *   GET    /api/v1/me/privacy/history                   every consent change I made
 *   POST   /api/v1/me/privacy/requests                  make a data request (due in 30 days)
 *   POST   /api/v1/me/privacy/requests/:id/cancel       withdraw an open request
 *   GET    /api/v1/me/privacy/export                    download everything held about me (JSON)
 *
 *   GET    /api/v1/me/kyc                               my verification
 *   PUT    /api/v1/me/kyc/details                       level 1: legal name, country, phone
 *   POST   /api/v1/me/kyc/upload-url                    a signed upload URL for one document
 *   POST   /api/v1/me/kyc/identity                      level 2: ID + selfie (for review)
 *   POST   /api/v1/me/kyc/business                      level 3: business registration (for review)
 *
 *   GET    /api/v1/admin/kyc                            queue (by status) + counts          ADMIN
 *   GET    /api/v1/admin/kyc/settings                   level each action needs             ADMIN
 *   PUT    /api/v1/admin/kyc/settings                                                       SUPER_ADMIN
 *   GET    /api/v1/admin/kyc/:userId                    one case, with 5-minute document links
 *   POST   /api/v1/admin/kyc/:userId/decision           approve / reject
 *   GET    /api/v1/admin/data-requests                  the request queue + counts          ADMIN
 *   PUT    /api/v1/admin/data-requests/:id              progress / answer a request
 *   GET    /api/v1/admin/data-requests/:id/export       the user's export, for an ACCESS / EXPORT request
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { dataRequestLimiter, exportLimiter, kycLimiter } from '../middleware/rateLimit.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import { sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { requestMeta } from '../utils/request.js';
import * as kyc from './kyc.js';
import { POLICY_VERSIONS, PROCESSING, PURPOSES, RIGHTS } from './policy.js';
import * as privacy from './service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};

/** Data that must never sit in a shared cache. */
const noStore = (_req: Request, res: Response, next: () => void): void => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

const purpose = z.enum(['TERMS', 'PRIVACY', 'AGE', 'MARKETING', 'PRODUCT_RESEARCH', 'LIKENESS']);

// ── Public notice ──────────────────────────────────────────────────────────

export const publicPrivacyRouter: Router = Router();
publicPrivacyRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ versions: POLICY_VERSIONS, purposes: PURPOSES, processing: PROCESSING, rights: RIGHTS, responseDays: 30 });
});

// ── Me: privacy ────────────────────────────────────────────────────────────

export const myPrivacyRouter: Router = Router();
myPrivacyRouter.use(authenticate, noStore);

myPrivacyRouter.get('/', send(async (req) => {
  const { userId } = requireAuth(req);
  const [consents, requests] = await Promise.all([privacy.currentConsents(userId), privacy.myRequests(userId)]);
  return { consents, requests, versions: POLICY_VERSIONS };
}));

const consentParams = z.strictObject({ purpose });
const consentBody = z.strictObject({ granted: z.boolean() });
myPrivacyRouter.put('/consents/:purpose', validate({ params: consentParams, body: consentBody }), send(async (req, res) => ({
  consents: await privacy.setConsent(requireAuth(req).userId, validParams(res, consentParams).purpose, validBody(req, consentBody).granted, requestMeta(req)),
})));
myPrivacyRouter.post('/accept-policies', send(async (req) => ({ consents: await privacy.acceptCurrentPolicies(requireAuth(req).userId, requestMeta(req)) })));
myPrivacyRouter.get('/history', send(async (req) => ({ history: await privacy.consentHistory(requireAuth(req).userId) })));

const requestBody = z.strictObject({ type: z.enum(privacy.REQUEST_TYPES), details: z.string().max(2000).default('') });
myPrivacyRouter.post('/requests', dataRequestLimiter, validate({ body: requestBody }), send(async (req) => {
  const { type, details } = validBody(req, requestBody);
  return { request: await privacy.createRequest(requireAuth(req).userId, type, details) };
}));
const requestParams = z.strictObject({ id: z.uuid() });
myPrivacyRouter.post('/requests/:id/cancel', validate({ params: requestParams }), send(async (req, res) => ({
  request: await privacy.cancelRequest(requireAuth(req).userId, validParams(res, requestParams).id),
})));

myPrivacyRouter.get('/export', exportLimiter, async (req: Request, res: Response) => {
  const data = await privacy.exportData(requireAuth(req).userId);
  res.setHeader('Content-Disposition', `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
});

// ── Me: verification ───────────────────────────────────────────────────────

export const myKycRouter: Router = Router();
myKycRouter.use(authenticate, noStore);
myKycRouter.get('/', send(async (req) => ({ kyc: await kyc.myKyc(requireAuth(req).userId) })));
myKycRouter.put('/details', kycLimiter, validate({ body: kyc.detailsSchema }), send(async (req) => ({
  kyc: await kyc.saveDetails(requireAuth(req).userId, validBody(req, kyc.detailsSchema)),
})));
const uploadBody = z.strictObject({ slot: z.enum(kyc.DOC_SLOTS), contentType: z.string().max(60), size: z.number().int().positive() });
myKycRouter.post('/upload-url', kycLimiter, validate({ body: uploadBody }), send(async (req) => {
  const { slot, contentType, size } = validBody(req, uploadBody);
  return kyc.documentUploadUrl(requireAuth(req).userId, slot, contentType, size);
}));
myKycRouter.post('/identity', kycLimiter, validate({ body: kyc.identitySchema }), send(async (req) => ({
  kyc: await kyc.submitIdentity(requireAuth(req).userId, validBody(req, kyc.identitySchema)),
})));
myKycRouter.post('/business', kycLimiter, validate({ body: kyc.businessSchema }), send(async (req) => ({
  kyc: await kyc.submitBusiness(requireAuth(req).userId, validBody(req, kyc.businessSchema)),
})));

// ── Admin: verification queue ──────────────────────────────────────────────

export const adminKycRouter: Router = Router();
adminKycRouter.use(authenticate, authorize('ADMIN'), noStore);
const queueQuery = z.strictObject({ status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).default('PENDING') });
adminKycRouter.get('/', validate({ query: queueQuery }), send(async (_req, res) => kyc.reviewQueue(validQuery(res, queueQuery).status)));
adminKycRouter.get('/settings', send(async () => ({ settings: await kyc.getKycSettings() })));
adminKycRouter.put('/settings', authorize('SUPER_ADMIN'), validate({ body: kyc.kycSettingsSchema }), send(async (req) => ({
  settings: await kyc.saveKycSettings(validBody(req, kyc.kycSettingsSchema), requireAuth(req).userId),
})));
const caseParams = z.strictObject({ userId: z.uuid() });
adminKycRouter.get('/:userId', validate({ params: caseParams }), send(async (_req, res) => ({ case: await kyc.reviewCase(validParams(res, caseParams).userId) })));
adminKycRouter.post('/:userId/decision', validate({ params: caseParams, body: kyc.decisionSchema }), send(async (req, res) => ({
  case: await kyc.decide(requireAuth(req), validParams(res, caseParams).userId, validBody(req, kyc.decisionSchema)),
})));

// ── Admin: data requests ───────────────────────────────────────────────────

export const adminDataRequestsRouter: Router = Router();
adminDataRequestsRouter.use(authenticate, authorize('ADMIN'), noStore);
const requestsQuery = z.strictObject({ status: z.enum(privacy.REQUEST_STATUSES).optional(), type: z.enum(privacy.REQUEST_TYPES).optional() });
adminDataRequestsRouter.get('/', validate({ query: requestsQuery }), send(async (_req, res) => privacy.adminRequests(validQuery(res, requestsQuery))));
const updateBody = z.strictObject({ status: z.enum(privacy.REQUEST_STATUSES), response: z.string().trim().max(4000).optional() });
adminDataRequestsRouter.put('/:id', validate({ params: requestParams, body: updateBody }), send(async (req, res) => ({
  request: await privacy.updateRequest(requireAuth(req), validParams(res, requestParams).id, validBody(req, updateBody)),
})));
adminDataRequestsRouter.get('/:id/export', validate({ params: requestParams }), async (_req: Request, res: Response) => {
  const [request] = await sql<{ userId: string; type: string; status: string }[]>`SELECT user_id, type, status FROM data_requests WHERE id = ${validParams(res, requestParams).id}`;
  if (!request) throw AppError.notFound('Request');
  if (request.type !== 'ACCESS' && request.type !== 'EXPORT') throw AppError.badRequest('Exports are only for access and export requests.');
  if (request.status !== 'OPEN' && request.status !== 'IN_PROGRESS') throw AppError.conflict('This request is already closed.');
  const data = await privacy.exportData(request.userId);
  res.setHeader('Content-Disposition', `attachment; filename="data-request-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
});
