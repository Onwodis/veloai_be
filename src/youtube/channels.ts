/**
 * YouTube channels: connect with Google OAuth (offline access, so films publish while nobody is
 * signed in), list, disconnect, and the YouTube Data API calls (resumable upload + thumbnail).
 *
 * The OAuth client comes from the credential vault / .env: YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET.
 * Its redirect URI must be `${API_PUBLIC_URL}/api/v1/youtube/oauth/callback`.
 * Refresh tokens are stored encrypted (utils/encryption).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { env } from '../config/env.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { requireMembership } from '../services/workspace.service.js';
import { sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { secret } from '../vault/secrets.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const STATE_TTL_MS = 15 * 60_000;

const apiBase = (): string => (env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '');
export const redirectUri = (): string => `${apiBase()}/api/v1/youtube/oauth/callback`;

function client(): { id: string; secret: string } {
  const id = secret('YOUTUBE_CLIENT_ID');
  const key = secret('YOUTUBE_CLIENT_SECRET');
  if (!id || !key) throw new AppError(503, 'INTERNAL_ERROR', 'YouTube is not connected to the platform yet: the super admin adds the Google OAuth client in Credentials.');
  return { id, secret: key };
}

export const youtubeConfigured = (): boolean => Boolean(secret('YOUTUBE_CLIENT_ID') && secret('YOUTUBE_CLIENT_SECRET'));

/* ------------------------------------------------------------------ OAuth state (signed, short-lived) */

const sign = (payload: string): string => createHmac('sha256', env.JWT_ACCESS_SECRET).update(`yt-oauth:${payload}`).digest('base64url');

function makeState(workspaceId: string, userId: string): string {
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, u: userId, e: Date.now() + STATE_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readState(state: string): { workspaceId: string; userId: string } {
  const [payload, mac] = state.split('.');
  if (!payload || !mac) throw AppError.badRequest('That YouTube link is broken. Start again from YouTube films.');
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw AppError.badRequest('That YouTube link is not valid. Start again from YouTube films.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { w: string; u: string; e: number };
  if (data.e < Date.now()) throw AppError.badRequest('That YouTube link expired. Start again from YouTube films.');
  return { workspaceId: data.w, userId: data.u };
}

export async function connectUrl(auth: AuthContext, workspaceId: string): Promise<string> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  const { id } = client();
  const query = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: makeState(workspaceId, auth.userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!response.ok || !data.access_token) {
    const reason = data.error_description ?? data.error ?? `HTTP ${response.status}`;
    throw new AppError(data.error === 'invalid_grant' ? 401 : 502, 'BAD_REQUEST', `Google refused the YouTube sign-in: ${reason}`);
  }
  return { access_token: data.access_token, ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}), expires_in: data.expires_in ?? 3600 };
}

/** The OAuth callback: swaps the code for tokens, reads the channel and saves it. Returns where to send the browser. */
export async function finishConnect(code: string, state: string): Promise<string> {
  const back = `${env.WEB_APP_URL}/dashboard/youtube`;
  const { workspaceId, userId } = readState(state);
  const { id, secret: key } = client();
  const tokens = await tokenRequest({ code, client_id: id, client_secret: key, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  if (!tokens.refresh_token) return `${back}?youtube=no-offline`;
  const channels = await youtubeApi<{ items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }[] }>(tokens.access_token, 'channels?part=snippet&mine=true');
  const channel = channels.items?.[0];
  if (!channel) return `${back}?youtube=no-channel`;
  await sql`
    INSERT INTO yt_channels (workspace_id, connected_by, channel_id, title, thumbnail_url, refresh_token)
    VALUES (${workspaceId}, ${userId}, ${channel.id}, ${channel.snippet.title}, ${channel.snippet.thumbnails?.default?.url ?? null}, ${encryptSecret(tokens.refresh_token)})
    ON CONFLICT (workspace_id, channel_id) DO UPDATE SET title = EXCLUDED.title, thumbnail_url = EXCLUDED.thumbnail_url,
      refresh_token = EXCLUDED.refresh_token, connected_by = EXCLUDED.connected_by, status = 'OK', last_error = NULL, updated_at = now()`;
  logger.info({ workspaceId, channel: channel.id }, 'youtube channel connected');
  return `${back}?youtube=connected`;
}

/* ------------------------------------------------------------------ channels */

export interface ChannelView {
  id: string;
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
}

export async function listChannels(auth: AuthContext, workspaceId: string): Promise<ChannelView[]> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId);
  return sql<ChannelView[]>`
    SELECT id, channel_id, title, thumbnail_url, status, last_error, created_at FROM yt_channels WHERE workspace_id = ${workspaceId} ORDER BY created_at`;
}

export async function disconnect(auth: AuthContext, workspaceId: string, id: string): Promise<void> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  const [row] = await sql<{ refreshToken: string }[]>`DELETE FROM yt_channels WHERE id = ${id} AND workspace_id = ${workspaceId} RETURNING refresh_token`;
  if (!row) throw AppError.notFound('Channel');
  // Also revoke the grant at Google (best effort).
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decryptSecret(row.refreshToken))}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}

/* ------------------------------------------------------------------ YouTube Data API */

async function accessToken(channelRowId: string): Promise<string> {
  const [row] = await sql<{ refreshToken: string }[]>`SELECT refresh_token FROM yt_channels WHERE id = ${channelRowId}`;
  if (!row) throw new AppError(409, 'CONFLICT', 'The YouTube channel was disconnected.');
  const { id, secret: key } = client();
  try {
    const tokens = await tokenRequest({ refresh_token: decryptSecret(row.refreshToken), client_id: id, client_secret: key, grant_type: 'refresh_token' });
    return tokens.access_token;
  } catch (error) {
    await sql`UPDATE yt_channels SET status = 'EXPIRED', last_error = ${(error as Error).message.slice(0, 300)}, updated_at = now() WHERE id = ${channelRowId}`;
    throw new AppError(409, 'CONFLICT', 'The YouTube channel needs to be connected again (Google ended the access).');
  }
}

async function youtubeApi<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw new AppError(502, 'BAD_REQUEST', `YouTube said: ${data.error?.message ?? `HTTP ${response.status}`}`);
  return data;
}

export interface UploadInput {
  channelRowId: string;
  file: string;
  thumbnail: string | null;
  title: string;
  description: string;
  tags: string[];
  privacy: 'private' | 'unlisted' | 'public';
  /** For a scheduled public premiere: YouTube publishes it at this time (the upload goes in private). */
  publishAt?: Date | undefined;
  language: string;
}

/** Uploads the film (resumable upload, one PUT) and sets its thumbnail. Returns the video id. */
export async function uploadVideo(input: UploadInput): Promise<{ videoId: string; thumbnailSet: boolean }> {
  const token = await accessToken(input.channelRowId);
  const size = (await stat(input.file)).size;
  const metadata = {
    snippet: { title: input.title.slice(0, 100), description: input.description.slice(0, 4900), tags: input.tags.slice(0, 30), categoryId: '1', defaultLanguage: input.language.slice(0, 2).toLowerCase() },
    status: { privacyStatus: input.publishAt ? 'private' : input.privacy, ...(input.publishAt ? { publishAt: input.publishAt.toISOString() } : {}), selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  };
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4' },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(60_000),
  });
  const location = start.headers.get('location');
  if (!start.ok || !location) {
    const detail = ((await start.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
    throw new AppError(502, 'BAD_REQUEST', `YouTube refused the upload: ${detail ?? `HTTP ${start.status}`}`);
  }
  const handle = await open(input.file, 'r');
  try {
    const upload = await fetch(location, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      body: handle.readableWebStream() as unknown as RequestInit['body'],
      // Node needs this for a streamed request body.
      ...({ duplex: 'half' } as Record<string, unknown>),
      signal: AbortSignal.timeout(60 * 60_000),
    });
    const video = (await upload.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!upload.ok || !video.id) throw new AppError(502, 'BAD_REQUEST', `The YouTube upload failed: ${video.error?.message ?? `HTTP ${upload.status}`}`);
    let thumbnailSet = false;
    if (input.thumbnail) {
      // Custom thumbnails need a verified channel; a refusal does not fail the publish.
      const image = await readFile(input.thumbnail);
      const response = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${video.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
        body: image,
        signal: AbortSignal.timeout(60_000),
      });
      thumbnailSet = response.ok;
      if (!response.ok) logger.warn({ videoId: video.id, status: response.status }, 'youtube thumbnail not set (channel may need verifying)');
    }
    return { videoId: video.id, thumbnailSet };
  } finally {
    await handle.close();
  }
}
