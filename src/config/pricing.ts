/**
 * Pricing model (super admin editable, platform_settings key "pricing").
 *
 * Selling price comes from the token economy: a step is charged
 * `taskCosts[step]` tokens per unit, and a token sells for a package's
 * price ÷ tokens. Cost price is what the platform pays to deliver that
 * unit (AI APIs, compute, egress), entered here by the super admin. All
 * money is in the token currency's minor unit (kobo for NGN).
 */
import { z } from 'zod';
import { TASK_STEPS, type TaskStep } from './tokenSettings.js';

const money = z.number().int().min(0).max(100_000_000_000);

const monthlyCostSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,48}$/, { error: 'Cost ids are lowercase letters, digits and dashes' }),
  label: z.string().trim().min(2).max(60),
  amount: money,
});

export const pricingSchema = z.strictObject({
  /** Cost price per unit (per source minute or per reel), minor units. */
  stepCosts: z.strictObject(Object.fromEntries(TASK_STEPS.map((step) => [step, money])) as Record<TaskStep, typeof money>),
  /** Object storage, per GB per month, minor units. */
  storagePerGbMonth: money,
  /** Fixed running costs per month (servers, database, Redis, domains…). */
  monthlyCosts: z.array(monthlyCostSchema).max(24),
  /** Margin the "suggest" helper prices towards. */
  targetMarginPercent: z.number().int().min(0).max(95),
  /** The typical job used for blended cost per token. */
  referenceJob: z.strictObject({ minutes: z.number().int().min(1).max(600), reels: z.number().int().min(1).max(100) }),
});

export type PricingSettings = z.infer<typeof pricingSchema>;

export const DEFAULT_PRICING: PricingSettings = {
  stepCosts: { TRANSCRIPTION: 1_000, HOOK_DETECTION: 1_500, REFRAME: 500, CAPTIONS: 300, EXPORT: 800, AI_TITLES: 400 },
  storagePerGbMonth: 2_500,
  monthlyCosts: [
    { id: 'api-server', label: 'API & worker server', amount: 3_000_000 },
    { id: 'database', label: 'PostgreSQL', amount: 1_500_000 },
    { id: 'redis', label: 'Redis', amount: 800_000 },
    { id: 'domain-mail', label: 'Domain & mail', amount: 300_000 },
  ],
  targetMarginPercent: 60,
  referenceJob: { minutes: 10, reels: 5 },
};
