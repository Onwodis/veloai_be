/**
 * Paid cloud storage lifecycle (hourly job).
 *
 *   Reminder   a paid pack ending within `remindDaysBefore` days (default 2)
 *              that hasn't been renewed → one mail: renew, or download and
 *              delete what you don't need.
 *   Over quota first time a user is over their allowance (usually a pack
 *              lapsed) → one mail with the deletion date (now + graceDays).
 *   Purge      still over quota after the grace period → the OLDEST GENERATED
 *              files are deleted until the user is back within the allowance
 *              (uploads are never auto-deleted), then a summary mail. Studio
 *              takes go whole (the take is hidden as CANCELED and unpicked);
 *              a film whose master is deleted loses its output link.
 * The super admin (and accounts with no paid storage history) follow the same
 * rules, except super admins in UNLIMITED token mode, who are skipped.
 */
import { env } from '../config/env.js';
import { sendMail } from '../services/mail/mail.service.js';
import { storageExpiringMail, storageOverQuotaMail, storagePurgedMail } from '../services/mail/templates.js';
import { deleteObject, deletePrefix } from '../services/storage.service.js';
import { getTokenSettings } from '../services/settings.service.js';
import { sql } from '../studio/sql.js';
import { logger } from '../utils/logger.js';
import { formatBytes, getStorageSettings } from './service.js';

const DAY = 86_400_000;
const storageUrl = (): string => `${env.WEB_APP_URL}/dashboard/storage`;
const dateLabel = (date: Date): string => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

async function skipSuperAdmins(): Promise<boolean> {
  return (await getTokenSettings()).superAdminMode !== 'METERED';
}

/** "Ends in 2 days" mails for packs that are not renewed. */
async function remind(): Promise<number> {
  const settings = await getStorageSettings();
  const due = await sql<{ id: string; userId: string; email: string; packId: string; periodEnd: Date }[]>`
    SELECT p.id, p.user_id, u.email, p.pack_id, p.period_end FROM storage_purchases p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'PAID' AND p.reminded_at IS NULL AND p.period_end > now()
      AND p.period_end <= now() + make_interval(days => ${settings.remindDaysBefore})
      -- Already renewed: a later paid period of the same pack exists.
      AND NOT EXISTS (SELECT 1 FROM storage_purchases r WHERE r.user_id = p.user_id AND r.pack_id = p.pack_id AND r.status = 'PAID' AND r.period_end > p.period_end)`;
  let sent = 0;
  for (const row of due) {
    const [account] = await sql<{ usedBytes: string; overrideBytes: string | null }[]>`
      SELECT used_bytes::text, quota_override_bytes::text AS override_bytes FROM storage_accounts WHERE user_id = ${row.userId}`;
    const freeBytes = account?.overrideBytes ? Number(account.overrideBytes) : settings.defaultQuotaMb * 1024 * 1024;
    const pack = settings.packs.find((item) => item.id === row.packId)?.label ?? row.packId;
    const daysLeft = Math.max(1, Math.ceil((row.periodEnd.getTime() - Date.now()) / DAY));
    try {
      await sendMail(
        row.email,
        storageExpiringMail({
          pack,
          endsOn: dateLabel(row.periodEnd),
          daysLeft,
          usedLabel: formatBytes(Number(account?.usedBytes ?? 0)),
          freeLabel: formatBytes(freeBytes),
          url: storageUrl(),
        }),
      );
      await sql`UPDATE storage_purchases SET reminded_at = now() WHERE id = ${row.id}`;
      sent += 1;
    } catch (error) {
      logger.warn({ err: error, userId: row.userId }, 'storage reminder mail failed (retried next hour)');
    }
  }
  return sent;
}

/** Deletes the oldest generated files of a user until they fit; returns files and bytes freed. */
async function purgeOldest(userId: string, overBytes: number): Promise<{ files: number; bytes: number }> {
  let freed = 0;
  let files = 0;
  const handledTakes = new Set<string>();
  while (freed < overBytes) {
    const batch = await sql<{ key: string; bytes: string }[]>`
      SELECT key, bytes::text FROM storage_objects WHERE user_id = ${userId} AND kind = 'GENERATED' ORDER BY created_at LIMIT 50`;
    if (batch.length === 0) break;
    for (const object of batch) {
      if (freed >= overBytes) break;
      const take = /^(workspaces\/[^/]+\/studio\/[^/]+)\/takes\/([0-9a-f-]{36})\//.exec(object.key);
      if (take) {
        const takeId = take[2]!;
        if (handledTakes.has(takeId)) continue;
        handledTakes.add(takeId);
        // The whole take goes: hidden (CANCELED, kept for the ledger) and unpicked.
        const [{ bytes } = { bytes: '0' }] = await sql<{ bytes: string }[]>`
          SELECT COALESCE(sum(bytes), 0)::text AS bytes FROM storage_objects WHERE key LIKE ${`${take[1]}/takes/${takeId}/%`}`;
        await sql`UPDATE studio_scenes SET selected_take_id = NULL, shot_approved_at = NULL WHERE selected_take_id = ${takeId}`;
        await sql`UPDATE studio_takes SET status = 'CANCELED' WHERE id = ${takeId} AND status IN ('READY', 'FAILED')`;
        files += await deletePrefix(`${take[1]}/takes/${takeId}/`);
        freed += Number(bytes);
        continue;
      }
      // A film master: the project keeps its edit, only the output link goes.
      await sql`UPDATE studio_projects SET output_key = NULL, thumb_key = NULL, status = CASE WHEN status = 'READY' THEN 'DRAFT' ELSE status END WHERE output_key = ${object.key}`;
      await deleteObject(object.key);
      freed += Number(object.bytes);
      files += 1;
    }
  }
  return { files, bytes: freed };
}

/** Over-quota warnings and, after the grace period, the purge. */
async function enforce(): Promise<{ warned: number; purged: number }> {
  const settings = await getStorageSettings();
  const skipAdmins = await skipSuperAdmins();
  const accounts = await sql<{ userId: string; email: string; role: string; usedBytes: string; quota: string; overSince: Date | null; mailedAt: Date | null }[]>`
    SELECT a.user_id, u.email, u.role::text AS role, a.used_bytes::text, storage_quota(a.user_id)::text AS quota, a.over_quota_since AS over_since, a.over_quota_mailed_at AS mailed_at
    FROM storage_accounts a JOIN users u ON u.id = a.user_id
    WHERE a.used_bytes > 0 AND (a.used_bytes > storage_quota(a.user_id) OR a.over_quota_since IS NOT NULL)`;
  let warned = 0;
  let purged = 0;
  for (const account of accounts) {
    if (skipAdmins && account.role === 'SUPER_ADMIN') continue;
    const used = Number(account.usedBytes);
    const quota = Number(account.quota);
    if (used <= quota) {
      // Back within the allowance (bought storage or deleted files): the episode ends.
      await sql`UPDATE storage_accounts SET over_quota_since = NULL, over_quota_mailed_at = NULL WHERE user_id = ${account.userId}`;
      continue;
    }
    const since = account.overSince ?? new Date();
    if (!account.overSince) await sql`UPDATE storage_accounts SET over_quota_since = now() WHERE user_id = ${account.userId}`;
    const deleteAt = new Date(since.getTime() + settings.graceDays * DAY);
    if (!account.mailedAt) {
      try {
        await sendMail(
          account.email,
          storageOverQuotaMail({ usedLabel: formatBytes(used), quotaLabel: formatBytes(quota), overLabel: formatBytes(used - quota), deleteOn: dateLabel(deleteAt), url: storageUrl() }),
        );
        await sql`UPDATE storage_accounts SET over_quota_mailed_at = now() WHERE user_id = ${account.userId}`;
        warned += 1;
      } catch (error) {
        logger.warn({ err: error, userId: account.userId }, 'over-quota mail failed (retried next hour)');
      }
    }
    if (Date.now() < deleteAt.getTime()) continue;
    const result = await purgeOldest(account.userId, used - quota);
    if (result.files === 0) continue;
    purged += 1;
    logger.warn({ userId: account.userId, files: result.files, bytes: result.bytes }, 'storage over quota past grace: oldest generated files deleted');
    const [after] = await sql<{ usedBytes: string }[]>`SELECT used_bytes::text FROM storage_accounts WHERE user_id = ${account.userId}`;
    await sendMail(
      account.email,
      storagePurgedMail({ files: result.files, freedLabel: formatBytes(result.bytes), usedLabel: formatBytes(Number(after?.usedBytes ?? 0)), quotaLabel: formatBytes(quota), url: storageUrl() }),
    ).catch((error: unknown) => logger.warn({ err: error, userId: account.userId }, 'purge summary mail failed'));
  }
  return { warned, purged };
}

/** The hourly job. */
export async function runStorageLifecycle(): Promise<string> {
  const reminders = await remind();
  const { warned, purged } = await enforce();
  return `${reminders} renewal reminder(s), ${warned} over-quota warning(s), ${purged} account(s) trimmed`;
}
