/**
 * Super admin command center: the business at a glance (one query batch).
 *
 *   people     signups, active users (from requests / visits), suspended
 *   money      cash collected (live Paystack), tokens bought vs used, holds
 *   AI studio  takes ready / failed / running, failure rate, estimated
 *              provider spend vs tokens charged (studio economics), photos
 *   support    open / urgent / waiting tickets
 *   series     per day: signups, active users, revenue, tokens used,
 *              takes ready / failed, estimated provider cost vs value charged
 *   lists      newest users, top spenders, latest payments, latest failures
 */
import { getPricing, getTokenSettings } from '../services/settings.service.js';
import { getEconomicsSettings } from '../studio/economics.js';
import { sql } from '../studio/sql.js';

const DAY = 86_400_000;

interface DayValue {
  day: string;
  value: number;
}

function fill(rows: DayValue[], from: Date, days: number): Map<string, number> {
  const map = new Map(rows.map((row) => [row.day, Number(row.value)]));
  const out = new Map<string, number>();
  for (let index = 0; index < days; index += 1) {
    const day = new Date(from.getTime() + index * DAY).toISOString().slice(0, 10);
    out.set(day, map.get(day) ?? 0);
  }
  return out;
}

export async function commandCenter(rangeDays: number) {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (rangeDays - 1)));
  const [tokens, economics, pricing] = await Promise.all([getTokenSettings(), getEconomicsSettings(), getPricing()]);
  const reference = tokens.packages.find((pkg) => pkg.highlighted) ?? tokens.packages[0]!;
  const pricePerToken = reference.price / reference.tokens;
  // Provider cost per READY take-second, using the video + lip-sync rates (keyframes are small).
  const videoCostPerSecond = Math.round(economics.providerUsd.videoPerSecond * economics.usdToMinor);

  const day = (column: string) => sql.unsafe(`to_char(date_trunc('day', ${column}), 'YYYY-MM-DD')`);
  const [
    [people],
    [money],
    [studio],
    [support],
    signups,
    active,
    revenue,
    used,
    takesReady,
    takesFailed,
    takeSeconds,
    newest,
    spenders,
    payments,
    failures,
    [storage],
    storageDays,
    storageTop,
  ] = await Promise.all([
    sql<{ total: number; newInRange: number; active24h: number; active7d: number; suspended: number; twoFactor: number }[]>`
      SELECT (SELECT count(*)::int FROM users) AS total,
        (SELECT count(*)::int FROM users WHERE created_at >= ${from}) AS new_in_range,
        (SELECT count(DISTINCT user_id)::int FROM activity_logs WHERE created_at > now() - interval '24 hours' AND user_id IS NOT NULL) AS active24h,
        (SELECT count(DISTINCT user_id)::int FROM activity_logs WHERE created_at > now() - interval '7 days' AND user_id IS NOT NULL) AS active7d,
        (SELECT count(*)::int FROM users WHERE suspended_at IS NOT NULL) AS suspended,
        (SELECT count(*)::int FROM users WHERE totp_enabled_at IS NOT NULL) AS two_factor`,
    sql<{ revenue: number; payments: number; tokensBought: number; tokensUsed: number; tokensHeld: number; tokensInWallets: number; granted: number }[]>`
      SELECT (SELECT COALESCE(sum(amount), 0)::float FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE' AND paid_at >= ${from}) AS revenue,
        (SELECT count(*)::int FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE' AND paid_at >= ${from}) AS payments,
        (SELECT COALESCE(sum(amount), 0)::int FROM token_ledger WHERE type = 'PURCHASE' AND created_at >= ${from}) AS tokens_bought,
        (SELECT COALESCE(sum(-amount), 0)::int FROM token_ledger WHERE type = 'USAGE' AND created_at >= ${from}) AS tokens_used,
        (SELECT COALESCE(sum(held), 0)::int FROM token_wallets) AS tokens_held,
        (SELECT COALESCE(sum(balance), 0)::int FROM token_wallets) AS tokens_in_wallets,
        (SELECT COALESCE(sum(amount), 0)::int FROM token_ledger WHERE type = 'GRANT' AND created_at >= ${from}) AS granted`,
    sql<{ ready: number; failed: number; running: number; canceled: number; seconds: number; tokens: number; photos: number; musicVideos: number; films: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'READY')::int AS ready,
        count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        count(*) FILTER (WHERE status IN ('QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING'))::int AS running,
        count(*) FILTER (WHERE status = 'CANCELED')::int AS canceled,
        COALESCE(sum(duration_sec) FILTER (WHERE status = 'READY'), 0)::float AS seconds,
        COALESCE(sum(cost) FILTER (WHERE status = 'READY'), 0)::int AS tokens,
        (SELECT count(*)::int FROM mv_character_photos WHERE status = 'READY' AND created_at >= ${from}) AS photos,
        (SELECT count(*)::int FROM studio_projects WHERE kind = 'MUSIC_VIDEO' AND created_at >= ${from}) AS music_videos,
        (SELECT count(*)::int FROM studio_projects WHERE status = 'READY' AND updated_at >= ${from}) AS films
      FROM studio_takes WHERE created_at >= ${from}`,
    sql<{ open: number; urgent: number; waiting: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'OPEN')::int AS open,
        count(*) FILTER (WHERE status IN ('OPEN', 'PENDING') AND priority IN ('HIGH', 'URGENT'))::int AS urgent,
        count(*) FILTER (WHERE status = 'OPEN' AND last_reply_by = 'USER')::int AS waiting
      FROM support_tickets`,
    sql<DayValue[]>`SELECT ${day('created_at')} AS day, count(*)::int AS value FROM users WHERE created_at >= ${from} GROUP BY 1`,
    sql<DayValue[]>`SELECT ${day('created_at')} AS day, count(DISTINCT user_id)::int AS value FROM activity_logs WHERE created_at >= ${from} AND user_id IS NOT NULL GROUP BY 1`,
    sql<DayValue[]>`SELECT ${day('paid_at')} AS day, sum(amount)::float AS value FROM payments WHERE status = 'SUCCESS' AND mode = 'LIVE' AND paid_at >= ${from} GROUP BY 1`,
    sql<DayValue[]>`SELECT ${day('created_at')} AS day, sum(-amount)::int AS value FROM token_ledger WHERE type = 'USAGE' AND created_at >= ${from} GROUP BY 1`,
    sql<DayValue[]>`SELECT ${day('created_at')} AS day, count(*)::int AS value FROM studio_takes WHERE status = 'READY' AND created_at >= ${from} GROUP BY 1`,
    sql<DayValue[]>`SELECT ${day('created_at')} AS day, count(*)::int AS value FROM studio_takes WHERE status = 'FAILED' AND created_at >= ${from} GROUP BY 1`,
    sql<DayValue[]>`SELECT ${day('created_at')} AS day, COALESCE(sum(duration_sec), 0)::float AS value FROM studio_takes WHERE status = 'READY' AND created_at >= ${from} GROUP BY 1`,
    sql<{ id: string; email: string; displayName: string; createdAt: Date; role: string }[]>`
      SELECT id, email, display_name, created_at, role::text FROM users ORDER BY created_at DESC LIMIT 8`,
    sql<{ userId: string; email: string; displayName: string; tokens: number }[]>`
      SELECT u.id AS user_id, u.email, u.display_name, sum(-l.amount)::int AS tokens
      FROM token_ledger l JOIN workspace_members m ON m.workspace_id = l.workspace_id AND m.role = 'OWNER' JOIN users u ON u.id = m.user_id
      WHERE l.type = 'USAGE' AND l.created_at >= ${from} GROUP BY u.id, u.email, u.display_name ORDER BY tokens DESC LIMIT 8`,
    sql<{ id: string; userId: string; email: string; amount: number; currency: string; tokens: number; status: string; mode: string; at: Date }[]>`
      SELECT p.id, p.user_id, u.email, p.amount::float AS amount, p.currency, p.tokens, p.status, p.mode, COALESCE(p.paid_at, p.created_at) AS at
      FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 8`,
    sql<{ id: string; kind: string; title: string; error: string | null; userId: string | null; email: string | null; at: Date }[]>`
      SELECT t.id, 'take' AS kind, p.title, t.error, p.created_by_id AS user_id, u.email, COALESCE(t.finished_at, t.created_at) AS at
      FROM studio_takes t JOIN studio_projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = p.created_by_id
      WHERE t.status = 'FAILED' ORDER BY t.created_at DESC LIMIT 8`,
    // Platform storage (every file we hold in R2, as recorded in the storage ledger).
    sql<{ bytes: number; objects: number; uploads: number; generated: number; users: number; addedInRange: number }[]>`
      SELECT COALESCE(sum(bytes), 0)::float AS bytes, count(*)::int AS objects,
        COALESCE(sum(bytes) FILTER (WHERE kind = 'UPLOAD'), 0)::float AS uploads,
        COALESCE(sum(bytes) FILTER (WHERE kind = 'GENERATED'), 0)::float AS generated,
        count(DISTINCT user_id)::int AS users,
        COALESCE(sum(bytes) FILTER (WHERE created_at >= ${from}), 0)::float AS added_in_range
      FROM storage_objects`,
    sql<DayValue[]>`SELECT ${day('created_at')} AS day, (sum(bytes) / 1048576.0)::float AS value FROM storage_objects WHERE created_at >= ${from} GROUP BY 1`,
    sql<{ userId: string; email: string; displayName: string; bytes: number }[]>`
      SELECT u.id AS user_id, u.email, u.display_name, sum(o.bytes)::float AS bytes
      FROM storage_objects o JOIN users u ON u.id = o.user_id GROUP BY u.id, u.email, u.display_name ORDER BY bytes DESC LIMIT 6`,
  ]);

  const days = (map: Map<string, number>) => [...map.keys()];
  const signupMap = fill(signups, from, rangeDays);
  const activeMap = fill(active, from, rangeDays);
  const revenueMap = fill(revenue, from, rangeDays);
  const usedMap = fill(used, from, rangeDays);
  const readyMap = fill(takesReady, from, rangeDays);
  const failedMap = fill(takesFailed, from, rangeDays);
  const secondsMap = fill(takeSeconds, from, rangeDays);
  const series = days(signupMap).map((key) => ({
    day: key,
    signups: signupMap.get(key) ?? 0,
    active: activeMap.get(key) ?? 0,
    revenue: Math.round((revenueMap.get(key) ?? 0) / 100),
    tokensUsed: usedMap.get(key) ?? 0,
    takesReady: readyMap.get(key) ?? 0,
    takesFailed: failedMap.get(key) ?? 0,
    // Estimated fal.ai spend for the video that was made vs the value of the tokens charged (major units).
    providerCost: Math.round(((secondsMap.get(key) ?? 0) * videoCostPerSecond) / 100),
    valueCharged: Math.round(((usedMap.get(key) ?? 0) * pricePerToken) / 100),
  }));

  const studioRow = studio!;
  const attempts = studioRow.ready + studioRow.failed;
  return {
    rangeDays,
    currency: tokens.currency,
    people: people!,
    money: { ...money!, valueUsed: Math.round(money!.tokensUsed * pricePerToken), pricePerToken },
    studio: {
      ...studioRow,
      failureRate: attempts ? Math.round((studioRow.failed / attempts) * 1000) / 10 : 0,
      estimatedProviderCost: Math.round(studioRow.seconds * videoCostPerSecond),
      tokensValue: Math.round(studioRow.tokens * pricePerToken),
    },
    support: support!,
    series,
    newest: newest.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    spenders,
    payments: payments.map((row) => ({ ...row, at: row.at.toISOString() })),
    failures: failures.map((row) => ({ ...row, at: row.at.toISOString() })),
    storage: {
      ...storage!,
      // What holding it costs per month (minor units), at the console's storage rate.
      monthlyCost: Math.round((storage!.bytes / 1024 ** 3) * pricing.storagePerGbMonth),
      // Megabytes added per day (files still held), for the growth chart.
      growth: (() => {
        const map = fill(storageDays, from, rangeDays);
        return [...map.entries()].map(([dayKey, value]) => ({ day: dayKey, megabytes: Math.round(value * 10) / 10 }));
      })(),
      top: storageTop,
    },
  };
}
