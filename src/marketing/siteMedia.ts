/**
 * The site's own images and videos, live from the marketing studio.
 *
 *   publish     an asset made for a slot (landing hero, a creators card, an avatar…) is copied in
 *               R2 to a permanent site key (site/media/…, stamped so a new one is never served
 *               from an old cache) and recorded against the slot's path ("/media/landing/hero.mp4")
 *   auto        a slot with nothing on the site gets its newest finished asset on its own, so a
 *               freshly made asset shows up without another click; "Use on the site" picks another
 *   public      GET /api/v1/site/media → { media: { "/media/…": { url, kind } } }: the site reads it
 *               while it renders and every component swaps its path for the live R2 address
 * The map lives in platform_settings ("site-media"); replaced files are deleted from the bucket.
 */
import { copyObject, deleteObject, readUrl } from '../services/storage.service.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { loadSlots } from './slots.js';

const KEY = 'site-media';

interface Entry {
  assetId: string;
  slotId: string;
  /** The permanent site copy in R2. */
  key: string;
  kind: 'IMAGE' | 'VIDEO';
  at: string;
}
type SiteMap = Record<string, Entry>;

async function readMap(): Promise<SiteMap> {
  const [row] = await sql<{ value: SiteMap }[]>`SELECT value FROM platform_settings WHERE key = ${KEY}`;
  return row?.value ?? {};
}
async function writeMap(map: SiteMap, actorId: string | null): Promise<void> {
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES (${KEY}, ${json(map)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  cached = null;
}

const extension = (key: string, kind: 'IMAGE' | 'VIDEO'): string => /\.([a-z0-9]{2,5})$/i.exec(key)?.[1]?.toLowerCase() ?? (kind === 'VIDEO' ? 'mp4' : 'png');

/** Puts a finished asset on the site for a slot (its own slot unless another is named). */
export async function publishAsset(assetId: string, slotId: string | null, actorId: string | null): Promise<{ path: string; url: string }> {
  const [asset] = await sql<{ id: string; kind: string; slotId: string | null; status: string; outputKey: string | null }[]>`
    SELECT id, kind, slot_id, status, output_key FROM marketing_assets WHERE id = ${assetId}`;
  if (!asset) throw AppError.notFound('Asset');
  if (asset.status !== 'READY' || !asset.outputKey) throw AppError.badRequest('This asset isn’t finished yet.');
  const slot = (await loadSlots()).find((item) => item.id === (slotId ?? asset.slotId));
  if (!slot) throw AppError.badRequest('Choose the place on the site this asset is for.');
  const kind = asset.kind === 'VIDEO' || asset.kind === 'TUTORIAL' ? 'VIDEO' : 'IMAGE';
  if (kind !== slot.kind) throw AppError.badRequest(`That place needs ${slot.kind === 'VIDEO' ? 'a video' : 'an image'}.`);

  const stamp = Date.now().toString(36);
  const base = slot.path.replace(/^\/+/, '').replace(/^media\//, '').replace(/\.[a-z0-9]+$/i, '');
  const key = `site/media/${base}-${stamp}.${extension(asset.outputKey, kind)}`;
  await copyObject(asset.outputKey, key);
  const map = await readMap();
  const previous = map[slot.path];
  map[slot.path] = { assetId, slotId: slot.id, key, kind, at: new Date().toISOString() };
  await writeMap(map, actorId);
  if (previous && previous.key !== key) await deleteObject(previous.key).catch(() => undefined);
  logger.info({ path: slot.path, assetId }, 'site media published');
  return { path: slot.path, url: await readUrl(key) };
}

/** Takes a slot's asset off the site (the page shows its built-in placeholder again). */
export async function unpublish(path: string, actorId: string): Promise<void> {
  const map = await readMap();
  const entry = map[path];
  if (!entry) return;
  delete map[path];
  await writeMap(map, actorId);
  await deleteObject(entry.key).catch(() => undefined);
}

/** Slots with nothing on the site take their newest finished asset. */
export async function autoPublish(): Promise<number> {
  const [map, slots] = await Promise.all([readMap(), loadSlots()]);
  const empty = slots.filter((slot) => !map[slot.path]);
  if (!empty.length) return 0;
  const ready = await sql<{ id: string; slotId: string }[]>`
    SELECT DISTINCT ON (slot_id) id, slot_id FROM marketing_assets
    WHERE status = 'READY' AND output_key IS NOT NULL AND slot_id = ANY(${empty.map((slot) => slot.id)}::text[])
    ORDER BY slot_id, created_at DESC`;
  let published = 0;
  for (const row of ready) {
    await publishAsset(row.id, row.slotId, null)
      .then(() => (published += 1))
      .catch((error: unknown) => logger.warn({ err: error, assetId: row.id }, 'site media auto-publish skipped'));
  }
  return published;
}

/** What each slot shows now (for the marketing studio). */
export async function siteMediaInUse(): Promise<Record<string, { assetId: string; at: string }>> {
  const map = await readMap();
  return Object.fromEntries(Object.entries(map).map(([path, entry]) => [path, { assetId: entry.assetId, at: entry.at }]));
}

let cached: { value: Record<string, { url: string; kind: 'IMAGE' | 'VIDEO' }>; at: number } | null = null;
let lastAuto = 0;

/** The public map the site renders with (cached a minute; auto-publishes at most once a minute). */
export async function publicSiteMedia(): Promise<{ media: Record<string, { url: string; kind: 'IMAGE' | 'VIDEO' }> }> {
  if (Date.now() - lastAuto > 60_000) {
    lastAuto = Date.now();
    await autoPublish().catch((error: unknown) => logger.warn({ err: error }, 'site media auto-publish failed'));
  }
  if (cached && Date.now() - cached.at < 60_000) return { media: cached.value };
  const map = await readMap();
  const value = Object.fromEntries(await Promise.all(Object.entries(map).map(async ([path, entry]) => [path, { url: await readUrl(entry.key), kind: entry.kind }] as const)));
  cached = { value, at: Date.now() };
  return { media: value };
}
