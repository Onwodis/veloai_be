/**
 * /api/v1/admin — super admin only.
 *
 *   GET    /sessions                    every active session (paginated, searchable)
 *   DELETE /sessions/:sessionId         revoke any session
 *   GET    /logs/activity               CRUD activity log (paginated, filterable)
 *   GET    /logs/security               security events (paginated, filterable)
 *   GET    /analytics?range=30          users, traffic, revenue, usage, storage, platform
 *   GET    /mail/smtp                   SMTP credentials + recent mail
 *   POST   /mail/smtp                   add a credential
 *   POST   /mail/smtp/verify-all        SMTP handshake on every credential
 *   POST   /mail/smtp/sync-env          re-read SMTP_* from .env, then handshake it
 *   DELETE /mail/smtp/:credentialId     remove a dashboard credential
 *   POST   /mail/smtp/:credentialId/verify    SMTP handshake (connect + TLS + auth)
 *   POST   /mail/smtp/:credentialId/activate  make it the sending account
 *   POST   /mail/test                   send a test email
 *
 * /api/v1/analytics/visit — public visit beacon (one per device per day).
 */
import { Router } from 'express';
import * as admin from '../controllers/admin.controller.js';
import { authenticate, optionalAuthenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { visitLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import {
  activityQuerySchema,
  analyticsQuerySchema,
  credentialParamsSchema,
  familyParamsSchema,
  securityQuerySchema,
  sessionsQuerySchema,
  smtpCredentialSchema,
  testMailSchema,
  visitSchema,
} from '../models/admin.schemas.js';

export const analyticsRouter: Router = Router();
analyticsRouter.post('/visit', visitLimiter, optionalAuthenticate, validate({ body: visitSchema }), admin.visit);

export const adminRouter: Router = Router();
adminRouter.use(authenticate, authorize('SUPER_ADMIN'));

adminRouter.get('/sessions', validate({ query: sessionsQuerySchema }), admin.sessions);
adminRouter.delete('/sessions/:sessionId', validate({ params: familyParamsSchema }), admin.revokeSession);
adminRouter.get('/logs/activity', validate({ query: activityQuerySchema }), admin.activity);
adminRouter.get('/logs/security', validate({ query: securityQuerySchema }), admin.securityEvents);
adminRouter.get('/analytics', validate({ query: analyticsQuerySchema }), admin.analytics);

adminRouter.get('/mail/smtp', admin.listSmtp);
adminRouter.post('/mail/smtp', validate({ body: smtpCredentialSchema }), admin.createSmtp);
adminRouter.post('/mail/smtp/verify-all', admin.verifyAllSmtp);
adminRouter.post('/mail/smtp/sync-env', admin.syncEnvSmtp);
adminRouter.delete('/mail/smtp/:credentialId', validate({ params: credentialParamsSchema }), admin.deleteSmtp);
adminRouter.post('/mail/smtp/:credentialId/verify', validate({ params: credentialParamsSchema }), admin.verifySmtp);
adminRouter.post('/mail/smtp/:credentialId/activate', validate({ params: credentialParamsSchema }), admin.activateSmtp);
adminRouter.post('/mail/test', validate({ body: testMailSchema }), admin.testSmtp);
