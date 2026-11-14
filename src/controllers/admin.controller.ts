/**
 * Super admin handlers: sessions, logs, analytics, mail settings; plus the
 * public visit beacon.
 */
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate.js';
import { validBody, validParams, validQuery } from '../middleware/validate.js';
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
import * as admin from '../services/admin.service.js';
import * as mail from '../services/mail/mail.service.js';
import { recordVisit } from '../services/visit.service.js';
import { AppError } from '../utils/AppError.js';
import { requestMeta } from '../utils/request.js';

/* ------------------------------------------------------------------ visits */

export async function visit(req: Request, res: Response): Promise<void> {
  const input = validBody(req, visitSchema);
  res.json(await recordVisit(input, requestMeta(req), req.auth?.userId ?? null));
}

/* ------------------------------------------------------------------ sessions + logs */

export async function sessions(_req: Request, res: Response): Promise<void> {
  res.json(await admin.listAllSessions(validQuery(res, sessionsQuerySchema)));
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const { sessionId } = validParams(res, familyParamsSchema);
  await admin.revokeAnySession(requireAuth(req).userId, sessionId, requestMeta(req));
  res.status(204).end();
}

export async function activity(_req: Request, res: Response): Promise<void> {
  res.json(await admin.listActivity(validQuery(res, activityQuerySchema)));
}

export async function securityEvents(_req: Request, res: Response): Promise<void> {
  res.json(await admin.listSecurityEvents(validQuery(res, securityQuerySchema)));
}

export async function analytics(_req: Request, res: Response): Promise<void> {
  const { range } = validQuery(res, analyticsQuerySchema);
  res.json(await admin.analytics(range));
}

/* ------------------------------------------------------------------ mail */

export async function listSmtp(_req: Request, res: Response): Promise<void> {
  const [credentials, recent] = await Promise.all([mail.listCredentials(), mail.recentMail()]);
  res.json({ credentials, recent });
}

export async function createSmtp(req: Request, res: Response): Promise<void> {
  const input = validBody(req, smtpCredentialSchema);
  res.status(201).json({ credential: await mail.createCredential(input, requireAuth(req).userId) });
}

export async function deleteSmtp(_req: Request, res: Response): Promise<void> {
  const { credentialId } = validParams(res, credentialParamsSchema);
  await mail.deleteCredential(credentialId);
  res.status(204).end();
}

export async function verifySmtp(_req: Request, res: Response): Promise<void> {
  const { credentialId } = validParams(res, credentialParamsSchema);
  res.json({ credential: await mail.verifyCredential(credentialId) });
}

export async function verifyAllSmtp(_req: Request, res: Response): Promise<void> {
  await mail.verifyAllCredentials();
  res.json({ credentials: await mail.listCredentials() });
}

export async function syncEnvSmtp(_req: Request, res: Response): Promise<void> {
  if (!mail.envSmtpConfigured()) {
    throw AppError.badRequest('SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM (or SMTP_FROM_EMAIL) must all be set in the API .env');
  }
  await mail.syncEnvCredential({ verify: false });
  const env = (await mail.listCredentials()).find((row) => row.source === 'ENV');
  res.json({ credential: env ? await mail.verifyCredential(env.id) : null });
}

export async function activateSmtp(_req: Request, res: Response): Promise<void> {
  const { credentialId } = validParams(res, credentialParamsSchema);
  res.json({ credentials: await mail.activateCredential(credentialId) });
}

export async function testSmtp(req: Request, res: Response): Promise<void> {
  const { to, credentialId } = validBody(req, testMailSchema);
  await mail.sendTestMail(to, credentialId);
  res.status(202).json({ ok: true });
}
