/**
 * Professional portraits: the user's profile photo, reimagined in up to six
 * professions (surgeon, pilot, architect, chef…), shown on the dashboard as a
 * playful carousel.
 *
 *   NOT AUTOMATIC   (2026-11-22, owner's call) new sign-ups and new profile
 *                   photos no longer get a set made for them: the upload hook
 *                   and the hourly catch-up job are gone. Sets made before
 *                   stay viewable and downloadable. portraitsForFirstPhoto /
 *                   syncPortraits remain for a deliberate, opt-in trigger.
 *   generate (job)  the image-edit model, with the photo as the reference,
 *                   keeps the person's identity; each result is stored full
 *                   resolution (private) plus a small watermarked preview.
 *                   Generation is on the platform (no user tokens).
 *   download        `priceTokens` per portrait, paid once from the token
 *                   balance (or after buying tokens); re-downloads are free.
 *                   Ledger task type PORTRAIT_DOWNLOAD + portrait_downloads.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { stampFile } from '../media/watermark.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { copyObject, deleteObject, privateReadUrl, readUrl, uploadFile } from '../services/storage.service.js';
import { applyEntry, getWallet, isUnmetered } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import * as fal from '../studio/fal.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

export const portraitSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  count: z.number().int().min(1).max(6),
  priceTokens: z.number().int().min(0).max(100_000),
  /** No longer used (portraits are made at once); kept so older saved settings still parse. */
  delayHours: z.number().int().min(0).max(24 * 30).optional(),
});
export type PortraitSettings = z.infer<typeof portraitSettingsSchema>;
export const DEFAULT_PORTRAITS: PortraitSettings = { enabled: false, count: 6, priceTokens: 15 };

const PROFESSIONS = [
  { field: 'surgeon', title: 'Surgeon', scene: 'a surgeon in scrubs and a surgical cap in a bright modern operating theatre, mask lowered, calm confident look' },
  { field: 'pilot', title: 'Airline captain', scene: 'an airline captain in a crisp uniform with four-stripe epaulettes, in a cockpit at golden hour' },
  { field: 'architect', title: 'Architect', scene: 'an architect in smart casual clothes holding rolled blueprints on a construction site with a glass tower behind' },
  { field: 'chef', title: 'Executive chef', scene: 'an executive chef in a white double-breasted jacket plating a dish in a professional steel kitchen' },
  { field: 'lawyer', title: 'Lawyer', scene: 'a senior lawyer in a tailored dark suit in a wood-panelled law library, holding a case file' },
  { field: 'scientist', title: 'Scientist', scene: 'a research scientist in a lab coat and safety glasses in a clean laboratory with glassware' },
  { field: 'ceo', title: 'Chief executive', scene: 'a chief executive in a sharp suit at a glass boardroom table overlooking a city skyline' },
  { field: 'engineer', title: 'Engineer', scene: 'an engineer in a hard hat and high-visibility vest at an energy plant, tablet in hand' },
  { field: 'doctor', title: 'Doctor', scene: 'a family doctor in a white coat with a stethoscope in a bright consulting room' },
  { field: 'photographer', title: 'Photographer', scene: 'a professional photographer with a full-frame camera in a studio with soft-box lights' },
  { field: 'musician', title: 'Musician', scene: 'a performing musician on a concert stage under warm spotlights, mid-performance' },
  { field: 'news-anchor', title: 'News anchor', scene: 'a television news anchor in a modern broadcast studio behind the desk' },
  { field: 'athlete', title: 'Athlete', scene: 'a professional athlete in team kit in a stadium tunnel before a match' },
  { field: 'professor', title: 'Professor', scene: 'a university professor in a blazer in front of a lecture-hall blackboard' },
] as const;

const REALISM =
  'Looks like an untouched photo from a real camera: natural light, true colour, real lens depth of field, real skin with pores and natural asymmetry; ' +
  'accurate anatomy and hands; no retouching, no beauty filter, no text, no watermark.';

export async function getPortraitSettings(): Promise<PortraitSettings> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'portraits'`.catch(() => []);
  const parsed = portraitSettingsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_PORTRAITS;
}

export async function savePortraitSettings(input: PortraitSettings, actorId: string): Promise<PortraitSettings> {
  const value = portraitSettingsSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('portraits', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  return value;
}

interface PortraitItem {
  id: string;
  field: string;
  title: string;
  previewKey: string;
  fullKey: string;
}
interface PortraitRow {
  userId: string;
  sourceKey: string;
  seenAt: Date;
  status: 'WAITING' | 'GENERATING' | 'READY' | 'FAILED';
  items: PortraitItem[];
  error: string | null;
  generatedAt: Date | null;
  attempts: number;
}

const prefixOf = (userId: string): string => `portraits/${userId}/`;

/* ------------------------------------------------------------------ scheduled */

/**
 * The user's FIRST profile photo: copied into their portraits folder (the
 * profile route deletes an avatar file when it is replaced, so the job must
 * not depend on it) and the set queued straight away. Does nothing when the
 * user already has a set (or one on the way): later photos never remake it.
 */
export async function portraitsForFirstPhoto(userId: string, avatarKey: string): Promise<boolean> {
  const [existing] = await sql<{ userId: string }[]>`SELECT user_id FROM profile_portraits WHERE user_id = ${userId}`;
  if (existing) return false;
  const extension = /\.([a-z0-9]+)$/i.exec(avatarKey)?.[1] ?? 'jpg';
  const sourceKey = `${prefixOf(userId)}source-${randomBytes(4).toString('hex')}.${extension}`;
  await copyObject(avatarKey, sourceKey);
  const inserted = await sql<{ userId: string }[]>`
    INSERT INTO profile_portraits (user_id, source_key) VALUES (${userId}, ${sourceKey}) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`;
  if (inserted.length === 0) {
    // Another request got there first: its copy is the source.
    await deleteObject(sourceKey).catch(() => undefined);
    return false;
  }
  if (!(await getPortraitSettings()).enabled) return true;
  const { enqueuePortraits } = await import('../studio/queue.js');
  await enqueuePortraits(userId);
  logger.info({ userId }, 'professional portraits queued for the first profile photo');
  return true;
}

/**
 * Hourly (and at start-up): catch-up. Users with a profile photo but no set
 * (their first photo came before portraits were made at once) get one now;
 * sets still waiting (a failed try, up to 3) are queued again. No delay.
 */
export async function syncPortraits(): Promise<string> {
  const settings = await getPortraitSettings();
  const missing = await sql<{ id: string; avatarKey: string }[]>`
    SELECT u.id, u.avatar_key FROM users u
    WHERE u.avatar_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profile_portraits p WHERE p.user_id = u.id)
    LIMIT 50`;
  let added = 0;
  for (const user of missing) {
    try {
      if (await portraitsForFirstPhoto(user.id, user.avatarKey)) added += 1;
    } catch (error) {
      logger.warn({ err: error, userId: user.id }, 'portrait source copy failed');
    }
  }
  if (!settings.enabled) return `${added} new portrait set(s) recorded; portraits are switched off`;
  const due = await sql<{ userId: string }[]>`SELECT user_id FROM profile_portraits WHERE status = 'WAITING' AND attempts < 3 LIMIT 50`;
  const { enqueuePortraits } = await import('../studio/queue.js');
  // The queue ignores a user whose job is already waiting or running.
  for (const row of due) await enqueuePortraits(row.userId);
  return `${added} new portrait set(s), ${due.length} queued`;
}

/** Worker job: makes the portrait set for one user. */
export async function runPortraits(userId: string): Promise<void> {
  const [row] = await sql<PortraitRow[]>`SELECT * FROM profile_portraits WHERE user_id = ${userId}`;
  if (!row || row.status !== 'WAITING') return;
  const settings = await getPortraitSettings();
  const studio = await getStudioSettings();
  if (!settings.enabled || !fal.falConfigured() || !studio.models.imageEdit.enabled) return;
  await sql`UPDATE profile_portraits SET status = 'GENERATING', attempts = attempts + 1, updated_at = now() WHERE user_id = ${userId}`;
  const workDir = await mkdtemp(join(tmpdir(), `portraits-${userId.slice(0, 8)}-`));
  const batch = randomBytes(6).toString('hex');
  try {
    const photo = await privateReadUrl(row.sourceKey, 3600);
    // A different mix of professions each time a set is made.
    const fields = [...PROFESSIONS].sort(() => Math.random() - 0.5).slice(0, settings.count);
    const items: PortraitItem[] = [];
    for (const profession of fields) {
      try {
        const handle = await fal.submit(studio.models.imageEdit.endpoint, {
          ...studio.models.imageEdit.extra,
          prompt:
            `Create a new photograph of the person in the reference image as ${profession.scene}. Keep their exact face, skin tone, hairline, age and features; ` +
            `do not beautify, slim or age them. Waist-up portrait, looking towards the camera. ${REALISM}`,
          image_urls: [photo],
        });
        const result = await fal.wait(handle, { timeoutMs: 5 * 60_000 });
        const full = join(workDir, `${profession.field}.png`);
        await downloadUrl(fal.outputUrl(result, 'image'), full);
        // Preview: small JPEG with the platform watermark (the full file stays private until paid).
        const small = join(workDir, `${profession.field}-small.jpg`);
        await ffmpeg(['-i', full, '-vf', 'scale=720:-2', '-q:v', '4', small]);
        const preview = await stampFile(small, join(workDir, `${profession.field}-preview.jpg`), 'image', { width: 720, height: 960 });
        const fullKey = `${prefixOf(userId)}${batch}/${profession.field}.png`;
        const previewKey = `${prefixOf(userId)}${batch}/${profession.field}-preview.jpg`;
        await Promise.all([uploadFile(fullKey, full, 'image/png'), uploadFile(previewKey, preview, 'image/jpeg')]);
        items.push({ id: `${batch}-${profession.field}`, field: profession.field, title: profession.title, previewKey, fullKey });
      } catch (error) {
        logger.warn({ err: error, userId, field: profession.field }, 'portrait failed; the set continues without it');
      }
    }
    if (items.length === 0) throw new Error('No portrait could be made from this photo.');
    // The previous set (if any) is replaced.
    const old = row.items.map((item) => [item.fullKey, item.previewKey]).flat();
    await sql`UPDATE profile_portraits SET status = 'READY', items = ${json(items)}, generated_at = now(), error = NULL, updated_at = now() WHERE user_id = ${userId}`;
    for (const key of old) {
      if (!key.includes(`/${batch}/`)) await deleteObject(key).catch(() => undefined);
    }
    logger.info({ userId, portraits: items.length }, 'professional portraits ready');
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    // Retried by the next sync (up to 3 attempts).
    await sql`UPDATE profile_portraits SET status = CASE WHEN attempts >= 3 THEN 'FAILED' ELSE 'WAITING' END, error = ${message}, updated_at = now() WHERE user_id = ${userId}`;
    logger.warn({ err: error, userId }, 'portrait set failed');
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ user API */

async function ownedItems(userId: string, sourceKey: string): Promise<Set<string>> {
  const rows = await sql<{ itemId: string }[]>`SELECT item_id FROM portrait_downloads WHERE user_id = ${userId} AND source_key = ${sourceKey}`;
  return new Set(rows.map((item) => item.itemId));
}

export async function myPortraits(userId: string) {
  const settings = await getPortraitSettings();
  const [row] = await sql<PortraitRow[]>`SELECT * FROM profile_portraits WHERE user_id = ${userId}`;
  if (!row) return { enabled: settings.enabled, status: 'NONE' as const, items: [], priceTokens: settings.priceTokens, readyAt: null };
  const owned = await ownedItems(userId, row.sourceKey);
  return {
    enabled: settings.enabled,
    status: row.status,
    priceTokens: settings.priceTokens,
    readyAt: null,
    items: await Promise.all(row.items.map(async (item) => ({ id: item.id, field: item.field, title: item.title, previewUrl: await readUrl(item.previewKey), owned: owned.has(item.id) }))),
  };
}

/**
 * Buys (once) and returns a download link for the full-resolution portrait.
 * The price comes from the settings; `expectedTokens` guards against a change
 * since the price was shown.
 */
export async function downloadPortrait(auth: AuthContext, workspaceId: string, itemId: string, expectedTokens: number) {
  const [row] = await sql<PortraitRow[]>`SELECT * FROM profile_portraits WHERE user_id = ${auth.userId}`;
  const item = row?.items.find((entry) => entry.id === itemId);
  if (!row || !item) throw AppError.notFound('Portrait');
  const owned = await ownedItems(auth.userId, row.sourceKey);
  const fileName = `${item.title} portrait.png`;
  if (owned.has(itemId)) return { url: await privateReadUrl(item.fullKey, 600, fileName), charged: 0, wallet: null };

  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  const settings = await getPortraitSettings();
  if (settings.priceTokens !== expectedTokens) throw AppError.conflict(`The price changed to ${settings.priceTokens} tokens. Check it and confirm again.`);
  const free = await isUnmetered(auth);
  const price = free ? 0 : settings.priceTokens;
  const wallet = await getWallet(workspaceId);
  if (price > wallet.available) {
    throw new AppError(402, 'INSUFFICIENT_TOKENS', `This portrait costs ${price} tokens; the workspace has ${wallet.available} available. Buy tokens to continue.`, {
      required: price,
      available: wallet.available,
      shortfall: price - wallet.available,
    });
  }
  await prisma.$transaction(async (tx) => {
    if (price > 0) {
      await applyEntry(tx, { workspaceId, type: 'USAGE', amount: -price, taskType: 'PORTRAIT_DOWNLOAD', reference: `portrait:${itemId}`, note: `Professional portrait download · ${item.title}`, actorId: auth.userId });
    }
    await tx.$executeRaw`INSERT INTO portrait_downloads (user_id, workspace_id, item_id, field, source_key, tokens) VALUES (${auth.userId}::uuid, ${workspaceId}::uuid, ${itemId}, ${item.field}, ${row.sourceKey}, ${price}) ON CONFLICT DO NOTHING`;
  });
  logger.info({ userId: auth.userId, workspaceId, itemId, tokens: price }, 'portrait purchased');
  return { url: await privateReadUrl(item.fullKey, 600, fileName), charged: price, wallet: await getWallet(workspaceId) };
}

/** Super admin: a user's portraits (with full-size links) and every download they paid for. */
export async function adminUserPortraits(userId: string) {
  const [row] = await sql<PortraitRow[]>`SELECT * FROM profile_portraits WHERE user_id = ${userId}`;
  const downloads = await sql<{ id: string; workspaceId: string; itemId: string; field: string; tokens: number; createdAt: Date }[]>`
    SELECT id, workspace_id, item_id, field, tokens, created_at FROM portrait_downloads WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100`;
  return {
    status: row?.status ?? 'NONE',
    error: row?.error ?? null,
    seenAt: row?.seenAt.toISOString() ?? null,
    generatedAt: row?.generatedAt?.toISOString() ?? null,
    items: row ? await Promise.all(row.items.map(async (item) => ({ id: item.id, title: item.title, previewUrl: await readUrl(item.previewKey), fullUrl: await privateReadUrl(item.fullKey, 600) }))) : [],
    downloads: downloads.map((download) => ({ ...download, createdAt: download.createdAt.toISOString() })),
    totalTokens: downloads.reduce((sum, download) => sum + download.tokens, 0),
  };
}
