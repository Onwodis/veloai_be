/**
 * Builds a user's likeness (queue job `likeness:<userId>`):
 *
 *   FRAMES    six frames sampled across every video (movement, posture, gait)
 *   VOICE     the clearest ~30 s of speech from their videos, cleaned and
 *             loudness-normalised (kept for voice features)
 *   ANALYSIS  Claude reads photos + frames → face, skeletal frame, body,
 *             proportions, height, posture, gait, hair, wardrobe, and picks
 *             the best reference images
 *   TRAINING  (optional) a personal identity model (LoRA) trained on fal.ai
 *             from up to 20 normalised images, stored privately in R2
 *
 * Tokens: one hold covers analysis + training; only what finished is charged.
 * The training request handle is persisted, so a restart resumes it.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { ffmpeg, probe } from '../media/ffmpeg.js';
import { downloadToFile, keys, readUrl, uploadFile } from '../services/storage.service.js';
import { releaseSystem, settleSystem, touchReservation } from '../services/token.service.js';
import { analyzeLikeness, type LikenessImage } from '../studio/director.js';
import { runResumable, type SavedFal } from '../studio/falRun.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql, withSqlRetry } from '../studio/sql.js';
import { logger } from '../utils/logger.js';
import type { LikenessAssetRow, LikenessLora, LikenessProfile, LikenessRow } from './types.js';

const FRAMES_PER_VIDEO = 6;

async function load(userId: string): Promise<LikenessRow | undefined> {
  const [row] = await withSqlRetry(() => sql<LikenessRow[]>`SELECT * FROM likeness_profiles WHERE user_id = ${userId}`);
  return row;
}

export async function runLikeness(userId: string): Promise<void> {
  const row = await load(userId);
  if (!row || (row.status !== 'ANALYZING' && row.status !== 'TRAINING')) return;
  const settings = await getStudioSettings();
  const workDir = await mkdtemp(join(tmpdir(), `likeness-${userId.slice(0, 8)}-`));
  const engines: string[] = [];
  let charge = 0;
  const set = (patch: Record<string, unknown>): Promise<unknown> =>
    withSqlRetry(() => sql`UPDATE likeness_profiles SET ${sql({ ...patch, updatedAt: new Date() } as unknown as Record<string, never>)} WHERE user_id = ${userId}`);
  const touch = async (): Promise<void> => {
    if (row.reservationId) await withSqlRetry(() => touchReservation(row.reservationId!)).catch(() => undefined);
  };

  try {
    const assets = await sql<LikenessAssetRow[]>`SELECT * FROM likeness_assets WHERE user_id = ${userId} AND status = 'READY' ORDER BY created_at`;
    if (assets.length === 0) throw new Error('No photos or videos to learn from.');

    /* FRAMES + VOICE (local copies are also the training set) ---------------- */
    const images: (LikenessImage & { file: string })[] = [];
    let voiceKey = row.voiceKey;
    let bestAudio: { file: string; seconds: number } | null = null;
    for (const [index, asset] of assets.entries()) {
      const source = join(workDir, `asset-${index}`);
      await downloadToFile(asset.key, source);
      if (asset.kind === 'PHOTO') {
        const file = join(workDir, `photo-${index}.jpg`);
        await ffmpeg(['-i', source, '-vf', "scale='min(1536,iw)':'min(1536,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '2', file]);
        images.push({ key: asset.key, label: `photo ${index + 1}`, file });
        continue;
      }
      const media = await probe(source);
      for (let frame = 0; frame < FRAMES_PER_VIDEO; frame += 1) {
        const at = (media.durationSec * (frame + 0.5)) / FRAMES_PER_VIDEO;
        const file = join(workDir, `video-${index}-${frame}.jpg`);
        await ffmpeg(['-ss', at.toFixed(2), '-i', source, '-frames:v', '1', '-vf', "scale='min(1536,iw)':'min(1536,ih)':force_original_aspect_ratio=decrease", '-q:v', '2', file]);
        const key = keys.likenessDerived(userId, `${asset.id}-frame-${frame}.jpg`);
        await uploadFile(key, file, 'image/jpeg');
        images.push({ key, label: `video ${index + 1}, frame at ${at.toFixed(1)} s of ${media.durationSec.toFixed(1)} s`, file });
      }
      if (media.hasAudio && (!bestAudio || media.durationSec > bestAudio.seconds)) bestAudio = { file: source, seconds: media.durationSec };
    }
    if (bestAudio) {
      const voice = join(workDir, 'voice.m4a');
      // Pauses removed, rumble cut, gentle denoise, broadcast loudness; up to 30 s of speech.
      await ffmpeg([
        '-i', bestAudio.file, '-vn',
        '-af', 'silenceremove=start_periods=1:stop_periods=-1:stop_duration=0.6:stop_threshold=-42dB,highpass=f=70,afftdn=nr=10,loudnorm=I=-16:TP=-1.5:LRA=11',
        '-t', '30', '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '160k', voice,
      ]);
      voiceKey = keys.likenessDerived(userId, 'voice.m4a');
      await uploadFile(voiceKey, voice, 'audio/mp4');
    }
    await touch();

    /* ANALYSIS -------------------------------------------------------------- */
    let profile = row.profile ?? {};
    let referenceKeys = row.referenceKeys;
    // Resumed mid-training after a restart: the analysis already ran under this hold.
    if (row.status === 'TRAINING' && profile.summary) charge += settings.costs.likenessAnalysis;
    if (row.status === 'ANALYZING' || !profile.summary) {
      const result = await analyzeLikeness(images, { heightCm: row.heightCm, selfDescription: profile.selfDescription });
      engines.push(`analysis: ${result.engine}`);
      const { bestReferences, engine: _engine, ...traits } = result;
      // The user's own notes (self description, voice) survive a rebuild.
      profile = { ...traits, ...(profile.selfDescription ? { selfDescription: profile.selfDescription } : {}), ...(profile.voice ? { voice: profile.voice } : {}) } satisfies LikenessProfile;
      const picked = bestReferences.map((index) => images[index]?.key).filter((key): key is string => Boolean(key));
      referenceKeys = picked.length ? picked : images.slice(0, 4).map((image) => image.key);
      charge += settings.costs.likenessAnalysis;
      const next = row.lora && row.lora.status !== 'READY' ? 'TRAINING' : 'READY';
      await set({ profile: json(profile), referenceKeys, voiceKey, analyzedAt: new Date(), status: next, engine: engines.join(' · ').slice(0, 400) });
      row.status = next;
    }

    /* TRAINING -------------------------------------------------------------- */
    if (row.status === 'TRAINING' && row.lora) {
      const model = settings.models.likenessTraining;
      const lora: LikenessLora = { ...row.lora, status: 'TRAINING', endpoint: model.endpoint };
      await set({ lora: json(lora) });
      try {
        const stamp = Date.now().toString(36);
        let saved: SavedFal = row.falRequest;
        let input: Record<string, unknown> = {};
        if (!saved) {
          // Up to 20 images: every photo first, then video frames.
          const set20 = [...images.filter((image) => image.label.startsWith('photo')), ...images.filter((image) => !image.label.startsWith('photo'))].slice(0, 20);
          if (set20.length < 4) throw new Error('Training needs at least 4 images: add more photos or a short video.');
          const files: Record<string, Uint8Array> = {};
          for (const [index, image] of set20.entries()) files[`${String(index).padStart(2, '0')}.jpg`] = new Uint8Array(await readFile(image.file));
          const zipFile = join(workDir, 'images.zip');
          await writeFile(zipFile, zipSync(files, { level: 0 }));
          const zipKey = keys.likenessTrainingSet(userId, stamp);
          await uploadFile(zipKey, zipFile, 'application/zip');
          input = { ...model.extra, images_data_url: await readUrl(zipKey), trigger_word: lora.triggerWord };
          lora.images = set20.length;
        }
        const { result, seconds } = await runResumable(saved, 'TRAIN', model.endpoint, input, async (handle) => {
          saved = handle;
          await set({ falRequest: handle ? json(handle) : null });
        }, { timeoutMs: 45 * 60_000, onTick: touch });
        const url = (result as { diffusers_lora_file?: { url?: string } }).diffusers_lora_file?.url;
        if (!url) throw new Error('Training finished without a model file.');
        const weights = join(workDir, 'likeness.safetensors');
        await downloadUrl(url, weights);
        const loraKey = keys.likenessWeights(userId, stamp);
        await uploadFile(loraKey, weights, 'application/octet-stream');
        Object.assign(lora, { status: 'READY', loraKey, trainedAt: new Date().toISOString() } satisfies Partial<LikenessLora>);
        engines.push(`training: ${model.endpoint} (${seconds} s)`);
        charge += settings.costs.likenessTraining;
      } catch (error) {
        // The written profile + reference photos still work for @me; only training is not charged.
        lora.status = 'FAILED';
        lora.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        logger.error({ err: error, userId }, 'likeness training failed');
      }
      await set({ lora: json(lora), status: 'READY', falRequest: null, engine: engines.join(' · ').slice(0, 400) });
    }
    await settle(row, charge);
    logger.info({ userId, charge }, 'likeness ready');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, userId }, 'likeness build failed');
    await settle(row, charge).catch(() => undefined);
    await set({ status: charge > 0 ? 'READY' : 'FAILED', error: message.slice(0, 990), falRequest: null }).catch(() => undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function settle(row: LikenessRow, charge: number): Promise<void> {
  if (!row.reservationId || !row.workspaceId) return;
  if (charge <= 0) {
    await releaseSystem(row.reservationId, row.workspaceId).catch(() => undefined);
    return;
  }
  const settled = await settleSystem(row.reservationId, row.workspaceId, charge, 'My likeness: analysis' + (charge > (await getStudioSettings()).costs.likenessAnalysis ? ' + identity training' : ''));
  await sql`UPDATE likeness_profiles SET tokens_charged = tokens_charged + ${settled.actual ?? charge}, reservation_id = NULL WHERE user_id = ${row.userId}`;
}
