/**
 * Platform versions of one ad master: the same cut reframed for every feed
 * (9:16 Reels / TikTok / Shorts, 1:1 feed, 4:5 Instagram / Facebook feed,
 * 16:9 YouTube / TV). Local ffmpeg only: no tokens.
 *
 *   blur  the whole picture over a blurred fill of itself (nothing is cut off:
 *         on-screen text and the end card stay readable)
 *   crop  fills the new frame, centre crop
 *
 * Versions render one after another in the background; each entry carries the
 * master it was made from, so a re-master shows them as out of date. A version
 * made again replaces its old file. Interrupted renders (server restart) show
 * as failed after a while and can simply be made again.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg } from '../media/ffmpeg.js';
import { publishProgress } from '../realtime/events.js';
import { deleteObject, downloadToFile, keys, readUrl, uploadFile } from '../services/storage.service.js';
import { json, sql } from '../studio/sql.js';
import { logger } from '../utils/logger.js';
import type { VersionAspect } from './schemas.js';

export interface AdVersion {
  aspect: VersionAspect;
  fit: 'blur' | 'crop';
  status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';
  masterKey: string;
  key: string | null;
  sizeBytes: number | null;
  error: string | null;
  at: string;
}

const SIZES: Record<VersionAspect, [number, number]> = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
export const VERSION_LABEL: Record<VersionAspect, string> = {
  '9:16': 'Reels · TikTok · Shorts',
  '1:1': 'Square feed',
  '4:5': 'Instagram / Facebook feed',
  '16:9': 'YouTube · TV · web',
};
/** A render still "running" after this long was interrupted (restart). */
const STALE_MS = 20 * 60_000;

export const isStale = (version: AdVersion): boolean => (version.status === 'RUNNING' || version.status === 'QUEUED') && Date.now() - Date.parse(version.at) > STALE_MS;

async function load(projectId: string): Promise<AdVersion[]> {
  const [row] = await sql<{ versions: AdVersion[] }[]>`SELECT versions FROM ad_projects WHERE project_id = ${projectId}`;
  return row?.versions ?? [];
}

async function patch(projectId: string, aspect: VersionAspect, change: Partial<AdVersion>): Promise<void> {
  const versions = (await load(projectId)).map((version) => (version.aspect === aspect ? { ...version, ...change, at: new Date().toISOString() } : version));
  await sql`UPDATE ad_projects SET versions = ${json(versions)} WHERE project_id = ${projectId}`;
}

function filter(aspect: VersionAspect, fit: 'blur' | 'crop'): string {
  const [width, height] = SIZES[aspect];
  if (fit === 'crop') return `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p[v]`;
  const blur = Math.round(Math.min(width, height) / 25);
  return (
    `[0:v]split=2[a][b];[a]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=${blur}:2,eq=brightness=-0.08[bg];` +
    `[b]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`
  );
}

/** Queues the versions (replacing any of the same aspect) and starts rendering them. */
export async function queueVersions(project: { id: string; workspaceId: string; outputKey: string }, aspects: VersionAspect[], fit: 'blur' | 'crop'): Promise<void> {
  const now = new Date().toISOString();
  const current = await load(project.id);
  const queued: AdVersion[] = aspects.map((aspect) => ({ aspect, fit, status: 'QUEUED', masterKey: project.outputKey, key: current.find((item) => item.aspect === aspect)?.key ?? null, sizeBytes: null, error: null, at: now }));
  const versions = [...current.filter((item) => !aspects.includes(item.aspect)), ...queued];
  await sql`UPDATE ad_projects SET versions = ${json(versions)} WHERE project_id = ${project.id}`;
  void render(project).catch((error: unknown) => logger.error({ err: error, projectId: project.id }, 'ad versions failed'));
}

async function render(project: { id: string; workspaceId: string; outputKey: string }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ad-versions-'));
  const emit = (detail: string): void => publishProgress({ kind: 'studio', workspaceId: project.workspaceId, projectId: project.id, detail });
  try {
    const master = join(dir, 'master.mp4');
    await downloadToFile(project.outputKey, master);
    for (;;) {
      const next = (await load(project.id)).find((version) => version.status === 'QUEUED');
      if (!next) break;
      await patch(project.id, next.aspect, { status: 'RUNNING' });
      emit(`version ${next.aspect}`);
      const file = join(dir, `${next.aspect.replace(':', 'x')}.mp4`);
      try {
        await ffmpeg([
          '-i', master, '-filter_complex', filter(next.aspect, next.fit), '-map', '[v]', '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-movflags', '+faststart', file,
        ]);
        const key = `${keys.studio(project.workspaceId, project.id)}/versions/${Date.now()}-${next.aspect.replace(':', 'x')}.mp4`;
        await uploadFile(key, file, 'video/mp4');
        if (next.key && next.key !== key) await deleteObject(next.key).catch(() => undefined);
        await patch(project.id, next.aspect, { status: 'READY', key, sizeBytes: (await stat(file)).size, error: null });
      } catch (error) {
        logger.warn({ err: error, projectId: project.id, aspect: next.aspect }, 'ad version failed');
        await patch(project.id, next.aspect, { status: 'FAILED', error: 'This version could not be made. Try again.' });
      } finally {
        await rm(file, { force: true }).catch(() => undefined);
        emit(`version ${next.aspect} done`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What the ad view shows: signed links, and whether each version is from the current master. */
export async function versionsView(versions: AdVersion[], outputKey: string | null, title: string) {
  return Promise.all(
    versions.map(async (version) => {
      const stale = isStale(version);
      const ready = version.status === 'READY' && version.key;
      return {
        aspect: version.aspect,
        label: VERSION_LABEL[version.aspect],
        fit: version.fit,
        status: stale ? ('FAILED' as const) : version.status,
        error: stale ? 'Interrupted. Make it again.' : version.error,
        sizeBytes: version.sizeBytes,
        outdated: Boolean(outputKey && version.masterKey !== outputKey),
        videoUrl: ready ? await readUrl(version.key!) : null,
        downloadUrl: ready ? await readUrl(version.key!, `${title} (${version.aspect.replace(':', 'x')}).mp4`) : null,
        at: version.at,
      };
    }),
  );
}
