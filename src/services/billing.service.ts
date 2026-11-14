/**
 * Workspace billing: subscription state, metered usage and invoices.
 *
 * Every workspace has exactly one subscription row, created lazily on FREE.
 * Billing periods roll forward lazily on read: when a period has ended the
 * next one starts, and a pending cancellation drops the plan to FREE.
 *
 * Paid checkout needs an online payment provider (env BILLING_PROVIDER).
 * Until one is configured, owners can view everything, schedule a downgrade
 * and resume; paid upgrades answer PAYMENTS_UNAVAILABLE. Platform admins can
 * assign any plan directly (comped accounts, support fixes).
 */
import type { BillingInterval, PlanId, Subscription, UsageMetric } from '@prisma/client';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { BILLING_CURRENCY, PLAN_ORDER, PLANS, type Plan, type PlanLimits } from '../config/plans.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { isPlatformAdmin } from '../models/user.model.js';
import type { ChangePlanInput } from '../models/billing.schemas.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { requireMembership } from './workspace.service.js';

export const paymentsEnabled = (): boolean => env.BILLING_PROVIDER !== 'none';

/* ------------------------------------------------------------------ types */

export interface PublicPlan extends Plan {
  /** Yearly price expressed per month, for "billed annually" display. */
  yearlyMonthlyEquivalent: number;
}

export interface UsageLine {
  key: keyof PlanLimits;
  label: string;
  unit: string;
  used: number;
  limit: number | null;
}

export interface PublicSubscription {
  plan: PlanId;
  interval: BillingInterval;
  status: Subscription['status'];
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  managedBy: 'provider' | 'admin' | null;
}

export interface PublicInvoice {
  id: string;
  number: string;
  status: string;
  plan: PlanId;
  interval: BillingInterval;
  currency: string;
  total: number;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  paidAt: string | null;
  hostedUrl: string | null;
}

export interface BillingOverview {
  workspaceId: string;
  currency: string;
  paymentsEnabled: boolean;
  canManage: boolean;
  subscription: PublicSubscription;
  usage: UsageLine[];
  invoices: PublicInvoice[];
}

/* ------------------------------------------------------------------ plans */

export function listPlans(): { currency: string; plans: PublicPlan[] } {
  return {
    currency: BILLING_CURRENCY,
    plans: PLAN_ORDER.map((id) => {
      const plan = PLANS[id];
      return { ...plan, yearlyMonthlyEquivalent: Math.round(plan.prices.YEAR / 12) };
    }),
  };
}

/* ------------------------------------------------------------------ periods */

function addInterval(from: Date, interval: BillingInterval): Date {
  const next = new Date(from);
  if (interval === 'YEAR') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/** Loads the subscription, creating it on FREE and rolling expired periods forward. */
export async function currentSubscription(workspaceId: string): Promise<Subscription> {
  const now = new Date();
  let sub = await prisma.subscription.findUnique({ where: { workspaceId } });

  if (!sub) {
    sub = await prisma.subscription.upsert({
      where: { workspaceId },
      update: {},
      create: { workspaceId, currentPeriodStart: now, currentPeriodEnd: addInterval(now, 'MONTH') },
    });
  }

  if (sub.currentPeriodEnd > now) return sub;

  const downgrade = sub.cancelAtPeriodEnd;
  const interval: BillingInterval = downgrade ? 'MONTH' : sub.interval;
  let start = sub.currentPeriodEnd;
  let end = addInterval(start, interval);
  while (end <= now) {
    start = end;
    end = addInterval(start, interval);
  }

  return prisma.subscription.update({
    where: { workspaceId },
    data: {
      currentPeriodStart: start,
      currentPeriodEnd: end,
      ...(downgrade
        ? { plan: 'FREE', interval: 'MONTH', status: 'ACTIVE', cancelAtPeriodEnd: false, provider: null, providerSubscriptionId: null }
        : {}),
    },
  });
}

function toPublicSubscription(sub: Subscription): PublicSubscription {
  return {
    plan: sub.plan,
    interval: sub.interval,
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    managedBy: sub.provider === 'admin' ? 'admin' : sub.provider ? 'provider' : null,
  };
}

/* ------------------------------------------------------------------ usage */

const METERS: ReadonlyArray<{ key: keyof PlanLimits; metric: UsageMetric | null; label: string; unit: string }> = [
  { key: 'processingMinutes', metric: 'PROCESSING_MINUTES', label: 'Processing time', unit: 'min' },
  { key: 'reelsExported', metric: 'REELS_EXPORTED', label: 'Reel exports', unit: 'reels' },
  { key: 'storageMb', metric: 'STORAGE_MB', label: 'Storage', unit: 'MB' },
  { key: 'seats', metric: null, label: 'Seats', unit: 'members' },
];

async function usageFor(workspaceId: string, sub: Subscription): Promise<UsageLine[]> {
  const [counters, seats] = await Promise.all([
    prisma.usageCounter.findMany({
      where: { workspaceId, periodStart: sub.currentPeriodStart },
      select: { metric: true, quantity: true },
    }),
    prisma.workspaceMember.count({ where: { workspaceId } }),
  ]);
  const byMetric = new Map(counters.map((row) => [row.metric, row.quantity]));
  const limits = PLANS[sub.plan].limits;

  return METERS.map((meter) => ({
    key: meter.key,
    label: meter.label,
    unit: meter.unit,
    used: meter.metric ? (byMetric.get(meter.metric) ?? 0) : seats,
    limit: limits[meter.key],
  }));
}

/* ------------------------------------------------------------------ overview */

export async function getBillingOverview(auth: AuthContext, workspaceId: string): Promise<BillingOverview> {
  const role = isPlatformAdmin(auth.role) ? 'OWNER' : await requireMembership(auth.userId, workspaceId);
  const sub = await currentSubscription(workspaceId);

  const [usage, invoices] = await Promise.all([
    usageFor(workspaceId, sub),
    prisma.invoice.findMany({ where: { workspaceId }, orderBy: { issuedAt: 'desc' }, take: 24 }),
  ]);

  return {
    workspaceId,
    currency: BILLING_CURRENCY,
    paymentsEnabled: paymentsEnabled(),
    canManage: role === 'OWNER',
    subscription: toPublicSubscription(sub),
    usage,
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      plan: invoice.plan,
      interval: invoice.interval,
      currency: invoice.currency,
      total: invoice.total,
      periodStart: invoice.periodStart.toISOString(),
      periodEnd: invoice.periodEnd.toISOString(),
      issuedAt: invoice.issuedAt.toISOString(),
      paidAt: invoice.paidAt?.toISOString() ?? null,
      hostedUrl: invoice.hostedUrl,
    })),
  };
}

/* ------------------------------------------------------------------ changes */

async function assertSeatsFit(workspaceId: string, plan: PlanId): Promise<void> {
  const seatLimit = PLANS[plan].limits.seats;
  if (seatLimit === null) return;
  const members = await prisma.workspaceMember.count({ where: { workspaceId } });
  if (members > seatLimit) {
    throw AppError.badRequest(
      `${PLANS[plan].name} allows ${seatLimit} seat${seatLimit === 1 ? '' : 's'}; this workspace has ${members} members. Remove members first.`,
    );
  }
}

export async function changePlan(auth: AuthContext, workspaceId: string, input: ChangePlanInput): Promise<BillingOverview> {
  const asAdmin = isPlatformAdmin(auth.role);
  if (!asAdmin) await requireMembership(auth.userId, workspaceId, ['OWNER']);

  const sub = await currentSubscription(workspaceId);
  const samePlan = sub.plan === input.plan && (input.plan === 'FREE' || sub.interval === input.interval);

  if (samePlan && !sub.cancelAtPeriodEnd) {
    throw AppError.conflict(`This workspace is already on ${PLANS[input.plan].name}`);
  }

  if (samePlan && sub.cancelAtPeriodEnd) {
    // Choosing the current plan again undoes a scheduled downgrade.
    return resumeSubscription(auth, workspaceId);
  }

  if (input.plan === 'FREE' && !asAdmin) {
    // Paid time already bought runs to the end of the period.
    await assertSeatsFit(workspaceId, 'FREE');
    await prisma.subscription.update({ where: { workspaceId }, data: { cancelAtPeriodEnd: true } });
    logger.info({ workspaceId, userId: auth.userId, from: sub.plan }, 'billing: downgrade to FREE scheduled');
    return getBillingOverview(auth, workspaceId);
  }

  if (!asAdmin && !paymentsEnabled()) {
    throw new AppError(
      503,
      'PAYMENTS_UNAVAILABLE',
      'Online payments are not enabled yet. Contact support to change your plan.',
    );
  }

  if (!asAdmin) {
    // Provider checkout is created here once BILLING_PROVIDER supports one.
    throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Checkout is not available for the configured payment provider.');
  }

  await assertSeatsFit(workspaceId, input.plan);
  const now = new Date();
  await prisma.subscription.update({
    where: { workspaceId },
    data: {
      plan: input.plan,
      interval: input.plan === 'FREE' ? 'MONTH' : input.interval,
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
      currentPeriodStart: now,
      currentPeriodEnd: addInterval(now, input.plan === 'FREE' ? 'MONTH' : input.interval),
      provider: input.plan === 'FREE' ? null : 'admin',
      providerSubscriptionId: null,
    },
  });
  logger.info({ workspaceId, adminId: auth.userId, from: sub.plan, to: input.plan }, 'billing: plan assigned by admin');
  return getBillingOverview(auth, workspaceId);
}

export async function resumeSubscription(auth: AuthContext, workspaceId: string): Promise<BillingOverview> {
  if (!isPlatformAdmin(auth.role)) await requireMembership(auth.userId, workspaceId, ['OWNER']);
  const sub = await currentSubscription(workspaceId);
  if (!sub.cancelAtPeriodEnd) throw AppError.badRequest('There is no scheduled cancellation to undo');
  await prisma.subscription.update({ where: { workspaceId }, data: { cancelAtPeriodEnd: false } });
  logger.info({ workspaceId, userId: auth.userId }, 'billing: scheduled downgrade cancelled');
  return getBillingOverview(auth, workspaceId);
}
