/**
 * Studio unit economics: what each AI step costs the platform (fal.ai, Claude,
 * compute) against what the user is charged for it in tokens.
 *
 *   cost / unit  = providerUsd[key] × usdToMinor           (minor units, e.g. kobo)
 *   sell / unit  = studio.costs[key] tokens × price per token
 *   price/token  = reference package price ÷ its tokens   (the highlighted package)
 *   suggested    = fewest tokens that still reach the target margin
 *
 * Provider prices change and models get swapped in the console, so the super
 * admin edits the USD table and the FX rate (platform_settings
 * "studio_economics"); "apply" writes the suggested token prices into the
 * studio settings so nothing is ever sold below cost.
 */
import { z } from 'zod';
import { getTokenSettings } from '../services/settings.service.js';
import { getStudioSettings, saveStudioSettings, type StudioSettings } from './settings.js';
import { json, sql } from './sql.js';

const SETTINGS_KEY = 'studio_economics';

export type CostKey = keyof StudioSettings['costs'];

/** What each studio cost is charged per, for labels. */
export const COST_UNIT: Record<CostKey, string> = {
  keyframe: 'keyframe image',
  videoPerSecond: 'second of video',
  lipSyncPerSecond: 'second of lip sync',
  upscalePerSecond: 'second upscaled',
  assemblyPerMinute: 'minute assembled',
  identity: 'identity profile',
  director: 'shot list',
  likenessAnalysis: 'likeness analysis',
  likenessTraining: 'likeness model training',
  image: 'image',
  imageEdit: 'image edit',
  imageUpscale: 'image upscale',
  mvCasting: 'casting sheet',
  mvScene: 'scene plan',
  mvChat: "director's room message",
  mvStoryboard: 'storyboard',
  mvLyricsPerMinute: 'minute of lyrics transcribed',
  mvMix: 'mix render',
  foleyPerSecond: 'second of foley',
  videoEditPerSecond: 'second of video edited',
  characterStill: 'character photo',
  ttsPerSecond: 'second of speech',
};

const usd = z.number().min(0).max(1000);

export const economicsSchema = z.strictObject({
  /** Minor units of the token currency per US dollar (₦1,550 = 155000 kobo). */
  usdToMinor: z.number().int().min(1).max(100_000_000),
  /** Margin the suggested prices aim for. */
  targetMarginPercent: z.number().int().min(0).max(95),
  /** What the provider charges per unit, in USD (edit when models or prices change). */
  providerUsd: z.strictObject(Object.fromEntries(Object.keys(COST_UNIT).map((key) => [key, usd])) as Record<CostKey, typeof usd>),
});
export type StudioEconomicsSettings = z.infer<typeof economicsSchema>;

/**
 * Defaults for the default models (fal.ai list prices, late 2026; Claude calls
 * at typical prompt sizes). Kling 2.1 Master is the expensive one: switching
 * the video model to a cheaper tier lowers videoPerSecond accordingly.
 */
export const DEFAULT_ECONOMICS: StudioEconomicsSettings = {
  usdToMinor: 155_000,
  targetMarginPercent: 60,
  providerUsd: {
    keyframe: 0.04,
    videoPerSecond: 0.28,
    lipSyncPerSecond: 0.05,
    upscalePerSecond: 0.08,
    assemblyPerMinute: 0.02,
    identity: 0.03,
    director: 0.03,
    likenessAnalysis: 0.05,
    likenessTraining: 2,
    image: 0.06,
    imageEdit: 0.04,
    imageUpscale: 0.03,
    mvCasting: 0.05,
    mvScene: 0.02,
    mvChat: 0.02,
    mvStoryboard: 0.08,
    mvLyricsPerMinute: 0.006,
    mvMix: 0.01,
    foleyPerSecond: 0.002,
    videoEditPerSecond: 0.168,
    characterStill: 0.04,
    // Multilingual TTS is billed per character (~15 characters a second of speech).
    ttsPerSecond: 0.0015,
  },
};

export async function getEconomicsSettings(): Promise<StudioEconomicsSettings> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = ${SETTINGS_KEY}`;
  const stored = (row?.value ?? {}) as Partial<StudioEconomicsSettings>;
  const parsed = economicsSchema.safeParse({ ...DEFAULT_ECONOMICS, ...stored, providerUsd: { ...DEFAULT_ECONOMICS.providerUsd, ...stored.providerUsd } });
  return parsed.success ? parsed.data : DEFAULT_ECONOMICS;
}

export async function saveEconomicsSettings(input: StudioEconomicsSettings, actorId: string): Promise<StudioEconomicsSettings> {
  const value = economicsSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at)
    VALUES (${SETTINGS_KEY}, ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  return value;
}

const marginOf = (sell: number, cost: number): number | null => (sell > 0 ? Math.round(((sell - cost) / sell) * 1000) / 10 : null);

export async function studioEconomics() {
  const [model, studio, tokens] = await Promise.all([getEconomicsSettings(), getStudioSettings(), getTokenSettings()]);
  const reference = tokens.packages.find((pkg) => pkg.highlighted) ?? tokens.packages[0]!;
  // The cheapest token anyone can buy sets the floor: price against the biggest pack too.
  const cheapest = tokens.packages.reduce((best, pkg) => (pkg.price / pkg.tokens < best.price / best.tokens ? pkg : best), reference);
  const pricePerToken = reference.price / reference.tokens;
  const floorPerToken = cheapest.price / cheapest.tokens;

  const lines = (Object.keys(COST_UNIT) as CostKey[]).map((key) => {
    const tokensCharged = studio.costs[key];
    const cost = Math.round(model.providerUsd[key] * model.usdToMinor);
    const sell = Math.round(tokensCharged * pricePerToken);
    const sellAtFloor = Math.round(tokensCharged * floorPerToken);
    const suggested = cost === 0 ? tokensCharged : Math.max(1, Math.ceil(cost / (floorPerToken * (1 - model.targetMarginPercent / 100))));
    return {
      key,
      unit: COST_UNIT[key],
      providerUsd: model.providerUsd[key],
      tokens: tokensCharged,
      cost,
      sell,
      marginPercent: marginOf(sell, cost),
      /** Margin when the user bought the cheapest-per-token pack. */
      floorMarginPercent: marginOf(sellAtFloor, cost),
      belowCost: sellAtFloor < cost,
      suggestedTokens: suggested,
    };
  });

  // A typical 5-second lip-synced music-video shot, end to end.
  const shot = { keyframe: 1, videoPerSecond: 5, lipSyncPerSecond: 5 } as const;
  const shotTokens = Object.entries(shot).reduce((sum, [key, units]) => sum + studio.costs[key as CostKey] * units, 0);
  const shotCost = Object.entries(shot).reduce((sum, [key, units]) => sum + Math.round(model.providerUsd[key as CostKey] * model.usdToMinor) * units, 0);

  return {
    currency: tokens.currency,
    model,
    reference: { id: reference.id, name: reference.name, pricePerToken, floorPackage: cheapest.name, floorPerToken },
    lines,
    belowCost: lines.filter((line) => line.belowCost).map((line) => line.key),
    sampleShot: { label: '5 s lip-synced shot (keyframe + video + lip sync)', tokens: shotTokens, sell: Math.round(shotTokens * pricePerToken), cost: shotCost, marginPercent: marginOf(Math.round(shotTokens * floorPerToken), shotCost) },
  };
}

/** Writes the suggested token price into every studio cost (or only those below cost). */
export async function applySuggestedPrices(actorId: string, onlyBelowCost: boolean) {
  const [economics, studio] = await Promise.all([studioEconomics(), getStudioSettings()]);
  const costs = { ...studio.costs };
  for (const line of economics.lines) {
    if (onlyBelowCost && !line.belowCost) continue;
    costs[line.key] = Math.min(100_000, line.suggestedTokens);
  }
  await saveStudioSettings({ ...studio, costs }, actorId);
  return studioEconomics();
}
