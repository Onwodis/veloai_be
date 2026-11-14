/**
 * Platform settings (platform_settings table), cached in-process for a few
 * seconds so hot paths (task gating) don't hit the database every call.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { DEFAULT_PRICING, pricingSchema, type PricingSettings } from '../config/pricing.js';
import { DEFAULT_TOKEN_SETTINGS, tokenSettingsSchema, type TokenSettings } from '../config/tokenSettings.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

const TOKEN_KEY = 'tokens';
const CACHE_MS = 10_000;

let cache: { value: TokenSettings; at: number } | null = null;

export async function getTokenSettings(): Promise<TokenSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await prisma.platformSetting.findUnique({ where: { key: TOKEN_KEY } });
  let value = DEFAULT_TOKEN_SETTINGS;
  if (row) {
    // Merge over defaults so settings saved by an older version stay valid.
    const parsed = tokenSettingsSchema.safeParse({ ...DEFAULT_TOKEN_SETTINGS, ...(row.value as object) });
    if (parsed.success) value = parsed.data;
    else logger.error({ issues: parsed.error.issues }, 'stored token settings are invalid; using defaults');
  }
  cache = { value, at: Date.now() };
  return value;
}

export async function updateTokenSettings(patch: Partial<TokenSettings>, actorId: string): Promise<TokenSettings> {
  const current = await getTokenSettings();
  const parsed = tokenSettingsSchema.safeParse({ ...current, ...patch });
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Token settings are invalid',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const ids = parsed.data.packages.map((pkg) => pkg.id);
  if (new Set(ids).size !== ids.length) throw AppError.badRequest('Package ids must be unique');

  await prisma.platformSetting.upsert({
    where: { key: TOKEN_KEY },
    update: { value: parsed.data as unknown as Prisma.InputJsonValue, updatedById: actorId },
    create: { key: TOKEN_KEY, value: parsed.data as unknown as Prisma.InputJsonValue, updatedById: actorId },
  });
  cache = { value: parsed.data, at: Date.now() };
  logger.info({ actorId, mode: parsed.data.paystackMode }, 'token settings updated');
  return parsed.data;
}

/* ------------------------------------------------------------------ pricing model */

const PRICING_KEY = 'pricing';
let pricingCache: { value: PricingSettings; at: number } | null = null;

export async function getPricing(): Promise<PricingSettings> {
  if (pricingCache && Date.now() - pricingCache.at < CACHE_MS) return pricingCache.value;
  const row = await prisma.platformSetting.findUnique({ where: { key: PRICING_KEY } });
  let value = DEFAULT_PRICING;
  if (row) {
    const parsed = pricingSchema.safeParse({ ...DEFAULT_PRICING, ...(row.value as object) });
    if (parsed.success) value = parsed.data;
    else logger.error({ issues: parsed.error.issues }, 'stored pricing settings are invalid; using defaults');
  }
  pricingCache = { value, at: Date.now() };
  return value;
}

export async function updatePricing(patch: Partial<PricingSettings>, actorId: string): Promise<PricingSettings> {
  const current = await getPricing();
  const parsed = pricingSchema.safeParse({ ...current, ...patch });
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Pricing settings are invalid',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const ids = parsed.data.monthlyCosts.map((cost) => cost.id);
  if (new Set(ids).size !== ids.length) throw AppError.badRequest('Running cost ids must be unique');

  await prisma.platformSetting.upsert({
    where: { key: PRICING_KEY },
    update: { value: parsed.data as unknown as Prisma.InputJsonValue, updatedById: actorId },
    create: { key: PRICING_KEY, value: parsed.data as unknown as Prisma.InputJsonValue, updatedById: actorId },
  });
  pricingCache = { value: parsed.data, at: Date.now() };
  logger.info({ actorId }, 'pricing settings updated');
  return parsed.data;
}
