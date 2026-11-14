/**
 * Super admin views: every session, the CRUD activity log, the security
 * event log and platform analytics.
 */
import { Prisma, type ActivityAction, type UsageMetric } from '@prisma/client';
import { prisma } from '../config/database.js';
import { BILLING_CURRENCY, PLANS } from '../config/plans.js';
import { AppError } from '../utils/AppError.js';
import { recordSecurityEvent, type RequestMeta } from './securityEvent.service.js';
import { getTokenSettings } from './settings.service.js';
import type { Paginated } from './user.service.js';

const userBrief = { select: { id: true, email: true, displayName: true, role: true } } as const;

/* ------------------------------------------------------------------ sessions */

export interface AdminSession {
  id: string;
  user: { id: string; email: string; displayName: string; role: string };
  userAgent: string | null;
  ipAddress: string | null;
  lastActiveAt: string;
  expiresAt: string;
}

export async function listAllSessions(query: { page: number; pageSize: number; search?: string | undefined }): Promise<Paginated<AdminSession>> {
  const where: Prisma.RefreshTokenWhereInput = {
    revokedAt: null,
    replacedById: null,
    expiresAt: { gt: new Date() },
    ...(query.search
      ? {
          OR: [
            { user: { email: { contains: query.search, mode: 'insensitive' } } },
            { user: { displayName: { contains: query.search, mode: 'insensitive' } } },
            { ipAddress: { contains: query.search } },
          ],
        }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.refreshToken.count({ where }),
    prisma.refreshToken.findMany({
      where,
      include: { user: userBrief },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.familyId,
      user: row.user,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      lastActiveAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export async function revokeAnySession(actorId: string, familyId: string, meta: RequestMeta): Promise<void> {
  const head = await prisma.refreshToken.findFirst({ where: { familyId }, select: { userId: true } });
  if (!head) throw AppError.notFound('Session');
  const result = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'admin_revoked' },
  });
  if (result.count === 0) throw AppError.notFound('Session');
  await recordSecurityEvent('SESSION_REVOKED', meta, head.userId, { familyId, by: actorId });
}

/* ------------------------------------------------------------------ logs */

export interface LogQuery {
  page: number;
  pageSize: number;
  userId?: string | undefined;
  action?: ActivityAction | undefined;
  search?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export async function listActivity(query: LogQuery): Promise<Paginated<{
  id: string;
  action: ActivityAction;
  method: string;
  path: string;
  route: string | null;
  statusCode: number;
  durationMs: number;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  user: { id: string; email: string; displayName: string; role: string } | null;
}>> {
  const where: Prisma.ActivityLogWhereInput = {
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    ...(query.search
      ? {
          OR: [
            { path: { contains: query.search, mode: 'insensitive' } },
            { ipAddress: { contains: query.search } },
            { user: { email: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      include: { user: userBrief },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id.toString(),
      action: row.action,
      method: row.method,
      path: row.path,
      route: row.route,
      statusCode: row.statusCode,
      durationMs: row.durationMs,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      user: row.user,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export async function listSecurityEvents(query: Omit<LogQuery, 'action'> & { type?: string | undefined }): Promise<Paginated<{
  id: string;
  type: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
  user: { id: string; email: string; displayName: string; role: string } | null;
}>> {
  const where: Prisma.SecurityEventWhereInput = {
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.type ? { type: query.type as Prisma.SecurityEventWhereInput['type'] } : {}),
    ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    ...(query.search
      ? {
          OR: [
            { ipAddress: { contains: query.search } },
            { user: { email: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.securityEvent.count({ where }),
    prisma.securityEvent.findMany({
      where,
      include: { user: userBrief },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id.toString(),
      type: row.type,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
      user: row.user,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/* ------------------------------------------------------------------ analytics */

interface DayRow {
  day: Date;
  value: bigint | number | null;
}

function fillSeries(rows: DayRow[], from: Date, days: number): Array<{ day: string; value: number }> {
  const byDay = new Map(rows.map((row) => [row.day.toISOString().slice(0, 10), Number(row.value ?? 0)]));
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(from.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return { day, value: byDay.get(day) ?? 0 };
  });
}

const METRICS: UsageMetric[] = ['PROCESSING_MINUTES', 'REELS_EXPORTED', 'STORAGE_MB', 'AI_TOKENS', 'TRANSCRIPTION_SECONDS'];

export async function analytics(rangeDays: number) {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (rangeDays - 1)));

  const [
    usersTotal,
    usersNew,
    usersByRole,
    mfaEnrolled,
    workspaces,
    activeSessions,
    visitorRows,
    firstVisitRows,
    pageViewRows,
    signupRows,
    requestRows,
    revenueRows,
    actionRows,
    statusRows,
    topRoutes,
    subscriptions,
    paidInRange,
    usageCurrent,
    usageAllTime,
    storageRows,
    mailRows,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: from } } }),
    prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    prisma.user.count({ where: { totpEnabledAt: { not: null } } }),
    prisma.workspace.count(),
    prisma.refreshToken.count({ where: { revokedAt: null, replacedById: null, expiresAt: { gt: today } } }),
    prisma.$queryRaw<DayRow[]>`SELECT day, COUNT(*)::bigint AS value FROM site_visits WHERE day >= ${from} GROUP BY day ORDER BY day`,
    prisma.$queryRaw<DayRow[]>`SELECT day, COUNT(*)::bigint AS value FROM site_visits WHERE day >= ${from} AND first_visit GROUP BY day ORDER BY day`,
    prisma.$queryRaw<DayRow[]>`SELECT day, SUM(page_views)::bigint AS value FROM site_visits WHERE day >= ${from} GROUP BY day ORDER BY day`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::bigint AS value FROM users WHERE created_at >= ${from} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::bigint AS value FROM activity_logs WHERE created_at >= ${from} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', paid_at)::date AS day, SUM(total)::bigint AS value FROM invoices WHERE status = 'PAID' AND paid_at >= ${from} GROUP BY 1 ORDER BY 1`,
    prisma.activityLog.groupBy({ by: ['action'], where: { createdAt: { gte: from } }, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ bucket: string; value: bigint }>>`SELECT CASE WHEN status_code >= 500 THEN '5xx' WHEN status_code >= 400 THEN '4xx' ELSE 'ok' END AS bucket, COUNT(*)::bigint AS value FROM activity_logs WHERE created_at >= ${from} GROUP BY 1`,
    prisma.$queryRaw<Array<{ route: string; value: bigint; avg_ms: number }>>`SELECT COALESCE(route, path) AS route, COUNT(*)::bigint AS value, AVG(duration_ms)::float AS avg_ms FROM activity_logs WHERE created_at >= ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    prisma.subscription.findMany({ select: { plan: true, interval: true, status: true, cancelAtPeriodEnd: true } }),
    prisma.invoice.aggregate({ where: { status: 'PAID', paidAt: { gte: from } }, _sum: { total: true }, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ metric: UsageMetric; value: bigint }>>`
      SELECT u.metric, SUM(u.quantity)::bigint AS value
      FROM usage_counters u JOIN subscriptions s ON s.workspace_id = u.workspace_id AND s.current_period_start = u.period_start
      GROUP BY u.metric`,
    prisma.usageCounter.groupBy({ by: ['metric'], _sum: { quantity: true } }),
    // Storage is a gauge: take each workspace's latest reading.
    prisma.$queryRaw<Array<{ value: bigint | null }>>`
      SELECT SUM(quantity)::bigint AS value FROM (
        SELECT DISTINCT ON (workspace_id) quantity FROM usage_counters
        WHERE metric = 'STORAGE_MB' ORDER BY workspace_id, period_start DESC
      ) latest`,
    prisma.mailLog.groupBy({ by: ['status'], where: { createdAt: { gte: from } }, _count: { _all: true } }),
  ]);

  const [tokenPayments, tokenSalesRows, tokenUsageRows, tokenTotals, tokenSettings] = await Promise.all([
    prisma.payment.groupBy({ by: ['mode'], where: { status: 'SUCCESS', paidAt: { gte: from } }, _sum: { amount: true, tokens: true }, _count: { _all: true } }),
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', paid_at)::date AS day, SUM(amount)::bigint AS value FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE' AND paid_at >= ${from} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', created_at)::date AS day, SUM(-amount)::bigint AS value FROM token_ledger WHERE type = 'USAGE' AND created_at >= ${from} GROUP BY 1 ORDER BY 1`,
    prisma.tokenWallet.aggregate({ _sum: { balance: true, held: true, lifetimePurchased: true, lifetimeUsed: true } }),
    getTokenSettings(),
  ]);
  const live = tokenPayments.find((row) => row.mode === 'LIVE');
  const test = tokenPayments.find((row) => row.mode === 'TEST');

  const paid = subscriptions.filter((sub) => sub.plan !== 'FREE' && sub.status !== 'CANCELED');
  const mrr = paid.reduce(
    (sum, sub) => sum + (sub.interval === 'YEAR' ? Math.round(PLANS[sub.plan].prices.YEAR / 12) : PLANS[sub.plan].prices.MONTH),
    0,
  );
  const plans = (['FREE', 'CREATOR', 'STUDIO'] as const).map((plan) => ({
    plan,
    name: PLANS[plan].name,
    workspaces: plan === 'FREE' ? workspaces - paid.length : paid.filter((sub) => sub.plan === plan).length,
  }));

  const visitors = fillSeries(visitorRows, from, rangeDays);
  const firstVisits = fillSeries(firstVisitRows, from, rangeDays);
  const currentByMetric = new Map(usageCurrent.map((row) => [row.metric, Number(row.value)]));
  const allTimeByMetric = new Map(usageAllTime.map((row) => [row.metric, row._sum.quantity ?? 0]));

  return {
    rangeDays,
    from: from.toISOString(),
    currency: BILLING_CURRENCY,
    users: {
      total: usersTotal,
      newInRange: usersNew,
      mfaEnrolled,
      byRole: usersByRole.map((row) => ({ role: row.role, count: row._count._all })),
      signups: fillSeries(signupRows, from, rangeDays),
    },
    traffic: {
      uniqueVisitors: visitors.reduce((sum, point) => sum + point.value, 0),
      firstTimeVisitors: firstVisits.reduce((sum, point) => sum + point.value, 0),
      visitors,
      firstVisits,
      pageViews: fillSeries(pageViewRows, from, rangeDays),
    },
    revenue: {
      mrr,
      arr: mrr * 12,
      collectedInRange: paidInRange._sum.total ?? 0,
      paidInvoices: paidInRange._count._all,
      paidWorkspaces: paid.length,
      cancellingWorkspaces: paid.filter((sub) => sub.cancelAtPeriodEnd).length,
      series: fillSeries(revenueRows, from, rangeDays),
      plans,
    },
    usage: METRICS.map((metric) => ({
      metric,
      currentPeriod: currentByMetric.get(metric) ?? 0,
      allTime: allTimeByMetric.get(metric) ?? 0,
    })),
    storage: { totalMb: Number(storageRows[0]?.value ?? 0) },
    tokens: {
      currency: tokenSettings.currency,
      mode: tokenSettings.paystackMode,
      /** Real money: LIVE-mode Paystack payments only. */
      revenueInRange: live?._sum.amount ?? 0,
      soldInRange: live?._sum.tokens ?? 0,
      purchasesInRange: live?._count._all ?? 0,
      testPurchasesInRange: test?._count._all ?? 0,
      outstandingBalance: tokenTotals._sum.balance ?? 0,
      heldNow: tokenTotals._sum.held ?? 0,
      lifetimePurchased: tokenTotals._sum.lifetimePurchased ?? 0,
      lifetimeUsed: tokenTotals._sum.lifetimeUsed ?? 0,
      revenueSeries: fillSeries(tokenSalesRows, from, rangeDays),
      usageSeries: fillSeries(tokenUsageRows, from, rangeDays),
    },
    platform: {
      workspaces,
      activeSessions,
      requests: fillSeries(requestRows, from, rangeDays),
      byAction: actionRows.map((row) => ({ action: row.action, count: row._count._all })),
      byStatus: statusRows.map((row) => ({ bucket: row.bucket, count: Number(row.value) })),
      topRoutes: topRoutes.map((row) => ({ route: row.route, count: Number(row.value), avgMs: Math.round(row.avg_ms) })),
      mail: {
        sent: mailRows.find((row) => row.status === 'SENT')?._count._all ?? 0,
        failed: mailRows.find((row) => row.status === 'FAILED')?._count._all ?? 0,
      },
    },
  };
}
