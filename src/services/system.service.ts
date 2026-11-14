/**
 * Super admin console: live system health and platform insights.
 *
 *   systemSnapshot()   process, database, Redis, media queue, scheduled jobs,
 *                      recent warnings/errors, request performance (24 h),
 *                      integrations (mail, Paystack, AI, storage)
 *   insights(range)    most active customers, assets generated
 *
 * Every probe is independent: one failing dependency marks itself down
 * instead of failing the whole snapshot.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'node:os';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { queueCounts, recentFailedJobs, workerRunning } from '../media/queue.js';
import { logCounts, recentLogs } from '../utils/logBuffer.js';
import { listJobs } from './jobs.service.js';
import { keyStatus, lastKeyChecks } from './paystack.service.js';
import { getTokenSettings } from './settings.service.js';
import { checkBucket } from './storage.service.js';

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ process sampling */

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

let cpuSample = { usage: process.cpuUsage(), at: process.hrtime.bigint() };

function cpuPercent(): number {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage(cpuSample.usage);
  const elapsedUs = Number(now - cpuSample.at) / 1000;
  cpuSample = { usage: process.cpuUsage(), at: now };
  if (elapsedUs <= 0) return 0;
  return Math.round(((usage.user + usage.system) / elapsedUs / os.cpus().length) * 1000) / 10;
}

async function timedProbe<T>(fn: () => Promise<T>): Promise<{ ok: boolean; latencyMs: number; value: T | null; error: string | null }> {
  const started = performance.now();
  try {
    const value = await fn();
    return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, value, error: null };
  } catch (error) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), value: null, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

/* ------------------------------------------------------------------ database */

async function databaseHealth() {
  const ping = await timedProbe(() => prisma.$queryRaw`SELECT 1`);
  if (!ping.ok) return { ok: false, latencyMs: ping.latencyMs, error: ping.error };

  const [info, tables] = await Promise.all([
    prisma.$queryRaw<Array<{ version: string; size: bigint; total: bigint; active: bigint; idle: bigint; max_conn: string; hit_ratio: number | null; deadlocks: bigint; commits: bigint; rollbacks: bigint }>>`
      SELECT
        split_part(version(), ' ', 2) AS version,
        pg_database_size(current_database())::bigint AS size,
        (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database())::bigint AS total,
        (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active')::bigint AS active,
        (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle')::bigint AS idle,
        current_setting('max_connections') AS max_conn,
        (SELECT ROUND(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2)::float FROM pg_stat_database WHERE datname = current_database()) AS hit_ratio,
        (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())::bigint AS deadlocks,
        (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database())::bigint AS commits,
        (SELECT xact_rollback FROM pg_stat_database WHERE datname = current_database())::bigint AS rollbacks`,
    prisma.$queryRaw<Array<{ name: string; rows: bigint; bytes: bigint; seq_scans: bigint | null; idx_scans: bigint | null }>>`
      SELECT relname AS name, n_live_tup::bigint AS rows, pg_total_relation_size(relid)::bigint AS bytes,
             seq_scan::bigint AS seq_scans, idx_scan::bigint AS idx_scans
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10`,
  ]);
  const row = info[0]!;
  return {
    ok: true,
    latencyMs: ping.latencyMs,
    error: null,
    version: row.version,
    sizeBytes: Number(row.size),
    connections: { total: Number(row.total), active: Number(row.active), idle: Number(row.idle), max: Number(row.max_conn) },
    cacheHitPercent: row.hit_ratio,
    deadlocks: Number(row.deadlocks),
    commits: Number(row.commits),
    rollbacks: Number(row.rollbacks),
    tables: tables.map((table) => ({
      name: table.name,
      rows: Number(table.rows),
      bytes: Number(table.bytes),
      seqScans: Number(table.seq_scans ?? 0),
      idxScans: Number(table.idx_scans ?? 0),
    })),
  };
}

/* ------------------------------------------------------------------ redis */

function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index > 0 && !line.startsWith('#')) out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

async function redisHealth() {
  const ping = await timedProbe(() => redis.ping());
  if (!ping.ok) return { ok: false, latencyMs: ping.latencyMs, error: ping.error };
  const [rawInfo, keys] = await Promise.all([redis.info(), redis.dbsize()]);
  const info = parseInfo(rawInfo);
  const hits = Number(info['keyspace_hits'] ?? 0);
  const misses = Number(info['keyspace_misses'] ?? 0);
  return {
    ok: true,
    latencyMs: ping.latencyMs,
    error: null,
    version: info['redis_version'] ?? 'unknown',
    uptimeSec: Number(info['uptime_in_seconds'] ?? 0),
    usedMemoryBytes: Number(info['used_memory'] ?? 0),
    peakMemoryBytes: Number(info['used_memory_peak'] ?? 0),
    maxMemoryBytes: Number(info['maxmemory'] ?? 0),
    clients: Number(info['connected_clients'] ?? 0),
    opsPerSec: Number(info['instantaneous_ops_per_sec'] ?? 0),
    hitPercent: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 1000) / 10 : null,
    evictedKeys: Number(info['evicted_keys'] ?? 0),
    expiredKeys: Number(info['expired_keys'] ?? 0),
    keys,
  };
}

/* ------------------------------------------------------------------ requests */

async function requestPerformance() {
  const since = new Date(Date.now() - DAY_MS);
  const [summary, hourly, slow] = await Promise.all([
    prisma.$queryRaw<Array<{ total: bigint; errors: bigint; client_errors: bigint; p50: number | null; p95: number | null; p99: number | null; avg: number | null }>>`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE status_code >= 500)::bigint AS errors,
             COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500)::bigint AS client_errors,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::float AS p99,
             AVG(duration_ms)::float AS avg
      FROM activity_logs WHERE created_at >= ${since}`,
    prisma.$queryRaw<Array<{ hour: Date; requests: bigint; errors: bigint; p95: number | null }>>`
      SELECT date_trunc('hour', created_at) AS hour, COUNT(*)::bigint AS requests,
             COUNT(*) FILTER (WHERE status_code >= 500)::bigint AS errors,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float AS p95
      FROM activity_logs WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<Array<{ route: string; count: bigint; p95: number }>>`
      SELECT COALESCE(route, path) AS route, COUNT(*)::bigint AS count, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float AS p95
      FROM activity_logs WHERE created_at >= ${since} GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY 3 DESC LIMIT 6`,
  ]);
  const row = summary[0];
  const total = Number(row?.total ?? 0);
  const byHour = new Map(hourly.map((item) => [item.hour.toISOString().slice(0, 13), item]));
  const start = Math.floor((Date.now() - 23 * 3_600_000) / 3_600_000) * 3_600_000;
  return {
    total,
    errors: Number(row?.errors ?? 0),
    clientErrors: Number(row?.client_errors ?? 0),
    errorRatePercent: total ? Math.round((Number(row?.errors ?? 0) / total) * 1000) / 10 : 0,
    p50: Math.round(row?.p50 ?? 0),
    p95: Math.round(row?.p95 ?? 0),
    p99: Math.round(row?.p99 ?? 0),
    avg: Math.round(row?.avg ?? 0),
    hourly: Array.from({ length: 24 }, (_, index) => {
      const hour = new Date(start + index * 3_600_000);
      const item = byHour.get(hour.toISOString().slice(0, 13));
      return { hour: hour.toISOString(), requests: Number(item?.requests ?? 0), errors: Number(item?.errors ?? 0), p95: Math.round(item?.p95 ?? 0) };
    }),
    slowRoutes: slow.map((item) => ({ route: item.route, count: Number(item.count), p95: Math.round(item.p95) })),
  };
}

/* ------------------------------------------------------------------ integrations */

async function integrations() {
  const [smtp, ai, settings, storage] = await Promise.all([
    prisma.smtpCredential.findMany({ select: { label: true, source: true, isActive: true, lastVerifyOk: true, lastVerifiedAt: true } }),
    prisma.aiCredential.findMany({ select: { provider: true, label: true, lastVerifyOk: true } }),
    getTokenSettings(),
    env.R2_ENABLED ? timedProbe(() => checkBucket()) : Promise.resolve(null),
  ]);
  const active = smtp.find((row) => row.isActive) ?? smtp.find((row) => row.source === 'ENV');
  return {
    mail: {
      accounts: smtp.length,
      active: active ? { label: active.label, verified: active.lastVerifyOk, checkedAt: active.lastVerifiedAt?.toISOString() ?? null } : null,
    },
    ai: { keys: ai.length, verified: ai.filter((row) => row.lastVerifyOk).length, providers: [...new Set(ai.map((row) => row.provider))] },
    paystack: { mode: settings.paystackMode, keys: keyStatus(), checks: lastKeyChecks() },
    storage: storage ? { configured: true, ok: storage.ok, latencyMs: storage.latencyMs, error: storage.error } : { configured: false, ok: false, latencyMs: null, error: 'Cloudflare R2 is not configured' },
  };
}

/* ------------------------------------------------------------------ snapshot */

export async function systemSnapshot() {
  const memory = process.memoryUsage();
  const loop = {
    p50Ms: Math.round((loopDelay.percentile(50) / 1e6) * 10) / 10,
    p99Ms: Math.round((loopDelay.percentile(99) / 1e6) * 10) / 10,
    maxMs: Math.round((loopDelay.max / 1e6) * 10) / 10,
  };
  loopDelay.reset();

  const [database, cache, queue, failedJobs, requests, links, projects] = await Promise.all([
    databaseHealth().catch((error: unknown) => ({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })),
    redisHealth().catch((error: unknown) => ({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })),
    queueCounts().catch(() => null),
    recentFailedJobs().catch(() => []),
    requestPerformance(),
    integrations(),
    prisma.mediaProject.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    app: { name: env.APP_NAME, env: env.NODE_ENV },
    process: {
      pid: process.pid,
      node: process.version,
      platform: `${os.type()} ${os.release()} (${process.arch})`,
      uptimeSec: Math.round(process.uptime()),
      cpuPercent: cpuPercent(),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
      eventLoop: loop,
      host: { cpus: os.cpus().length, loadAvg: os.loadavg().map((value) => Math.round(value * 100) / 100), totalMem: os.totalmem(), freeMem: os.freemem(), uptimeSec: Math.round(os.uptime()) },
    },
    database,
    redis: cache,
    queue: {
      ok: queue !== null,
      workerInline: env.MEDIA_WORKER_INLINE,
      workerRunning: workerRunning(),
      concurrency: env.MEDIA_WORKER_CONCURRENCY,
      counts: queue ?? {},
      failed: failedJobs,
      projects: Object.fromEntries(projects.map((row) => [row.status, row._count._all])),
    },
    jobs: listJobs(),
    logs: { counts: logCounts(), recent: recentLogs(60) },
    requests,
    integrations: links,
  };
}

/* ------------------------------------------------------------------ insights */

interface DayRow {
  day: Date;
  value: bigint | number | null;
}

function fillSeries(rows: DayRow[], from: Date, days: number): Array<{ day: string; value: number }> {
  const byDay = new Map(rows.map((row) => [row.day.toISOString().slice(0, 10), Number(row.value ?? 0)]));
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10);
    return { day, value: byDay.get(day) ?? 0 };
  });
}

export async function insights(rangeDays: number) {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (rangeDays - 1)));

  const [customers, users, projectRows, reelRows, minuteRows, totals, byStatus, durationRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{ id: string; name: string; owner: string | null; tokens_used: bigint; projects: bigint; reels: bigint; revenue: bigint; balance: bigint | null; last_active: Date | null }>
    >`
      SELECT w.id, w.name,
        (SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'OWNER' LIMIT 1) AS owner,
        COALESCE((SELECT SUM(-l.amount) FROM token_ledger l WHERE l.workspace_id = w.id AND l.type = 'USAGE' AND l.created_at >= ${from}), 0)::bigint AS tokens_used,
        (SELECT COUNT(*) FROM media_projects p WHERE p.workspace_id = w.id AND p.created_at >= ${from})::bigint AS projects,
        (SELECT COUNT(*) FROM reels r WHERE r.workspace_id = w.id AND r.status = 'READY' AND r.created_at >= ${from})::bigint AS reels,
        COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.workspace_id = w.id AND pay.status = 'SUCCESS' AND pay.mode = 'LIVE' AND pay.paid_at >= ${from}), 0)::bigint AS revenue,
        (SELECT balance FROM token_wallets tw WHERE tw.workspace_id = w.id)::bigint AS balance,
        (SELECT MAX(p.created_at) FROM media_projects p WHERE p.workspace_id = w.id) AS last_active
      FROM workspaces w
      ORDER BY tokens_used DESC, projects DESC, revenue DESC
      LIMIT 10`,
    prisma.$queryRaw<Array<{ id: string; email: string; display_name: string; requests: bigint; last_seen: Date }>>`
      SELECT u.id, u.email, u.display_name, COUNT(*)::bigint AS requests, MAX(a.created_at) AS last_seen
      FROM activity_logs a JOIN users u ON u.id = a.user_id
      WHERE a.created_at >= ${from}
      GROUP BY u.id ORDER BY 4 DESC LIMIT 8`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::bigint AS value FROM media_projects WHERE created_at >= ${from} GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::bigint AS value FROM reels WHERE status = 'READY' AND created_at >= ${from} GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`SELECT date_trunc('day', finished_at)::date AS day, ROUND(SUM(duration_sec) / 60.0)::bigint AS value FROM media_projects WHERE finished_at >= ${from} AND duration_sec IS NOT NULL GROUP BY 1`,
    prisma.$queryRaw<Array<{ reels: bigint; reel_bytes: bigint | null; source_bytes: bigint | null; minutes: number | null; projects: bigint }>>`
      SELECT (SELECT COUNT(*) FROM reels WHERE status = 'READY')::bigint AS reels,
             (SELECT SUM(size_bytes) FROM reels)::bigint AS reel_bytes,
             (SELECT SUM(source_size) FROM media_projects WHERE status <> 'UPLOADING')::bigint AS source_bytes,
             (SELECT SUM(duration_sec) / 60.0 FROM media_projects WHERE duration_sec IS NOT NULL)::float AS minutes,
             (SELECT COUNT(*) FROM media_projects)::bigint AS projects`,
    prisma.mediaProject.groupBy({ by: ['status'], where: { createdAt: { gte: from } }, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ avg_sec: number | null; p95_sec: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM finished_at - started_at))::float AS avg_sec,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM finished_at - started_at))::float AS p95_sec
      FROM media_projects WHERE status = 'READY' AND started_at IS NOT NULL AND finished_at >= ${from}`,
  ]);
  const total = totals[0];

  return {
    rangeDays,
    customers: customers.map((row) => ({
      workspaceId: row.id,
      name: row.name,
      owner: row.owner,
      tokensUsed: Number(row.tokens_used),
      projects: Number(row.projects),
      reels: Number(row.reels),
      revenue: Number(row.revenue),
      balance: Number(row.balance ?? 0),
      lastActiveAt: row.last_active?.toISOString() ?? null,
    })),
    activeUsers: users.map((row) => ({ id: row.id, email: row.email, displayName: row.display_name, requests: Number(row.requests), lastSeenAt: row.last_seen.toISOString() })),
    assets: {
      totalReels: Number(total?.reels ?? 0),
      totalProjects: Number(total?.projects ?? 0),
      reelBytes: Number(total?.reel_bytes ?? 0),
      sourceBytes: Number(total?.source_bytes ?? 0),
      minutesProcessed: Math.round(total?.minutes ?? 0),
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      processing: { avgSec: Math.round(durationRows[0]?.avg_sec ?? 0), p95Sec: Math.round(durationRows[0]?.p95_sec ?? 0) },
      projectsSeries: fillSeries(projectRows, from, rangeDays),
      reelsSeries: fillSeries(reelRows, from, rangeDays),
      minutesSeries: fillSeries(minuteRows, from, rangeDays),
    },
  };
}
