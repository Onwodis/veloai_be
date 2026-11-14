/**
 * Unit economics and profit for the super admin pricing page.
 *
 *   selling price / unit = tokens charged per unit × price per token
 *   cost price / unit    = pricing.stepCosts[step]
 *   price per token      = reference package price ÷ its tokens
 *                          (the highlighted package, else the first)
 *
 * Finance series per day:
 *   revenue       LIVE Paystack payments (cash collected)
 *   usage value   tokens consumed × reference price per token
 *   variable cost source minutes transcribed × per-minute step costs
 *                 + reels rendered × per-reel step costs
 *   fixed cost    monthly running costs ÷ 30
 *   storage cost  bytes held now × per-GB-month ÷ 30
 *   profit        revenue − all costs
 * All money is in minor units of the token currency.
 */
import { prisma } from '../config/database.js';
import type { PricingSettings } from '../config/pricing.js';
import { STEP_LABEL, STEP_UNIT, TASK_STEPS, type TaskStep, type TokenSettings } from '../config/tokenSettings.js';
import { getPricing, getTokenSettings } from './settings.service.js';

interface DayRow {
  day: Date;
  value: bigint | number | null;
}

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;

const margin = (sell: number, cost: number): number | null => (sell > 0 ? Math.round(((sell - cost) / sell) * 1000) / 10 : null);

function referencePackage(settings: TokenSettings): TokenSettings['packages'][number] {
  return settings.packages.find((pkg) => pkg.highlighted) ?? settings.packages[0]!;
}

function perUnitCost(pricing: PricingSettings, unit: 'minute' | 'reel'): number {
  return TASK_STEPS.filter((step) => STEP_UNIT[step] === unit).reduce((sum, step) => sum + pricing.stepCosts[step], 0);
}

export function unitEconomics(settings: TokenSettings, pricing: PricingSettings) {
  const ref = referencePackage(settings);
  const pricePerToken = ref.price / ref.tokens;

  const steps = TASK_STEPS.map((step: TaskStep) => {
    const tokens = settings.taskCosts[step];
    const sellPrice = Math.round(tokens * pricePerToken);
    const costPrice = pricing.stepCosts[step];
    // Fewest tokens per unit that still reach the target margin.
    const suggestedTokens = Math.max(1, Math.ceil(costPrice / (pricePerToken * (1 - pricing.targetMarginPercent / 100))));
    return {
      step,
      label: STEP_LABEL[step],
      unit: STEP_UNIT[step],
      tokens,
      sellPrice,
      costPrice,
      profit: sellPrice - costPrice,
      marginPercent: margin(sellPrice, costPrice),
      suggestedTokens,
    };
  });

  const { minutes, reels } = pricing.referenceJob;
  const jobTokens = steps.reduce((sum, line) => sum + line.tokens * (line.unit === 'minute' ? minutes : reels), 0);
  const jobCost = perUnitCost(pricing, 'minute') * minutes + perUnitCost(pricing, 'reel') * reels;
  const jobSell = Math.round(jobTokens * pricePerToken);
  const costPerToken = jobTokens > 0 ? jobCost / jobTokens : 0;

  const packages = settings.packages.map((pkg) => {
    const costOfTokens = Math.round(pkg.tokens * costPerToken);
    return {
      id: pkg.id,
      name: pkg.name,
      tokens: pkg.tokens,
      price: pkg.price,
      highlighted: pkg.highlighted,
      pricePerToken: pkg.price / pkg.tokens,
      costOfTokens,
      profit: pkg.price - costOfTokens,
      marginPercent: margin(pkg.price, costOfTokens),
    };
  });

  return {
    reference: { packageId: ref.id, packageName: ref.name, pricePerToken, costPerToken, marginPercent: margin(pricePerToken, costPerToken) },
    steps,
    packages,
    referenceJob: { minutes, reels, tokens: jobTokens, sellPrice: jobSell, costPrice: jobCost, profit: jobSell - jobCost, marginPercent: margin(jobSell, jobCost) },
  };
}

function fill(rows: DayRow[], from: Date, days: number): number[] {
  const byDay = new Map(rows.map((row) => [row.day.toISOString().slice(0, 10), Number(row.value ?? 0)]));
  return Array.from({ length: days }, (_, index) => byDay.get(new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10)) ?? 0);
}

export async function pricingOverview(rangeDays: number) {
  const [settings, pricing] = await Promise.all([getTokenSettings(), getPricing()]);
  const economics = unitEconomics(settings, pricing);

  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (rangeDays - 1)));
  const last30 = new Date(today.getTime() - 30 * DAY_MS);

  const [revenueRows, usageRows, minuteRows, reelRows, storedRows, soldRows, variable30Rows] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', paid_at)::date AS day, SUM(amount)::bigint AS value FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE' AND paid_at >= ${from} GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', created_at)::date AS day, SUM(-amount)::bigint AS value FROM token_ledger WHERE type = 'USAGE' AND created_at >= ${from} GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', finished_at)::date AS day, SUM(CEIL(duration_sec / 60.0))::bigint AS value FROM media_projects WHERE finished_at >= ${from} AND transcript IS NOT NULL AND duration_sec IS NOT NULL GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::bigint AS value FROM reels WHERE status = 'READY' AND created_at >= ${from} GROUP BY 1`,
    prisma.$queryRaw<Array<{ value: bigint | null }>>`SELECT (COALESCE((SELECT SUM(size_bytes) FROM reels), 0) + COALESCE((SELECT SUM(source_size) FROM media_projects WHERE status <> 'UPLOADING'), 0))::bigint AS value`,
    prisma.payment.aggregate({ where: { status: 'SUCCESS', mode: 'LIVE', paidAt: { gte: from } }, _sum: { amount: true, tokens: true } }),
    prisma.$queryRaw<Array<{ minutes: bigint | null; reels: bigint | null }>>`
      SELECT
        (SELECT SUM(CEIL(duration_sec / 60.0)) FROM media_projects WHERE finished_at >= ${last30} AND transcript IS NOT NULL AND duration_sec IS NOT NULL)::bigint AS minutes,
        (SELECT COUNT(*) FROM reels WHERE status = 'READY' AND created_at >= ${last30})::bigint AS reels`,
  ]);

  const minuteCost = perUnitCost(pricing, 'minute');
  const reelCost = perUnitCost(pricing, 'reel');
  const fixedMonthly = pricing.monthlyCosts.reduce((sum, cost) => sum + cost.amount, 0);
  const storedBytes = Number(storedRows[0]?.value ?? 0);
  const storageMonthly = Math.round((storedBytes / GB) * pricing.storagePerGbMonth);
  const variable30 = Number(variable30Rows[0]?.minutes ?? 0) * minuteCost + Number(variable30Rows[0]?.reels ?? 0) * reelCost;

  const revenue = fill(revenueRows, from, rangeDays);
  const usage = fill(usageRows, from, rangeDays);
  const minutes = fill(minuteRows, from, rangeDays);
  const reels = fill(reelRows, from, rangeDays);
  const fixedDaily = Math.round(fixedMonthly / 30);
  const storageDaily = Math.round(storageMonthly / 30);

  const series = revenue.map((cash, index) => {
    const variableCost = (minutes[index] ?? 0) * minuteCost + (reels[index] ?? 0) * reelCost;
    const cost = variableCost + fixedDaily + storageDaily;
    return {
      day: new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10),
      revenue: cash,
      usageValue: Math.round((usage[index] ?? 0) * economics.reference.pricePerToken),
      variableCost,
      cost,
      profit: cash - cost,
    };
  });

  const sum = (key: 'revenue' | 'usageValue' | 'variableCost' | 'cost' | 'profit'): number => series.reduce((total, point) => total + point[key], 0);
  const totalRevenue = sum('revenue');
  const totalCost = sum('cost');

  return {
    currency: settings.currency,
    pricing,
    tokenSettings: { taskCosts: settings.taskCosts, packages: settings.packages },
    ...economics,
    soldPricePerToken: soldRows._sum.tokens ? (soldRows._sum.amount ?? 0) / soldRows._sum.tokens : null,
    monthly: {
      fixed: fixedMonthly,
      storage: storageMonthly,
      storageGb: Math.round((storedBytes / GB) * 100) / 100,
      variableLast30Days: variable30,
      total: fixedMonthly + storageMonthly + variable30,
    },
    finance: {
      rangeDays,
      series,
      totals: {
        revenue: totalRevenue,
        usageValue: sum('usageValue'),
        variableCost: sum('variableCost'),
        fixedCost: fixedDaily * rangeDays,
        storageCost: storageDaily * rangeDays,
        cost: totalCost,
        profit: totalRevenue - totalCost,
        marginPercent: margin(totalRevenue, totalCost),
      },
    },
  };
}
