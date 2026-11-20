/**
 * Per-user storage: quota, usage, the generation gate, and paid storage.
 *
 *   quota   = platform default (250 MB, super-admin editable) or a per-user
 *             override, plus every paid pack still inside its 30-day period
 *   usage   = sum of the user's files in the storage_objects ledger
 *             (maintained by database triggers, see migration 002)
 *   gate    = before anything is generated, the estimated output must fit;
 *             uploads are also refused by the database itself when full
 *   packs   = extra storage bought through Paystack, billed per month
 *
 * User-facing reads and writes run under row-level security (withUser).
 */
import { z } from 'zod';
import { env } from '../config/env.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { call } from '../services/paystack.service.js';
import { getTokenSettings } from '../services/settings.service.js';
import { readUrl } from '../services/storage.service.js';
import { isUnmetered } from '../services/token.service.js';
import { json, sql, type Tx } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { randomToken } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { requireKyc } from '../privacy/kyc.js';
import { withUser } from './rls.js';

const MB = 1024 * 1024;

/* ------------------------------------------------------------------ settings */

const packSchema = z.strictObject({
  id: z.string().trim().regex(/^[a-z0-9-]{2,40}$/),
  label: z.string().trim().min(1).max(40),
  mb: z.number().int().min(50).max(10_000_000),
  /** Monthly price in the currency's minor unit (kobo for NGN). */
  price: z.number().int().min(100).max(1_000_000_000),
});

export const storageSettingsSchema = z.strictObject({
  defaultQuotaMb: z.number().int().min(0).max(10_000_000),
  /** Warn (banner + pre-flight) from this share of the quota. */
  warnPercent: z.number().int().min(50).max(99),
  periodDays: z.number().int().min(7).max(366),
  packs: z.array(packSchema).max(8),
  /** Reminder mail this many days before a paid pack ends. */
  remindDaysBefore: z.number().int().min(1).max(14).default(2),
  /** Over quota this long (e.g. a pack lapsed) → the oldest generated files are deleted. */
  graceDays: z.number().int().min(1).max(60).default(3),
});
export type StorageSettings = z.infer<typeof storageSettingsSchema>;

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  defaultQuotaMb: 250,
  warnPercent: 80,
  periodDays: 30,
  packs: [
    { id: 'plus-1gb', label: '+1 GB', mb: 1024, price: 150_000 },
    { id: 'plus-5gb', label: '+5 GB', mb: 5 * 1024, price: 500_000 },
    { id: 'plus-25gb', label: '+25 GB', mb: 25 * 1024, price: 1_800_000 },
  ],
  remindDaysBefore: 2,
  graceDays: 3,
};

let cache: { value: StorageSettings; at: number } | null = null;

export async function getStorageSettings(): Promise<StorageSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'storage'`;
  const parsed = storageSettingsSchema.safeParse({ ...DEFAULT_STORAGE_SETTINGS, ...(row?.value as object | undefined) });
  const value = parsed.success ? parsed.data : DEFAULT_STORAGE_SETTINGS;
  cache = { value, at: Date.now() };
  return value;
}

export async function saveStorageSettings(input: StorageSettings, actorId: string): Promise<StorageSettings> {
  const value = storageSettingsSchema.parse(input);
  if (new Set(value.packs.map((pack) => pack.id)).size !== value.packs.length) throw AppError.badRequest('Each storage pack needs a unique id.');
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('storage', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  cache = { value, at: Date.now() };
  return value;
}

/* ------------------------------------------------------------------ estimates */

/** Rough output sizes, used to check storage before anything is generated. */
export const SIZE_ESTIMATE = {
  image: 8 * MB,
  keyframe: 4 * MB,
  videoPerSecond: 2.5 * MB,
  reelPerSecond: 0.9 * MB,
  assemblyPerSecond: 3 * MB,
  assembly4kPerSecond: 10 * MB,
} as const;

/* ------------------------------------------------------------------ status */

export interface StorageStatus {
  usedBytes: number;
  files: number;
  quotaBytes: number;
  baseQuotaBytes: number;
  extraBytes: number;
  availableBytes: number;
  percent: number;
  level: 'ok' | 'warn' | 'full';
  warnPercent: number;
  deleteAt: string | null;
  /** Sum of active packs' prices, per period. */
  monthlyCharge: number;
  currency: string;
  activePacks: { id: string; label: string; bytes: number; amount: number; periodEnd: string; expiresInDays: number }[];
  /** A paid pack ends within 5 days. */
  expiringSoon: boolean;
  unlimited: boolean;
}

async function statusWith(tx: Tx, userId: string, unlimited: boolean): Promise<StorageStatus> {
  // All at once: the settings are cached, and the three queries pipeline on the
  // transaction's connection (one round trip instead of three).
  const [settings, { currency }, [account], [{ quota } = { quota: '0' }], packs] = await Promise.all([
    getStorageSettings(),
    getTokenSettings(),
    tx<{ usedBytes: string; files: number; quotaOverrideBytes: string | null; overQuotaSince: Date | null }[]>`
      SELECT used_bytes, files, quota_override_bytes, over_quota_since FROM storage_accounts WHERE user_id = ${userId}`,
    tx<{ quota: string }[]>`SELECT storage_quota(${userId}::uuid)::text AS quota`,
    tx<{ packId: string; bytes: string; amount: number; periodEnd: Date }[]>`
      SELECT pack_id, bytes, amount, period_end FROM storage_purchases
      WHERE user_id = ${userId} AND status = 'PAID' AND period_start <= now() AND period_end > now() ORDER BY period_end`,
  ]);
  const used = Number(account?.usedBytes ?? 0);
  const quotaBytes = Number(quota);
  const base = account?.quotaOverrideBytes ? Number(account.quotaOverrideBytes) : settings.defaultQuotaMb * MB;
  const percent = quotaBytes > 0 ? Math.round((used / quotaBytes) * 1000) / 10 : used > 0 ? 100 : 0;
  const activePacks = packs.map((pack) => ({
    id: pack.packId,
    label: settings.packs.find((item) => item.id === pack.packId)?.label ?? pack.packId,
    bytes: Number(pack.bytes),
    amount: pack.amount,
    periodEnd: pack.periodEnd.toISOString(),
    expiresInDays: Math.max(0, Math.ceil((pack.periodEnd.getTime() - Date.now()) / 86_400_000)),
  }));
  return {
    usedBytes: used,
    files: account?.files ?? 0,
    quotaBytes,
    baseQuotaBytes: base,
    extraBytes: Math.max(0, quotaBytes - base),
    availableBytes: Math.max(0, quotaBytes - used),
    percent,
    level: unlimited ? 'ok' : used >= quotaBytes ? 'full' : percent >= settings.warnPercent ? 'warn' : 'ok',
    warnPercent: settings.warnPercent,
    // Over the limit (lifecycle job): the date the oldest generated files are deleted.
    deleteAt: !unlimited && account?.overQuotaSince && used > quotaBytes ? new Date(account.overQuotaSince.getTime() + settings.graceDays * 86_400_000).toISOString() : null,
    monthlyCharge: activePacks.reduce((sum, pack) => sum + pack.amount, 0),
    currency,
    activePacks,
    expiringSoon: activePacks.some((pack) => pack.expiresInDays <= 5),
    unlimited,
  };
}

export async function storageStatus(auth: AuthContext): Promise<StorageStatus> {
  // The super admin follows the token mode: METERED lives every storage gate a customer does.
  const unlimited = await isUnmetered(auth);
  return withUser(auth, (tx) => statusWith(tx, auth.userId, unlimited));
}

/** System-side status (jobs, admin) for any user. */
export async function storageStatusFor(userId: string): Promise<StorageStatus> {
  return sql.begin((tx) => statusWith(tx, userId, false)) as Promise<StorageStatus>;
}

/**
 * The storage gate. Call before reserving tokens for anything that writes
 * files: throws 402 STORAGE_FULL when the estimated output won't fit.
 */
export async function assertStorage(auth: AuthContext, neededBytes: number, what: string): Promise<StorageStatus> {
  const status = await storageStatus(auth);
  if (status.unlimited) return status;
  if (status.usedBytes + neededBytes > status.quotaBytes) {
    throw new AppError(
      402,
      'STORAGE_FULL',
      `Not enough storage for ${what}: it needs about ${formatBytes(neededBytes)} and you have ${formatBytes(status.availableBytes)} free of ${formatBytes(status.quotaBytes)}. Download files to a backup drive and delete them, or buy more storage.`,
      { neededBytes, availableBytes: status.availableBytes, quotaBytes: status.quotaBytes, usedBytes: status.usedBytes },
    );
  }
  return status;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(bytes >= 10 * 1024 * MB ? 0 : 1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ------------------------------------------------------------------ breakdown + files */

const CATEGORY_SQL = `CASE
  WHEN key LIKE 'users/%/likeness/%' THEN 'likeness'
  WHEN key LIKE 'users/%/creations/%' THEN 'creations'
  WHEN key LIKE 'users/%/uploads/%' THEN 'uploads'
  WHEN key LIKE 'avatars/%' THEN 'profile'
  WHEN key LIKE 'workspaces/%/projects/%/source/%' THEN 'reel-sources'
  WHEN key LIKE 'workspaces/%/projects/%' THEN 'reels'
  WHEN key LIKE 'workspaces/%/studio/%/final/%' THEN 'films'
  WHEN key LIKE 'workspaces/%/studio/%' THEN 'studio'
  ELSE 'other' END`;

export async function storageFiles(auth: AuthContext, page: number, pageSize: number) {
  return withUser(auth, async (tx) => {
    const byCategory = await tx.unsafe<{ category: string; bytes: string; files: number }[]>(
      `SELECT ${CATEGORY_SQL} AS category, sum(bytes)::text AS bytes, count(*)::int AS files FROM storage_objects WHERE user_id = $1 GROUP BY 1 ORDER BY sum(bytes) DESC`,
      [auth.userId],
    );
    const rows = await tx.unsafe<{ key: string; bytes: string; kind: string; createdAt: Date; category: string }[]>(
      `SELECT key, bytes::text, kind, created_at, ${CATEGORY_SQL} AS category FROM storage_objects WHERE user_id = $1 ORDER BY bytes DESC LIMIT $2 OFFSET $3`,
      [auth.userId, pageSize, (page - 1) * pageSize],
    );
    return {
      byCategory: byCategory.map((row) => ({ category: row.category, bytes: Number(row.bytes), files: row.files })),
      files: await Promise.all(
        rows.map(async (row) => ({
          key: row.key,
          name: row.key.split('/').pop() ?? row.key,
          category: row.category,
          bytes: Number(row.bytes),
          kind: row.kind,
          createdAt: row.createdAt.toISOString(),
          downloadUrl: await readUrl(row.key, row.key.split('/').pop()),
        })),
      ),
    };
  });
}

/* ------------------------------------------------------------------ paid storage */

export async function startStorageCheckout(auth: AuthContext, packId: string) {
  if (auth.role !== 'SUPER_ADMIN') await requireKyc(auth.userId, 'purchase');
  const settings = await getStorageSettings();
  const pack = settings.packs.find((item) => item.id === packId);
  if (!pack) throw AppError.badRequest('That storage pack is no longer offered.');
  const tokens = await getTokenSettings();
  const mode = tokens.paystackMode;
  // Test mode in production: only the super admin may try the flow (no free storage for test cards).
  if (mode === 'TEST' && env.NODE_ENV === 'production' && auth.role !== 'SUPER_ADMIN') {
    throw new AppError(503, 'INTERNAL_ERROR', 'Storage purchases are being set up and open shortly. Please try again later.');
  }
  const [user] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${auth.userId}`;
  if (!user) throw AppError.notFound('User');
  const reference = `${env.APP_SLUG.slice(0, 10)}_S${mode === 'LIVE' ? 'L' : 'T'}_${randomToken(12)}`.replace(/[^A-Za-z0-9_-]/g, '');

  await withUser(auth, (tx) => tx`
    INSERT INTO storage_purchases (user_id, reference, mode, pack_id, bytes, amount, currency)
    VALUES (${auth.userId}, ${reference}, ${mode}, ${pack.id}, ${pack.mb * MB}, ${pack.price}, ${tokens.currency})`);
  const data = await call<{ authorization_url: string }>(mode, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: user.email,
      amount: pack.price,
      currency: tokens.currency,
      reference,
      callback_url: `${env.WEB_APP_URL}/dashboard/storage`,
      metadata: { kind: 'storage', userId: auth.userId, packId: pack.id, cancel_action: `${env.WEB_APP_URL}/dashboard/storage?checkout=cancelled` },
    }),
  });
  logger.info({ userId: auth.userId, reference, pack: pack.id }, 'storage checkout started');
  return { authorizationUrl: data.authorization_url, reference };
}

export function isStorageReference(reference: string): boolean {
  return /_S[LT]_/.test(reference);
}

/**
 * Asks Paystack for the truth and activates the pack. A pack bought while the
 * same pack is still running starts when that one ends (a renewal), so paying
 * early never double-counts. The status flip is conditional: the redirect and
 * the webhook can race safely.
 */
export async function verifyStoragePayment(reference: string): Promise<{ status: string; message: string }> {
  const [purchase] = await sql<{ id: string; userId: string; mode: 'TEST' | 'LIVE'; packId: string; amount: number; currency: string; status: string }[]>`
    SELECT id, user_id, mode, pack_id, amount, currency, status FROM storage_purchases WHERE reference = ${reference}`;
  if (!purchase) throw AppError.notFound('Storage purchase');
  if (purchase.status === 'PAID') return { status: 'PAID', message: 'Your extra storage is active.' };

  const data = await call<{ status: string; amount: number; currency: string; paid_at: string | null; gateway_response: string }>(purchase.mode, `/transaction/verify/${encodeURIComponent(reference)}`);
  if (data.status !== 'success') {
    const status = data.status === 'abandoned' ? 'ABANDONED' : data.status === 'failed' || data.status === 'reversed' ? 'FAILED' : 'PENDING';
    if (status !== 'PENDING') await sql`UPDATE storage_purchases SET status = ${status} WHERE id = ${purchase.id} AND status = 'PENDING'`;
    return { status, message: status === 'PENDING' ? 'Payment is still processing.' : `Payment ${status.toLowerCase()}: ${data.gateway_response}` };
  }
  if (data.amount !== purchase.amount || data.currency !== purchase.currency) {
    await sql`UPDATE storage_purchases SET status = 'FAILED' WHERE id = ${purchase.id}`;
    throw new AppError(400, 'PAYMENT_FAILED', 'The paid amount did not match this purchase. Contact support with your reference.');
  }
  const { periodDays } = await getStorageSettings();
  const claimed = await sql`
    UPDATE storage_purchases SET status = 'PAID', paid_at = ${data.paid_at ? new Date(data.paid_at) : new Date()},
      period_start = GREATEST(now(), COALESCE((SELECT max(period_end) FROM storage_purchases p WHERE p.user_id = ${purchase.userId} AND p.pack_id = ${purchase.packId} AND p.status = 'PAID' AND p.period_end > now()), now())),
      period_end = GREATEST(now(), COALESCE((SELECT max(period_end) FROM storage_purchases p WHERE p.user_id = ${purchase.userId} AND p.pack_id = ${purchase.packId} AND p.status = 'PAID' AND p.period_end > now()), now())) + make_interval(days => ${periodDays})
    WHERE id = ${purchase.id} AND status <> 'PAID' RETURNING id`;
  if (claimed.length) logger.info({ reference, userId: purchase.userId, pack: purchase.packId }, 'storage pack activated');
  return { status: 'PAID', message: 'Payment received. Your extra storage is active.' };
}

export async function verifyStorageForUser(auth: AuthContext, reference: string) {
  // RLS: the purchase is only visible to its owner (or a super admin).
  const [mine] = await withUser(auth, (tx) => tx`SELECT id FROM storage_purchases WHERE reference = ${reference}`);
  if (!mine) throw AppError.notFound('Storage purchase');
  return verifyStoragePayment(reference);
}

export async function purchaseHistory(auth: AuthContext) {
  const rows = await withUser(auth, (tx) => tx<{ reference: string; packId: string; bytes: string; amount: number; currency: string; status: string; periodStart: Date | null; periodEnd: Date | null; createdAt: Date }[]>`
    SELECT reference, pack_id, bytes::text, amount, currency, status, period_start, period_end, created_at FROM storage_purchases
    WHERE user_id = ${auth.userId} ORDER BY created_at DESC LIMIT 24`);
  return rows.map((row) => ({
    reference: row.reference,
    packId: row.packId,
    bytes: Number(row.bytes),
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    periodStart: row.periodStart?.toISOString() ?? null,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ super admin */

export async function adminOverview(auth: AuthContext, search: string | undefined) {
  const settings = await getStorageSettings();
  return withUser(auth, async (tx) => {
    const pattern = search ? `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : '%';
    const users = await tx<{ id: string; email: string; displayName: string; role: string; usedBytes: string | null; files: number | null; quotaOverrideBytes: string | null; quota: string }[]>`
      SELECT u.id, u.email, u.display_name, u.role::text, a.used_bytes::text, a.files, a.quota_override_bytes::text, storage_quota(u.id)::text AS quota
      FROM users u LEFT JOIN storage_accounts a ON a.user_id = u.id
      WHERE u.email ILIKE ${pattern} OR u.display_name ILIKE ${pattern}
      ORDER BY COALESCE(a.used_bytes, 0) DESC, u.created_at DESC LIMIT 100`;
    const [totals] = await tx<{ usedBytes: string; files: number; users: number }[]>`SELECT COALESCE(sum(used_bytes), 0)::text AS used_bytes, COALESCE(sum(files), 0)::int AS files, count(*)::int AS users FROM storage_accounts`;
    const [revenue] = await tx<{ active: number; monthly: string }[]>`
      SELECT count(*)::int AS active, COALESCE(sum(amount), 0)::text AS monthly FROM storage_purchases WHERE status = 'PAID' AND period_start <= now() AND period_end > now() AND mode = 'LIVE'`;
    return {
      settings,
      totals: { usedBytes: Number(totals?.usedBytes ?? 0), files: totals?.files ?? 0, users: totals?.users ?? 0, activePacks: revenue?.active ?? 0, monthlyRevenue: Number(revenue?.monthly ?? 0) },
      users: users.map((row) => {
        const used = Number(row.usedBytes ?? 0);
        const quota = Number(row.quota);
        return {
          id: row.id,
          email: row.email,
          displayName: row.displayName,
          role: row.role,
          usedBytes: used,
          files: row.files ?? 0,
          quotaBytes: quota,
          overrideBytes: row.quotaOverrideBytes ? Number(row.quotaOverrideBytes) : null,
          percent: quota > 0 ? Math.round((used / quota) * 1000) / 10 : 0,
        };
      }),
    };
  });
}

/** Per-user quota override in MB (null returns the user to the platform default). */
export async function setUserQuota(auth: AuthContext, userId: string, quotaMb: number | null) {
  await withUser(auth, (tx) => tx`
    INSERT INTO storage_accounts (user_id, quota_override_bytes) VALUES (${userId}, ${quotaMb === null ? null : quotaMb * MB})
    ON CONFLICT (user_id) DO UPDATE SET quota_override_bytes = EXCLUDED.quota_override_bytes, updated_at = now()`);
  logger.info({ actorId: auth.userId, userId, quotaMb }, 'storage quota override set');
}
