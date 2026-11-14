/**
 * Token + payment request contracts.
 */
import { z } from 'zod';
import { estimateInputSchema, tokenSettingsSchema } from '../config/tokenSettings.js';

export { estimateInputSchema };

export const tokenWorkspaceParamsSchema = z.strictObject({ workspaceId: z.uuid() });

export const reservationParamsSchema = z.strictObject({ workspaceId: z.uuid(), reservationId: z.uuid() });

export const reserveSchema = estimateInputSchema.extend({
  taskType: z
    .string()
    .trim()
    .regex(/^[A-Z_]{3,48}$/)
    .default('REEL_GENERATION'),
});

export const settleSchema = z.strictObject({ actualTokens: z.number().int().min(0).max(10_000_000) });

export const checkoutSchema = z.strictObject({ packageId: z.string().trim().min(2).max(48) });

export const referenceParamsSchema = z.strictObject({ reference: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });

export const tokenSettingsPatchSchema = tokenSettingsSchema.partial().strict();

export const grantSchema = z.strictObject({
  workspaceId: z.uuid(),
  amount: z
    .number()
    .int()
    .min(-10_000_000)
    .max(10_000_000)
    .refine((value) => value !== 0, { error: 'Amount cannot be zero' }),
  note: z.string().trim().min(3).max(200),
});

export const workspacesQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
});
