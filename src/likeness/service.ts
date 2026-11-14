/**
 * "My likeness": each user's reference photos/videos (max 10, enforced by the
 * database) and the AI-built context the rest of the app uses for @me:
 *
 *   profile   face, skeletal frame, body, proportions, height, posture, gait,
 *             hair, wardrobe (Claude, from photos + frames sampled from videos)
 *   refs      the images that best show face and full body
 *   voice     a cleaned sample of the user's voice (from their videos)
 *   model     a personal identity model (LoRA) trained on fal.ai, so @me
 *             renders as exactly this person
 *
 * Everything is per user, behind row-level security; building it is
 * token-charged (to the workspace the user picks) and storage-checked.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { assertStorage, SIZE_ESTIMATE } from '../storage/service.js';
import { trackUpload } from '../storage/ledger.js';
import { withUser } from '../storage/rls.js';
import { deleteObject, deletePrefix, headObject, keys, presignPut, readUrl } from '../services/storage.service.js';
import { releaseSystem, reserveTokens } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import * as fal from '../studio/fal.js';
import { enqueueLikeness } from '../studio/queue.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import type { LikenessAssetRow, LikenessProfile, LikenessRow } from './types.js';

export const MAX_LIKENESS_ASSETS = 10;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const MAX_PHOTO = 25 * 1024 * 1024;
const MAX_VIDEO = 200 * 1024 * 1024;

/* ------------------------------------------------------------------ views */

async function assetView(asset: LikenessAssetRow) {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    contentType: asset.contentType,
    size: Number(asset.size),
    meta: asset.meta,
    status: asset.status,
    url: asset.status === 'READY' ? await readUrl(asset.key) : null,
    createdAt: asset.createdAt.toISOString(),
  };
}

async function view(auth: AuthContext) {
  const { profile, assets } = await withUser(auth, async (tx) => ({
    profile: (await tx<LikenessRow[]>`SELECT * FROM likeness_profiles WHERE user_id = ${auth.userId}`)[0] ?? null,
    assets: await tx<LikenessAssetRow[]>`SELECT * FROM likeness_assets WHERE user_id = ${auth.userId} ORDER BY created_at`,
  }));
  const settings = await getStudioSettings();
  const ready = assets.filter((asset) => asset.status === 'READY');
  return {
    status: profile?.status ?? 'EMPTY',
    consentAt: profile?.consentAt?.toISOString() ?? null,
    heightCm: profile?.heightCm ?? null,
    profile: profile?.profile ?? null,
    references: await Promise.all((profile?.referenceKeys ?? []).map((key) => readUrl(key))),
    voiceUrl: profile?.voiceKey ? await readUrl(profile.voiceKey) : null,
    model: profile?.lora ? { status: profile.lora.status, trainedAt: profile.lora.trainedAt ?? null, triggerWord: profile.lora.triggerWord } : null,
    engine: profile?.engine ?? null,
    error: profile?.error ?? null,
    analyzedAt: profile?.analyzedAt?.toISOString() ?? null,
    tokensCharged: profile?.tokensCharged ?? 0,
    assets: await Promise.all(assets.map(assetView)),
    limits: { maxAssets: MAX_LIKENESS_ASSETS, maxPhotoBytes: MAX_PHOTO, maxVideoBytes: MAX_VIDEO },
    rates: {
      analysis: settings.costs.likenessAnalysis,
      training: settings.models.likenessTraining.enabled ? settings.costs.likenessTraining : 0,
      trainingAvailable: settings.models.likenessTraining.enabled && fal.falConfigured(),
    },
    readyAssets: ready.length,
    canBuild: ready.length > 0,
  };
}
export type LikenessView = Awaited<ReturnType<typeof view>>;

export const getLikeness = (auth: AuthContext) => view(auth);

const running = (row: Pick<LikenessRow, 'status'> | null | undefined): boolean => row?.status === 'ANALYZING' || row?.status === 'TRAINING';

async function currentProfile(auth: AuthContext): Promise<LikenessRow | undefined> {
  return withUser(auth, async (tx) => (await tx<LikenessRow[]>`SELECT * FROM likeness_profiles WHERE user_id = ${auth.userId}`)[0]);
}

/* ------------------------------------------------------------------ assets */

export async function createAsset(auth: AuthContext, input: { fileName: string; contentType: string; size: number }) {
  const kind = PHOTO_TYPES.has(input.contentType) ? 'PHOTO' : VIDEO_TYPES.has(input.contentType) ? 'VIDEO' : null;
  if (!kind) throw AppError.badRequest('Upload JPG, PNG or WebP photos, or MP4, MOV or WebM videos.');
  if (input.size > (kind === 'PHOTO' ? MAX_PHOTO : MAX_VIDEO)) throw AppError.badRequest(kind === 'PHOTO' ? 'Photos can be up to 25 MB.' : 'Videos can be up to 200 MB.');
  if (running(await currentProfile(auth))) throw AppError.conflict('Your likeness is being built. Wait for it to finish before changing your files.');
  // Storage first: nothing is uploaded that can't be kept.
  await assertStorage(auth, input.size, 'this upload');
  try {
    const asset = await withUser(auth, async (tx) => {
      const [row] = await tx<LikenessAssetRow[]>`
        INSERT INTO likeness_assets (user_id, kind, key, name, content_type, size)
        VALUES (${auth.userId}, ${kind}, '', ${input.fileName.slice(0, 255)}, ${input.contentType}, ${input.size}) RETURNING *`;
      const key = keys.likenessAsset(auth.userId, row!.id, input.fileName);
      await tx`UPDATE likeness_assets SET key = ${key} WHERE id = ${row!.id}`;
      return { ...row!, key };
    });
    return { asset: await assetView(asset), uploadUrl: await presignPut(asset.key, input.contentType) };
  } catch (error) {
    if ((error as { message?: string }).message === 'LIKENESS_LIMIT') throw AppError.badRequest(`Your likeness can have up to ${MAX_LIKENESS_ASSETS} photos and videos. Remove one first.`);
    throw error;
  }
}

export async function completeAsset(auth: AuthContext, assetId: string, meta: { width?: number | undefined; height?: number | undefined; durationSec?: number | undefined }) {
  const [asset] = await withUser(auth, (tx) => tx<LikenessAssetRow[]>`SELECT * FROM likeness_assets WHERE id = ${assetId}`);
  if (!asset) throw AppError.notFound('File');
  const head = await headObject(asset.key);
  if (!head) throw AppError.badRequest('The file has not finished uploading.');
  if (head.size !== Number(asset.size)) throw AppError.badRequest('The uploaded file size does not match. Upload it again.');
  // The database refuses the file if it would exceed the quota; it is then removed from storage.
  await trackUpload(asset.key, head.size, async () => {
    await deleteObject(asset.key);
    await withUser(auth, (tx) => tx`DELETE FROM likeness_assets WHERE id = ${assetId}`);
  });
  await withUser(auth, (tx) => tx`UPDATE likeness_assets SET status = 'READY', meta = ${json({ ...asset.meta, ...meta })} WHERE id = ${assetId}`);
  return view(auth);
}

export async function deleteAsset(auth: AuthContext, assetId: string) {
  if (running(await currentProfile(auth))) throw AppError.conflict('Your likeness is being built. Wait for it to finish before changing your files.');
  const [asset] = await withUser(auth, (tx) => tx<LikenessAssetRow[]>`DELETE FROM likeness_assets WHERE id = ${assetId} RETURNING *`);
  if (!asset) throw AppError.notFound('File');
  if (asset.key) await deleteObject(asset.key);
  await deletePrefix(keys.likenessDerived(auth.userId, `${assetId}-`));
  return view(auth);
}

/* ------------------------------------------------------------------ build */

/**
 * Starts (or rebuilds) the likeness: consent is recorded, storage for the
 * derived frames/voice is checked, and tokens for analysis + training are
 * held on the chosen workspace. The job charges only what actually ran.
 */
export async function buildLikeness(auth: AuthContext, input: { workspaceId: string; consent: true; heightCm?: number | undefined; selfDescription?: string | undefined; train: boolean }, ip: string | null) {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, input.workspaceId, ['OWNER', 'EDITOR']);
  const existing = await currentProfile(auth);
  if (running(existing)) throw AppError.conflict('Your likeness is already being built.');
  const assets = await withUser(auth, (tx) => tx<LikenessAssetRow[]>`SELECT * FROM likeness_assets WHERE user_id = ${auth.userId} AND status = 'READY'`);
  if (assets.length === 0) throw AppError.badRequest('Upload at least one clear photo of yourself first.');
  const settings = await getStudioSettings();
  const train = input.train && settings.models.likenessTraining.enabled;
  if (train && !fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', 'Identity training is not available yet (no fal.ai key). Build without training, or ask the admin to add the key.');

  // Storage: video frames + voice sample are kept with your likeness.
  const videos = assets.filter((asset) => asset.kind === 'VIDEO').length;
  await assertStorage(auth, videos * 6 * 400 * 1024 + (videos ? 3 * 1024 * 1024 : 0) + SIZE_ESTIMATE.image, 'your likeness');
  const total = settings.costs.likenessAnalysis + (train ? settings.costs.likenessTraining : 0);
  const { reservation } = await reserveTokens(auth, input.workspaceId, 'LIKENESS', total, { train, assets: assets.length });
  try {
    await withUser(auth, (tx) => tx`
      INSERT INTO likeness_profiles (user_id, status, consent_at, consent_ip, height_cm, workspace_id, reservation_id, error, lora, profile)
      VALUES (${auth.userId}, 'ANALYZING', now(), ${ip}, ${input.heightCm ?? null}, ${input.workspaceId}, ${reservation.id}, NULL,
        ${train ? json({ status: 'PENDING', triggerWord: 'vlxperson' }) : null}, ${input.selfDescription ? json({ selfDescription: input.selfDescription }) : null})
      ON CONFLICT (user_id) DO UPDATE SET status = 'ANALYZING', consent_at = now(), consent_ip = EXCLUDED.consent_ip, height_cm = EXCLUDED.height_cm,
        workspace_id = EXCLUDED.workspace_id, reservation_id = EXCLUDED.reservation_id, error = NULL, fal_request = NULL,
        lora = CASE WHEN ${train} THEN ${json({ status: 'PENDING', triggerWord: 'vlxperson' })}::jsonb ELSE likeness_profiles.lora END,
        profile = COALESCE(likeness_profiles.profile, '{}'::jsonb) || COALESCE(EXCLUDED.profile, '{}'::jsonb), updated_at = now()`);
    await enqueueLikeness(auth.userId);
  } catch (error) {
    await releaseSystem(reservation.id, input.workspaceId).catch(() => undefined);
    throw error;
  }
  logger.info({ userId: auth.userId, train, assets: assets.length }, 'likeness build started');
  return view(auth);
}

/** The user's corrections to the written profile ("I'm 1.88 m", "I walk with a slight bounce"). */
export async function updateProfile(auth: AuthContext, patch: { heightCm?: number | null | undefined; profile?: Partial<Record<keyof LikenessProfile, string>> | undefined }) {
  const current = await currentProfile(auth);
  if (!current?.profile) throw AppError.badRequest('Build your likeness first.');
  if (running(current)) throw AppError.conflict('Your likeness is being built.');
  const profile = { ...current.profile, ...(patch.profile ?? {}) };
  await withUser(auth, (tx) => tx`
    UPDATE likeness_profiles SET profile = ${json(profile)}, height_cm = ${patch.heightCm === undefined ? current.heightCm : patch.heightCm}, updated_at = now()
    WHERE user_id = ${auth.userId}`);
  return view(auth);
}

/** Removes the likeness and every file behind it (photos, videos, frames, voice, trained model). */
export async function deleteLikeness(auth: AuthContext) {
  if (running(await currentProfile(auth))) throw AppError.conflict('Wait for the build to finish first.');
  await withUser(auth, async (tx) => {
    await tx`DELETE FROM likeness_assets WHERE user_id = ${auth.userId}`;
    await tx`DELETE FROM likeness_profiles WHERE user_id = ${auth.userId}`;
  });
  await deletePrefix(`${keys.user(auth.userId)}/likeness/`);
  await deletePrefix(`system/likeness/${auth.userId}/`);
  logger.info({ userId: auth.userId }, 'likeness deleted');
  return view(auth);
}

/* ------------------------------------------------------------------ @me resolver */

export interface MeContext {
  /** Written reference for prompts. */
  description: string;
  /** Best reference images (R2 keys) for reference-image models. */
  referenceKeys: string[];
  /** Trained identity model, when available. */
  lora: { key: string; triggerWord: string } | null;
  voiceKey: string | null;
  heightCm: number | null;
}

/** One line per trait, for prompt building. */
export function describeLikeness(profile: LikenessProfile | null, heightCm: number | null): string {
  if (!profile) return '';
  const parts = [
    profile.summary,
    heightCm ? `Height ${heightCm} cm.` : profile.heightImpression,
    profile.face && `Face: ${profile.face}`,
    profile.skeleton && `Frame: ${profile.skeleton}`,
    profile.body && `Build: ${profile.body}`,
    profile.proportions && `Proportions: ${profile.proportions}`,
    profile.posture && `Posture: ${profile.posture}`,
    profile.gait && !/not visible/i.test(profile.gait) ? `Walk: ${profile.gait}` : '',
    profile.hair && `Hair: ${profile.hair}`,
  ];
  return parts.filter(Boolean).join(' ').slice(0, 2400);
}

/** The user's @me context (system read, for jobs), or null when they have no usable likeness. */
export async function meContext(userId: string): Promise<MeContext | null> {
  const [row] = await sql<LikenessRow[]>`SELECT * FROM likeness_profiles WHERE user_id = ${userId}`;
  if (!row || row.status !== 'READY' || !row.profile?.summary) return null;
  return {
    description: describeLikeness(row.profile, row.heightCm),
    referenceKeys: row.referenceKeys,
    lora: row.lora?.status === 'READY' && row.lora.loraKey ? { key: row.lora.loraKey, triggerWord: row.lora.triggerWord } : null,
    voiceKey: row.voiceKey,
    heightCm: row.heightCm,
  };
}

/** `@me` anywhere in a prompt (case-insensitive, as a word). */
export const ME_PATTERN = /(^|[^\w@])@me\b/i;
export const mentionsMe = (text: string | null | undefined): boolean => Boolean(text && ME_PATTERN.test(text));
/** Replaces @me with words a model understands. */
export const replaceMe = (text: string, words = 'the creator'): string => text.replace(/(^|[^\w@])@me\b/gi, (_, lead: string) => `${lead}${words}`);
