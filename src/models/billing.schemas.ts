/**
 * Billing request contracts.
 */
import { z } from 'zod';

export const workspaceParamsSchema = z.strictObject({
  workspaceId: z.uuid(),
});

export const changePlanSchema = z.strictObject({
  plan: z.enum(['FREE', 'CREATOR', 'STUDIO']),
  interval: z.enum(['MONTH', 'YEAR']).default('MONTH'),
});

export type ChangePlanInput = z.infer<typeof changePlanSchema>;
