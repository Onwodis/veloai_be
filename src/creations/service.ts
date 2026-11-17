/**
 * Creations: one-prompt images and videos ("a video of @me running on Lekki
 * beach at sunrise"), and enhancements of an uploaded photo from written
 * instructions.
 *
 * Gate, in order (nothing is generated unless both pass):
 *   1. storage   the estimated output must fit the user's quota (402 STORAGE_FULL)
 *   2. tokens    the estimate is held on the workspace (402 INSUFFICIENT_TOKENS)
 * Only the steps that produced output are charged.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../middleware/authenticate.js';
import { meContext, mentionsMe } from '../likeness/service.js';
import { ACTIVE_CREATION, type CreationMode, type CreationOptions, type CreationRow } from '../likeness/types.js';
import { trackUpload } from '../storage/ledger.js';
import { withUser } from '../storage/rls.js';
import { assertStorage, SIZE_ESTIMATE, storageStatus } from '../storage/service.js';
import { deleteObject, deletePrefix, headObject, keys, presignPut, readUrl } from '../services/storage.service.js';
import { getWallet, releaseSystem, reserveTokens } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import { directorAvailable } from '../studio/director.js';
import * as fal from '../studio/fal.js';
import { enqueueCreation } from '../studio/queue.js';
import { getStudioSettings, pickDuration, type StudioSettings } from '../studio/settings.js';
import { json } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface CreateInput {
  mode: CreationMode;
  prompt: string;
  aspect: '16:9' | '9:16' | '1:1';
  durationSec?: number | undefined;
  sourceKey?: string | undefined;
  upscale: boolean;
  direct: boolean;
  dryRun: boolean;
  /** Super admin only (platform marketing): skip the watermark. */
  brandFree?: boolean;
}

/* ------------------------------------------------------------------ estimate */

function costs(settings: StudioSettings, input: CreateInput, usesMe: boolean, direct: boolean) {
  const { costs: c, models } = settings;
  const direction = direct ? c.director : 0;
  const still = input.mode === 'ENHANCE' ? c.imageEdit : input.mode === 'IMAGE' ? c.image : usesMe ? c.keyframe : 0;
  const seconds = input.mode === 'VIDEO' ? pickDuration(usesMe ? models.imageToVideo : models.textToVideo, input.durationSec ?? 5).seconds : 0;
  const video = Math.ceil(seconds) * c.videoPerSecond;
  const upscale = input.mode !== 'VIDEO' && input.upscale && models.imageUpscale.enabled ? c.imageUpscale : 0;
  const bytes = input.mode === 'VIDEO' ? (usesMe ? SIZE_ESTIMATE.keyframe : 0) + seconds * SIZE_ESTIMATE.videoPerSecond + 512 * 1024 : SIZE_ESTIMATE.image * (upscale ? 3 : 1);
  return { direction, image: still, video, upscale, total: direction + still + video + upscale, bytes: Math.round(bytes), seconds };
}

/* ------------------------------------------------------------------ views */

async function creationView(row: CreationRow) {
  const isVideo = row.mode === 'VIDEO';
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    mode: row.mode,
    prompt: row.prompt,
    direction: row.direction,
    title: row.options.title ?? null,
    usesMe: row.usesMe,
    aspect: row.aspect,
    durationSec: row.durationSec,
    status: row.status,
    cost: row.cost,
    error: row.error,
    engine: row.engine,
    sizeBytes: row.outputSize ? Number(row.outputSize) : null,
    url: row.outputKey ? await readUrl(row.outputKey) : null,
    downloadUrl: row.outputKey ? await readUrl(row.outputKey, `${(row.options.title ?? row.mode.toLowerCase()).slice(0, 50)}.${isVideo ? 'mp4' : 'png'}`) : null,
    thumbUrl: row.thumbKey ? await readUrl(row.thumbKey) : null,
    sourceUrl: row.sourceKey ? await readUrl(row.sourceKey) : null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
export type CreationView = Awaited<ReturnType<typeof creationView>>;

/* ------------------------------------------------------------------ uploads (photo to enhance) */

export async function createUpload(auth: AuthContext, input: { fileName: string; contentType: string; size: number }) {
  if (!IMAGE_TYPES.has(input.contentType)) throw AppError.badRequest('Upload a JPG, PNG or WebP picture.');
  if (input.size > 25 * 1024 * 1024) throw AppError.badRequest('Pictures can be up to 25 MB.');
  await assertStorage(auth, input.size, 'this upload');
  const key = keys.creationSource(auth.userId, randomUUID(), input.fileName);
  return { key, uploadUrl: await presignPut(key, input.contentType) };
}

export async function completeUpload(auth: AuthContext, key: string) {
  if (!key.startsWith(`${keys.user(auth.userId)}/uploads/`)) throw AppError.forbidden('That upload is not yours.');
  const head = await headObject(key);
  if (!head) throw AppError.badRequest('The picture has not finished uploading.');
  await trackUpload(key, head.size, () => deleteObject(key));
  return { key, url: await readUrl(key) };
}

/* ------------------------------------------------------------------ create */

export async function createCreation(auth: AuthContext, workspaceId: string, input: CreateInput) {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  const settings = await getStudioSettings();
  const usesMe = mentionsMe(input.prompt);
  const me = usesMe ? await meContext(auth.userId) : null;
  if (input.mode === 'ENHANCE') {
    if (!input.sourceKey) throw AppError.badRequest('Upload the picture to enhance first.');
    if (!input.sourceKey.startsWith(`${keys.user(auth.userId)}/uploads/`) && !input.sourceKey.startsWith(`${keys.user(auth.userId)}/creations/`)) throw AppError.forbidden('That picture is not yours.');
  }
  const direct = input.direct && (await directorAvailable());
  const estimate = costs(settings, input, usesMe, direct);
  const storage = await storageStatus(auth);
  const wallet = await getWallet(workspaceId);
  const preflight = {
    tokens: estimate.total,
    breakdown: { direction: estimate.direction, image: estimate.image, video: estimate.video, upscale: estimate.upscale },
    bytes: estimate.bytes,
    seconds: estimate.seconds,
    usesMe,
    likenessReady: Boolean(me),
    identityModel: Boolean(me?.lora),
    storage: { availableBytes: storage.availableBytes, quotaBytes: storage.quotaBytes, level: storage.level, fits: auth.role === 'SUPER_ADMIN' || estimate.bytes <= storage.availableBytes },
    tokensAvailable: wallet.available,
    generationAvailable: fal.falConfigured(),
  };
  if (input.dryRun) return { preflight, creation: null };

  if (usesMe && !me) throw AppError.badRequest('Your prompt mentions @me, but your likeness isn’t ready. Build it on the “My likeness” page first.');
  if (!fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', 'Generation is not configured yet (no fal.ai key).');
  if (input.mode === 'ENHANCE' && !(await headObject(input.sourceKey!))) throw AppError.badRequest('The picture to enhance is no longer in storage. Upload it again.');

  // 1. storage, 2. tokens. Neither → nothing runs.
  await assertStorage(auth, estimate.bytes, 'this creation');
  const { reservation } = await reserveTokens(auth, workspaceId, `CREATE_${input.mode}`, estimate.total, { usesMe, seconds: estimate.seconds });
  const options: CreationOptions = {
    upscale: input.mode !== 'VIDEO' && input.upscale,
    direct,
    costs: { direction: estimate.direction, image: estimate.image, video: estimate.video, upscale: estimate.upscale },
    ...(input.brandFree && auth.role === 'SUPER_ADMIN' ? { brandFree: true } : {}),
  };
  try {
    const [row] = await withUser(auth, (tx) => tx<CreationRow[]>`
      INSERT INTO creations (user_id, workspace_id, mode, prompt, uses_me, aspect, duration_sec, source_key, options, cost, reservation_id)
      VALUES (${auth.userId}, ${workspaceId}, ${input.mode}, ${input.prompt}, ${usesMe}, ${input.aspect}, ${input.mode === 'VIDEO' ? estimate.seconds : null},
        ${input.sourceKey ?? null}, ${json(options)}, ${estimate.total}, ${reservation.id})
      RETURNING *`);
    await enqueueCreation(row!.id);
    return { preflight, creation: await creationView(row!) };
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ reads + lifecycle */

export async function listCreations(auth: AuthContext, page: number, pageSize: number) {
  const { rows, total } = await withUser(auth, async (tx) => ({
    rows: await tx<CreationRow[]>`SELECT * FROM creations WHERE user_id = ${auth.userId} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    total: Number((await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM creations WHERE user_id = ${auth.userId}`)[0]?.count ?? 0),
  }));
  return { items: await Promise.all(rows.map(creationView)), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

async function own(auth: AuthContext, id: string): Promise<CreationRow> {
  const [row] = await withUser(auth, (tx) => tx<CreationRow[]>`SELECT * FROM creations WHERE id = ${id}`);
  if (!row) throw AppError.notFound('Creation');
  return row;
}

export async function getCreation(auth: AuthContext, id: string) {
  return creationView(await own(auth, id));
}

export async function cancelCreation(auth: AuthContext, id: string) {
  const row = await own(auth, id);
  if (!ACTIVE_CREATION.includes(row.status)) throw AppError.conflict('This creation is not running.');
  await withUser(auth, (tx) => tx`UPDATE creations SET status = 'CANCELED', finished_at = now() WHERE id = ${id}`);
  if (row.falRequest) await fal.cancel(row.falRequest).catch(() => undefined);
  if (row.reservationId) await releaseSystem(row.reservationId, row.workspaceId).catch(() => undefined);
  return getCreation(auth, id);
}

export async function deleteCreation(auth: AuthContext, id: string): Promise<void> {
  const row = await own(auth, id);
  if (ACTIVE_CREATION.includes(row.status)) throw AppError.conflict('Cancel it first.');
  await withUser(auth, (tx) => tx`DELETE FROM creations WHERE id = ${id}`);
  await deletePrefix(`${keys.user(auth.userId)}/creations/${id}/`);
}
