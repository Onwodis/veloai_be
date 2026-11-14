/**
 * Runs one creation (queue job `creation:<id>`):
 *
 *   DIRECTING  Claude turns the request into one precise shot (identity,
 *              light, lens, action). Without Claude, the raw prompt is used.
 *   IMAGING    @me with a trained identity model → likeness model (LoRA);
 *              @me without one → reference-photo model with the best refs;
 *              no @me → text-to-image (stills) / nothing (video)
 *   ENHANCING  photo edits from written instructions; optional upscale pass
 *   ANIMATING  image-to-video from the frame, or text-to-video
 *   STORING    original quality to R2 (counted in the user's storage)
 *
 * Charged on success for the steps that ran; a failure releases the hold.
 * Every fal.ai request handle is saved, so a restart resumes it.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meContext, replaceMe, type MeContext } from '../likeness/service.js';
import { ACTIVE_CREATION, type CreationRow, type CreationStatus } from '../likeness/types.js';
import { ffmpeg, probe } from '../media/ffmpeg.js';
import { keys, readUrl, uploadFile } from '../services/storage.service.js';
import { releaseSystem, settleSystem, touchReservation } from '../services/token.service.js';
import { ASPECTS, NEGATIVE, REALISM, STABILITY } from '../studio/cinema.js';
import { directPrompt } from '../studio/director.js';
import * as fal from '../studio/fal.js';
import { runResumable, type SavedFal } from '../studio/falRun.js';
import { conformImage, downloadUrl, thumbnail } from '../studio/files.js';
import { getStudioSettings, pickDuration } from '../studio/settings.js';
import { json, sql, withSqlRetry } from '../studio/sql.js';
import { logger } from '../utils/logger.js';

class Canceled extends Error {}

/** Generation size for still models (≈2 MP, multiples of 16). */
const STILL_SIZE = { '9:16': { width: 864, height: 1536 }, '16:9': { width: 1536, height: 864 }, '1:1': { width: 1280, height: 1280 } } as const;

/** Same real-life standard as the music-video keyframes: an untouched photo, not an "AI portrait". */
const STILL_REALISM =
  'Looks like an untouched photo from a real camera: natural available light, true colour, real lens depth of field, ' +
  'real skin with pores, small blemishes, fine lines and natural asymmetry, flyaway hairs, real fabric with creases, an ordinary lived-in background; ' +
  'accurate anatomy and hands; no retouching, no beauty filter, no glow, no text, no watermark.';

export async function runCreation(id: string): Promise<void> {
  const [row] = await withSqlRetry(() => sql<CreationRow[]>`SELECT * FROM creations WHERE id = ${id}`);
  if (!row || !ACTIVE_CREATION.includes(row.status)) return;
  const settings = await getStudioSettings();
  const { models } = settings;
  const costs = row.options.costs ?? { direction: 0, image: 0, video: 0, upscale: 0 };
  const workDir = await mkdtemp(join(tmpdir(), `create-${id.slice(0, 8)}-`));
  const engines: string[] = [];
  let saved: SavedFal = row.falRequest;
  let charge = 0;
  let lastTouch = 0;

  const set = (patch: Record<string, unknown>): Promise<unknown> => withSqlRetry(() => sql`UPDATE creations SET ${sql(patch as Record<string, never>)} WHERE id = ${id}`);
  const check = async (): Promise<void> => {
    const [current] = await withSqlRetry(() => sql<{ status: CreationStatus }[]>`SELECT status FROM creations WHERE id = ${id}`);
    if (!current || current.status === 'CANCELED') throw new Canceled('Canceled');
    if (row.reservationId && Date.now() - lastTouch > 60_000) {
      lastTouch = Date.now();
      await withSqlRetry(() => touchReservation(row.reservationId!)).catch(() => undefined);
    }
  };
  const enter = async (status: CreationStatus): Promise<void> => {
    await check();
    await set({ status });
  };
  const run = async (stage: string, endpoint: string, input: Record<string, unknown>): Promise<unknown> => {
    const { result, seconds } = await runResumable(saved, stage, endpoint, input, async (handle) => {
      saved = handle;
      await set({ falRequest: handle ? json(handle) : null });
    }, { onTick: check });
    engines.push(`${stage.toLowerCase()}: ${endpoint} (${seconds} s)`);
    return result;
  };

  try {
    const me: MeContext | null = row.usesMe ? await meContext(row.userId) : null;
    if (row.usesMe && !me) throw new Error('Your likeness is no longer available. Rebuild it on the My likeness page.');

    /* DIRECTING ---------------------------------------------------------- */
    let prompt = row.direction;
    let motion = row.options.motion ?? '';
    if (!prompt) {
      await enter('DIRECTING');
      if (row.options.direct) {
        try {
          const direction = await directPrompt({ mode: row.mode, prompt: row.prompt, aspect: row.aspect, likeness: me?.description, triggerWord: me?.lora?.triggerWord });
          prompt = direction.prompt;
          motion = direction.motion;
          engines.push(`direction: ${direction.engine}`);
          charge += costs.direction;
          await set({ direction: prompt, options: json({ ...row.options, title: direction.title, motion }) });
        } catch (error) {
          logger.warn({ err: error, id }, 'prompt direction failed; using the request as written');
        }
      }
      prompt ??= replaceMe(row.prompt, me ? `the person in the reference (${me.description.slice(0, 500)})` : 'a person');
    }
    const identityPrompt = (text: string): string => (me?.lora && !text.includes(me.lora.triggerWord) ? `${me.lora.triggerWord} person, ${text}` : text);

    /* STILL (image, enhancement, or the first frame of an @me video) ------- */
    let still: string | null = null;
    const needsStill = row.mode !== 'VIDEO' || row.usesMe;
    if (needsStill) {
      const raw = join(workDir, 'still-raw');
      if (row.mode === 'ENHANCE') {
        await enter('ENHANCING');
        const refs = me ? await Promise.all(me.referenceKeys.slice(0, 3).map((key) => readUrl(key))) : [];
        const result = await run('EDIT', models.imageEdit.endpoint, {
          ...models.imageEdit.extra,
          prompt: `Edit the first image. ${prompt} Keep everything not mentioned unchanged; keep the people's faces, bodies and identity exactly as in the photo.${refs.length ? ' The other images show the same person as @me for reference.' : ''} ${STILL_REALISM}`,
          image_urls: [await readUrl(row.sourceKey!), ...refs],
        });
        await downloadUrl(fal.outputUrl(result, 'image'), raw);
      } else {
        await enter('IMAGING');
        const size = STILL_SIZE[row.aspect];
        if (me?.lora && models.likenessImage.enabled) {
          const result = await run('LIKENESS', models.likenessImage.endpoint, {
            ...models.likenessImage.extra,
            prompt: `${identityPrompt(prompt)} ${STILL_REALISM}`,
            loras: [{ path: await readUrl(me.lora.key), scale: 1 }],
            image_size: size,
          });
          await downloadUrl(fal.outputUrl(result, 'image'), raw);
        } else if (me) {
          const refs = await Promise.all(me.referenceKeys.slice(0, 4).map((key) => readUrl(key)));
          const result = await run('REFERENCE', models.imageEdit.endpoint, {
            ...models.imageEdit.extra,
            prompt: `Create a new photograph of the person shown in the reference images. Keep their exact face, skin tone, hairline, body frame, height and proportions; do not beautify, slim or age them. ${prompt} ${STILL_REALISM}`,
            image_urls: refs,
          });
          await downloadUrl(fal.outputUrl(result, 'image'), raw);
        } else {
          const result = await run('IMAGE', models.textToImage.endpoint, { ...models.textToImage.extra, prompt: `${prompt} ${STILL_REALISM}`, aspect_ratio: ASPECTS[row.aspect].model });
          await downloadUrl(fal.outputUrl(result, 'image'), raw);
        }
      }
      charge += costs.image;
      still = join(workDir, 'still.png');
      if (row.mode === 'VIDEO') await conformImage(raw, still, ASPECTS[row.aspect].width, ASPECTS[row.aspect].height);
      else still = raw;

      if (row.mode !== 'VIDEO' && row.options.upscale && models.imageUpscale.enabled) {
        await enter('ENHANCING');
        const tempKey = keys.creation(row.userId, id, 'keyframe.png');
        await uploadFile(tempKey, still, 'image/png');
        const result = await run('UPSCALE', models.imageUpscale.endpoint, { ...models.imageUpscale.extra, image_url: await readUrl(tempKey), prompt });
        const upscaled = join(workDir, 'upscaled');
        await downloadUrl(fal.outputUrl(result, 'image'), upscaled);
        still = upscaled;
        charge += costs.upscale;
      }
    }

    /* VIDEO ---------------------------------------------------------------- */
    let outputFile: string;
    let outputKey: string;
    let thumbKey: string | null = null;
    if (row.mode === 'VIDEO') {
      await enter('ANIMATING');
      const model = still ? models.imageToVideo : models.textToVideo;
      const duration = pickDuration(model, row.durationSec ?? 5);
      let frameUrl: string | null = null;
      if (still) {
        const frameKey = keys.creation(row.userId, id, 'keyframe.png');
        await uploadFile(frameKey, still, 'image/png');
        frameUrl = await readUrl(frameKey);
      }
      const result = await run('VIDEO', model.endpoint, {
        ...model.extra,
        // The identity token only means something to the likeness model, not the video model.
        prompt: [motion, me?.lora ? prompt.replaceAll(`${me.lora.triggerWord} person`, 'the person') : prompt, row.usesMe ? 'The person keeps the same face and body from the first frame throughout.' : '', row.usesMe ? STABILITY : '', REALISM].filter(Boolean).join(' '),
        negative_prompt: NEGATIVE,
        ...(duration.param ? { duration: duration.param } : {}),
        ...(frameUrl ? { image_url: frameUrl } : { aspect_ratio: ASPECTS[row.aspect].model }),
      });
      outputFile = join(workDir, 'output.mp4');
      await downloadUrl(fal.outputUrl(result, 'video'), outputFile);
      charge += costs.video;
      await enter('STORING');
      const media = await probe(outputFile);
      const thumb = join(workDir, 'thumb.jpg');
      await thumbnail(outputFile, thumb, Math.min(1, media.durationSec / 3));
      outputKey = keys.creation(row.userId, id, 'output.mp4');
      thumbKey = keys.creation(row.userId, id, 'thumb.jpg');
      await Promise.all([uploadFile(outputKey, outputFile, 'video/mp4'), uploadFile(thumbKey, thumb, 'image/jpeg')]);
      await set({ durationSec: media.durationSec });
    } else {
      await enter('STORING');
      // Normalise whatever the model returned (webp/jpg/png) to a lossless PNG master.
      outputFile = join(workDir, 'output.png');
      await conformImageKeep(still!, outputFile);
      outputKey = keys.creation(row.userId, id, 'output.png');
      await uploadFile(outputKey, outputFile, 'image/png');
    }

    const size = (await stat(outputFile)).size;
    let charged = charge;
    if (row.reservationId) {
      const settled = charge > 0 ? await settleSystem(row.reservationId, row.workspaceId, charge, `Create · ${row.mode.toLowerCase()}${row.usesMe ? ' of @me' : ''}`) : await releaseSystem(row.reservationId, row.workspaceId);
      charged = settled.actual ?? charge;
    }
    await set({ status: 'READY', outputKey, thumbKey, outputSize: size, cost: charged, engine: engines.join(' · ').slice(0, 600), error: null, falRequest: null, finishedAt: new Date() });
    logger.info({ id, mode: row.mode, charged, size }, 'creation ready');
  } catch (error) {
    const canceled = error instanceof Canceled;
    if (!canceled) logger.error({ err: error, id }, 'creation failed');
    if (saved && canceled) await fal.cancel(saved).catch(() => undefined);
    if (row.reservationId) await releaseSystem(row.reservationId, row.workspaceId).catch(() => undefined);
    await set({
      status: canceled ? 'CANCELED' : 'FAILED',
      error: canceled ? null : (error instanceof Error ? error.message : String(error)).slice(0, 990),
      cost: 0,
      engine: engines.join(' · ').slice(0, 600) || null,
      falRequest: null,
      finishedAt: new Date(),
    }).catch(() => undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Re-encodes a still to PNG at its own size. */
async function conformImageKeep(input: string, output: string): Promise<void> {
  await ffmpeg(['-i', input, '-frames:v', '1', output]);
}
