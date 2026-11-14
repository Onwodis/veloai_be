/**
 * Super admin + analytics request contracts.
 */
import { z } from 'zod';

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);
const search = z.string().trim().max(120).optional();
const isoDate = z.coerce.date().optional();

export const sessionsQuerySchema = z.strictObject({ page, pageSize, search });

export const familyParamsSchema = z.strictObject({ sessionId: z.uuid() });

export const activityQuerySchema = z.strictObject({
  page,
  pageSize,
  search,
  userId: z.uuid().optional(),
  action: z.enum(['CREATE', 'READ', 'UPDATE', 'DELETE']).optional(),
  from: isoDate,
  to: isoDate,
});

export const securityQuerySchema = z.strictObject({
  page,
  pageSize,
  search,
  userId: z.uuid().optional(),
  type: z.string().regex(/^[A-Z_]{3,40}$/).optional(),
  from: isoDate,
  to: isoDate,
});

export const analyticsQuerySchema = z.strictObject({
  range: z.coerce.number().int().refine((value) => [7, 30, 90, 365].includes(value), { error: 'range must be 7, 30, 90 or 365' }).default(30),
});

export const visitSchema = z.strictObject({
  visitorId: z.uuid(),
  path: z.string().trim().min(1).max(512).regex(/^\//, { error: 'path must start with /' }),
  referrer: z.string().trim().max(512).optional(),
});

export const smtpCredentialSchema = z.strictObject({
  label: z.string().trim().min(2).max(80),
  host: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(/^[A-Za-z0-9.-]+$/, { error: 'Enter a hostname such as smtp.zoho.com' }),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(512),
  fromAddress: z.email().max(254),
  fromName: z.string().trim().min(1).max(80).optional(),
});

export const credentialParamsSchema = z.strictObject({ credentialId: z.uuid() });

export const testMailSchema = z.strictObject({
  to: z.email().max(254),
  credentialId: z.uuid().optional(),
});
