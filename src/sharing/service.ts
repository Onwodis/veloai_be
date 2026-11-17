/**
 * Public links to a project's media: the finished film, a take, an ad's
 * platform version or an uploaded asset. Two kinds per asset:
 *
 *   VIEW      a page that plays it; the video streams through the API (no
 *             storage URL, no download button)
 *   DOWNLOAD  the same page plus a download (a short-lived signed URL, issued
 *             only after the token checks out)
 *
 * Links expire (per-user default, or per link), can be rotated (the old URL
 * stops working, a new one is issued) or revoked, and "expire all" ends every
 * link a user made. The film link always serves the CURRENT master.
 */
import type { Readable } from 'node:stream';
import { env } from '../config/env.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { workspaceAccess } from '../commercials/companies.js';
import { getObjectRange, readUrl } from '../services/storage.service.js';
import { sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { decodeShareToken, encodeShareToken, type ShareMode } from './token.js';

export type AssetKind = 'PROJECT_OUTPUT' | 'TAKE' | 'AD_VERSION' | 'ASSET';
const MAX_ACTIVE_PER_PROJECT = 100;
const DEFAULT_DAYS = 30;

interface LinkRow {
  id: string;
  projectId: string;
  workspaceId: string;
  createdById: string;
  assetKind: AssetKind;
  assetRef: string;
  mode: ShareMode;
  title: string;
  keyVersion: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  views: number;
  downloads: number;
  lastOpenedAt: Date | null;
  createdAt: Date;
}

interface Resolved {
  key: string;
  posterKey: string | null;
  filename: string;
  durationSec: number | null;
  kindLabel: string;
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9._ -]+/g, ' ').trim().slice(0, 80) || 'video';

/** What a link points at right now (null when the media is gone). */
async function resolve(link: Pick<LinkRow, 'projectId' | 'assetKind' | 'assetRef'>): Promise<Resolved | null> {
  const [project] = await sql<{ title: string; outputKey: string | null; thumbKey: string | null; outputDuration: number | null; deletedAt: Date | null }[]>`
    SELECT title, output_key, thumb_key, output_duration, deleted_at FROM studio_projects WHERE id = ${link.projectId}`;
  if (!project || project.deletedAt) return null;
  const title = safeName(project.title);
  switch (link.assetKind) {
    case 'PROJECT_OUTPUT':
      return project.outputKey
        ? { key: project.outputKey, posterKey: project.thumbKey, filename: `${title}.mp4`, durationSec: project.outputDuration ? Number(project.outputDuration) : null, kindLabel: 'Film' }
        : null;
    case 'TAKE': {
      const [take] = await sql<{ videoKey: string | null; thumbKey: string | null; durationSec: number | null; position: number }[]>`
        SELECT t.video_key, t.thumb_key, t.duration_sec, s.position FROM studio_takes t JOIN studio_scenes s ON s.id = t.scene_id
        WHERE t.id = ${link.assetRef} AND t.project_id = ${link.projectId} AND t.status = 'READY'`;
      return take?.videoKey
        ? { key: take.videoKey, posterKey: take.thumbKey, filename: `${title} - scene ${take.position + 1}.mp4`, durationSec: take.durationSec ? Number(take.durationSec) : null, kindLabel: `Scene ${take.position + 1}` }
        : null;
    }
    case 'AD_VERSION': {
      const [ad] = await sql<{ versions: { aspect: string; status: string; key: string | null }[] }[]>`SELECT versions FROM ad_projects WHERE project_id = ${link.projectId}`;
      const version = ad?.versions.find((item) => item.aspect === link.assetRef && item.status === 'READY' && item.key);
      return version?.key ? { key: version.key, posterKey: project.thumbKey, filename: `${title} (${link.assetRef.replace(':', 'x')}).mp4`, durationSec: null, kindLabel: `${link.assetRef} version` } : null;
    }
    case 'ASSET': {
      const [asset] = await sql<{ key: string; name: string; status: string }[]>`SELECT key, name, status FROM studio_assets WHERE id = ${link.assetRef} AND project_id = ${link.projectId}`;
      return asset && asset.status === 'READY' ? { key: asset.key, posterKey: null, filename: safeName(asset.name), durationSec: null, kindLabel: 'File' } : null;
    }
    default:
      return null;
  }
}

const urlOf = (link: Pick<LinkRow, 'id' | 'mode' | 'keyVersion'>): string => `${env.WEB_APP_URL}/s/${encodeShareToken(link.id, link.mode, link.keyVersion)}`;
const stateOf = (link: LinkRow): 'ACTIVE' | 'EXPIRED' | 'REVOKED' => (link.revokedAt ? 'REVOKED' : link.expiresAt && link.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'ACTIVE');

function present(link: LinkRow) {
  const state = stateOf(link);
  return {
    id: link.id,
    projectId: link.projectId,
    assetKind: link.assetKind,
    assetRef: link.assetRef,
    mode: link.mode,
    title: link.title,
    state,
    // Only live links carry their URL.
    url: state === 'ACTIVE' ? urlOf(link) : null,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    views: link.views,
    downloads: link.downloads,
    lastOpenedAt: link.lastOpenedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}
export type ShareLinkView = ReturnType<typeof present>;

async function ownProject(auth: AuthContext, workspaceId: string, projectId: string, write: boolean): Promise<{ title: string }> {
  await workspaceAccess(auth, workspaceId, write);
  const [project] = await sql<{ title: string }[]>`SELECT title FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!project) throw AppError.notFound('Project');
  return project;
}

export async function defaultDays(userId: string): Promise<number | null> {
  const [row] = await sql<{ defaultDays: number | null }[]>`SELECT default_days FROM share_link_prefs WHERE user_id = ${userId}`;
  return row ? row.defaultDays : DEFAULT_DAYS;
}

export async function setDefaultDays(auth: AuthContext, days: number | null) {
  await sql`
    INSERT INTO share_link_prefs (user_id, default_days, updated_at) VALUES (${auth.userId}, ${days}, now())
    ON CONFLICT (user_id) DO UPDATE SET default_days = EXCLUDED.default_days, updated_at = now()`;
  return { defaultDays: days };
}

export async function createLink(
  auth: AuthContext,
  workspaceId: string,
  input: { projectId: string; assetKind: AssetKind; assetRef: string; mode: ShareMode; expiresInDays?: number | null | undefined },
) {
  const project = await ownProject(auth, workspaceId, input.projectId, true);
  const resolved = await resolve({ projectId: input.projectId, assetKind: input.assetKind, assetRef: input.assetRef });
  if (!resolved) throw AppError.badRequest('There is nothing to share yet: that video is not finished (or was deleted).');
  const [{ active } = { active: 0 }] = await sql<{ active: number }[]>`
    SELECT count(*)::int AS active FROM share_links WHERE project_id = ${input.projectId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
  if (active >= MAX_ACTIVE_PER_PROJECT) throw AppError.badRequest(`This project already has ${MAX_ACTIVE_PER_PROJECT} live links. Revoke some first.`);
  const days = input.expiresInDays === undefined ? await defaultDays(auth.userId) : input.expiresInDays;
  const [link] = await sql<LinkRow[]>`
    INSERT INTO share_links (project_id, workspace_id, created_by_id, asset_kind, asset_ref, mode, title, expires_at)
    VALUES (${input.projectId}, ${workspaceId}, ${auth.userId}, ${input.assetKind}, ${input.assetRef}, ${input.mode},
      ${`${project.title} · ${resolved.kindLabel}`.slice(0, 160)}, ${days ? new Date(Date.now() + days * 86_400_000) : null})
    RETURNING *`;
  return present(link!);
}

export async function listLinks(auth: AuthContext, workspaceId: string, filter: { projectId?: string | undefined; assetKind?: AssetKind | undefined; assetRef?: string | undefined }) {
  await workspaceAccess(auth, workspaceId, false);
  const rows = await sql<LinkRow[]>`
    SELECT * FROM share_links WHERE workspace_id = ${workspaceId}
      ${filter.projectId ? sql`AND project_id = ${filter.projectId}` : sql``}
      ${filter.assetKind ? sql`AND asset_kind = ${filter.assetKind}` : sql``}
      ${filter.assetRef !== undefined ? sql`AND asset_ref = ${filter.assetRef}` : sql``}
    ORDER BY created_at DESC LIMIT 300`;
  return { links: rows.map(present), defaultDays: await defaultDays(auth.userId) };
}

async function ownLink(auth: AuthContext, workspaceId: string, linkId: string): Promise<LinkRow> {
  await workspaceAccess(auth, workspaceId, true);
  const [link] = await sql<LinkRow[]>`SELECT * FROM share_links WHERE id = ${linkId} AND workspace_id = ${workspaceId}`;
  if (!link) throw AppError.notFound('Link');
  return link;
}

/** A new URL for the same link: the old one stops working at once. */
export async function rotateLink(auth: AuthContext, workspaceId: string, linkId: string) {
  const link = await ownLink(auth, workspaceId, linkId);
  if (link.revokedAt) throw AppError.badRequest('This link was revoked. Make a new one.');
  const [updated] = await sql<LinkRow[]>`UPDATE share_links SET key_version = key_version + 1 WHERE id = ${link.id} RETURNING *`;
  return present(updated!);
}

export async function updateExpiry(auth: AuthContext, workspaceId: string, linkId: string, days: number | null) {
  const link = await ownLink(auth, workspaceId, linkId);
  const [updated] = await sql<LinkRow[]>`
    UPDATE share_links SET expires_at = ${days ? new Date(Date.now() + days * 86_400_000) : null} WHERE id = ${link.id} RETURNING *`;
  return present(updated!);
}

export async function revokeLink(auth: AuthContext, workspaceId: string, linkId: string) {
  const link = await ownLink(auth, workspaceId, linkId);
  const [updated] = await sql<LinkRow[]>`UPDATE share_links SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${link.id} RETURNING *`;
  return present(updated!);
}

/** Ends every live link the user made (in every workspace). */
export async function expireAll(auth: AuthContext) {
  const rows = await sql<{ id: string }[]>`
    UPDATE share_links SET expires_at = now() WHERE created_by_id = ${auth.userId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id`;
  return { expired: rows.length };
}

/* ------------------------------------------------------------------ public side */

async function openLink(token: string): Promise<{ link: LinkRow; resolved: Resolved }> {
  const payload = decodeShareToken(token);
  const [link] = payload ? await sql<LinkRow[]>`SELECT * FROM share_links WHERE id = ${payload.l}` : [];
  // One answer for every failure: a guesser learns nothing about which part was wrong.
  const gone = (): AppError => new AppError(404, 'NOT_FOUND', 'This link has expired or does not exist. Ask the creator for a new one.');
  if (!payload || !link || link.mode !== payload.m || link.keyVersion !== payload.v || stateOf(link) !== 'ACTIVE') throw gone();
  const resolved = await resolve(link);
  if (!resolved) throw gone();
  return { link, resolved };
}

export async function publicInfo(token: string) {
  const { link, resolved } = await openLink(token);
  await sql`UPDATE share_links SET views = views + 1, last_opened_at = now() WHERE id = ${link.id}`;
  return {
    title: link.title,
    kind: resolved.kindLabel,
    mode: link.mode,
    canDownload: link.mode === 'DOWNLOAD',
    durationSec: resolved.durationSec,
    posterUrl: resolved.posterKey ? await readUrl(resolved.posterKey) : null,
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
}

export async function publicStream(token: string, range: string | undefined): Promise<{ body: Readable; status: number; headers: Record<string, string> }> {
  const { resolved } = await openLink(token);
  const object = await getObjectRange(resolved.key, range);
  if (!object) throw new AppError(404, 'NOT_FOUND', 'This video is no longer available.');
  const headers: Record<string, string> = {
    'Content-Type': object.contentType ?? 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
  };
  if (object.length !== undefined) headers['Content-Length'] = String(object.length);
  if (object.contentRange) headers['Content-Range'] = object.contentRange;
  return { body: object.body, status: object.contentRange ? 206 : 200, headers };
}

/** DOWNLOAD links only: a short-lived signed URL with the file name. */
export async function publicDownload(token: string): Promise<string> {
  const { link, resolved } = await openLink(token);
  if (link.mode !== 'DOWNLOAD') throw new AppError(403, 'FORBIDDEN', 'This link is view-only.');
  await sql`UPDATE share_links SET downloads = downloads + 1, last_opened_at = now() WHERE id = ${link.id}`;
  return readUrl(resolved.key, resolved.filename);
}
