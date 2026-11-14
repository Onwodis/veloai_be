/**
 * Plan catalogue: the single source of prices and limits.
 *
 * Amounts are in the currency's minor unit. `null` limits mean unlimited.
 * The frontend renders plans from GET /billing/plans, so changing a price or
 * limit here updates the pricing and billing pages with no frontend change.
 */
import type { BillingInterval, PlanId } from '@prisma/client';

export const BILLING_CURRENCY = 'USD';

export interface PlanLimits {
  processingMinutes: number | null;
  reelsExported: number | null;
  storageMb: number | null;
  seats: number | null;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  prices: Record<BillingInterval, number>;
  limits: PlanLimits;
  features: string[];
  highlighted: boolean;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = Object.freeze({
  FREE: {
    id: 'FREE',
    name: 'Free',
    tagline: 'Try the pipeline on your own footage.',
    prices: { MONTH: 0, YEAR: 0 },
    limits: { processingMinutes: 30, reelsExported: 10, storageMb: 2_048, seats: 1 },
    features: ['30 processing minutes / month', '10 reel exports / month', 'Animated captions', 'Watermarked exports'],
    highlighted: false,
  },
  CREATOR: {
    id: 'CREATOR',
    name: 'Creator',
    tagline: 'For solo creators publishing every day.',
    prices: { MONTH: 1_900, YEAR: 19_000 },
    limits: { processingMinutes: 300, reelsExported: null, storageMb: 51_200, seats: 3 },
    features: [
      '300 processing minutes / month',
      'Unlimited reel exports',
      'No watermark',
      'Hook detection + speaker tracking',
      'Brand partnership hub',
      'Up to 3 seats',
    ],
    highlighted: true,
  },
  STUDIO: {
    id: 'STUDIO',
    name: 'Studio',
    tagline: 'For teams, agencies and networks.',
    prices: { MONTH: 7_900, YEAR: 79_000 },
    limits: { processingMinutes: 1_500, reelsExported: null, storageMb: 512_000, seats: 15 },
    features: [
      '1,500 processing minutes / month',
      'Everything in Creator',
      'Up to 15 seats with roles',
      'Priority render queue',
      'API access',
      'Priority support',
    ],
    highlighted: false,
  },
});

export const PLAN_ORDER: readonly PlanId[] = ['FREE', 'CREATOR', 'STUDIO'];

export function planRank(plan: PlanId): number {
  return PLAN_ORDER.indexOf(plan);
}
