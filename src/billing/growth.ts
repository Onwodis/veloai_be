/**
 * Growth advisor (super admin): the platform's real numbers that the marketing strategies on
 * /dashboard/admin/growth are projected from. Where there is no history yet (no paying users),
 * the page falls back to stated industry assumptions and says so.
 */
import { sql } from '../studio/sql.js';
import { getTokenSettings } from '../services/settings.service.js';
import { getYoutubeSettings } from '../youtube/settings.js';
import { pricingAudit } from './pricingAudit.js';

export async function growthBaseline() {
  const [tokens, youtube, audit] = await Promise.all([getTokenSettings(), getYoutubeSettings(), pricingAudit()]);
  const [row] = await sql<{
    users: number;
    signups30: number;
    payers: number;
    payers30: number;
    revenue30: number;
    revenueAll: number;
    purchases: number;
    activeWorkspaces30: number;
    tokensUsed30: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM users WHERE role <> 'SUPER_ADMIN' AND deleted_at IS NULL) AS users,
      (SELECT count(*)::int FROM users WHERE role <> 'SUPER_ADMIN' AND created_at > now() - interval '30 days') AS signups30,
      (SELECT count(DISTINCT user_id)::int FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE') AS payers,
      (SELECT count(DISTINCT user_id)::int FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE' AND created_at > now() - interval '30 days') AS payers30,
      (SELECT COALESCE(sum(amount), 0)::float FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE' AND created_at > now() - interval '30 days') AS revenue30,
      (SELECT COALESCE(sum(amount), 0)::float FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE') AS revenue_all,
      (SELECT count(*)::int FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE') AS purchases,
      (SELECT count(DISTINCT workspace_id)::int FROM token_ledger WHERE type = 'USAGE' AND created_at > now() - interval '30 days') AS active_workspaces30,
      (SELECT COALESCE(sum(-amount), 0)::int FROM token_ledger WHERE type = 'USAGE' AND created_at > now() - interval '30 days') AS tokens_used30`;
  const stats = row!;
  // Blended gross margin of what is actually sold: the median of the AI steps at the cheapest token.
  const margins = audit.steps.map((step) => step.margin ?? 0).sort((a, b) => a - b);
  const medianMargin = margins.length ? margins[Math.floor(margins.length / 2)]! : 50;
  const reference = tokens.packages.find((pkg) => pkg.highlighted) ?? tokens.packages[0]!;
  return {
    currency: tokens.currency,
    real: {
      users: stats.users,
      signups30: stats.signups30,
      payers: stats.payers,
      payers30: stats.payers30,
      /** naira */
      revenue30: Math.round(stats.revenue30 / 100),
      revenueAll: Math.round(stats.revenueAll / 100),
      averagePurchase: stats.purchases ? Math.round(stats.revenueAll / stats.purchases / 100) : null,
      conversion: stats.users ? Math.round((stats.payers / stats.users) * 1000) / 10 : null,
      activeWorkspaces30: stats.activeWorkspaces30,
      tokensUsed30: stats.tokensUsed30,
    },
    pricing: {
      packages: tokens.packages.map((pkg) => ({ name: pkg.name, tokens: pkg.tokens, naira: Math.round(pkg.price / 100) })),
      referencePackage: { name: reference.name, naira: Math.round(reference.price / 100), tokens: reference.tokens },
      youtubePer30: youtube.nairaPer30s,
      grossMargin: medianMargin,
      youtubeMargin: audit.youtube.margin,
    },
  };
}
