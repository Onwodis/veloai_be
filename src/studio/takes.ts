/**
 * Generates one take of one scene:
 *
 *   KEYFRAME   creator in the scene: a photoreal still from their reference
 *              photos (identity + body frame lock), conformed to the aspect.
 *              Scene photo without the creator: that photo is the frame.
 *              Neither (aerial/b-roll): no keyframe, text-to-video.
 *   ANIMATING  image-to-video from the keyframe, or text-to-video.
 *              Music-video shots with cast use the reference model: keyframe
 *              as start frame + one identity element per character.
 *   LIPSYNC    music-video performance shots: isolated vocal stem of the exact
 *              slice of the song → lip sync (cut_off) → muxed over the master
 *              mix (see lipsync.ts).
 *   STORING    original-quality MP4 + poster to R2.
 *
 * Every fal.ai request handle is saved before waiting, so a restart resumes
 * the same request. Takes requested together share one token reservation,
 * settled once the last of them finishes, for the takes that succeeded.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '../media/ffmpeg.js';
import { deletePrefix, downloadToFile, keys, readUrl, uploadFile } from '../services/storage.service.js';
import { releaseSystem, settleSystem, touchReservation } from '../services/token.service.js';
import { logger } from '../utils/logger.js';
import { ASPECTS, KINETIC_SHOTS, keyframePrompt, lipSafeShot, motionPrompt, negativePrompt, softDelivery, type Aspect, type PromptInput } from './cinema.js';
import * as fal from './fal.js';
import { conformImage, downloadUrl, thumbnail } from './files.js';
import { isReactLipSync, lipSyncInput, muxMaster, REACT_MAX_SECONDS, vocalSlice, vocalStem } from './lipsync.js';
import { getStudioSettings, pickDuration, type StudioModel, type StudioSettings } from './settings.js';
import { json, sql, withSqlRetry } from './sql.js';
import { ACTIVE_TAKE, type TakeRow, type TakeSpec, type TakeStatus } from './types.js';
import { animationRequest, getVideoModelSettings, kineticModel, seedanceReferenceRequest, videoFamily } from './videoModels.js';
import { publishProgress } from '../realtime/events.js';

class Canceled extends Error {}

type CostSpec = Pick<TakeSpec, 'featuresSubject' | 'identityKeys' | 'identityElements' | 'musicVideo' | 'sceneKey' | 'lipSync' | 'music' | 'durationSec' | 'edit'>;

/**
 * Music-video shots with cast animate through the reference model (start frame +
 * one identity element per character); everything else through plain image- or
 * text-to-video.
 */
function usesReferences(settings: StudioSettings, spec: Pick<TakeSpec, 'identityElements' | 'musicVideo'>): boolean {
  return Boolean(spec.musicVideo && spec.identityElements?.length && settings.models.referenceVideo.enabled);
}

function animationModel(settings: StudioSettings, spec: CostSpec, hasFrame: boolean): StudioModel {
  if (!hasFrame) return settings.models.textToVideo;
  return usesReferences(settings, spec) ? settings.models.referenceVideo : settings.models.imageToVideo;
}

/** Kling O1 reference-to-video: start frame + elements share a 7-image budget. */
const REFERENCE_IMAGE_LIMIT = 7;

/**
 * Request for the reference model. The keyframe is the exact first frame; each
 * character's photos are a separate identity reference, so faces are anchored to
 * the photos in every frame rather than only to frame one. The prompt names the
 * references and otherwise directs only light, place and camera.
 */
async function referenceRequest(
  model: StudioModel,
  input: { frameKey: string; elements: NonNullable<TakeSpec['identityElements']>; prompt: PromptInput; duration: string | null; aspect: Aspect },
): Promise<Record<string, unknown>> {
  const frameUrl = await readUrl(input.frameKey);
  const aspectRatio = ASPECTS[input.aspect].model;
  if (/grok-imagine/.test(model.endpoint)) {
    // Grok reference mode: one flat list, tagged <IMAGE_n> in the prompt.
    const people = input.elements.slice(0, 3);
    const perPerson = Math.max(1, Math.floor((REFERENCE_IMAGE_LIMIT - 1) / people.length));
    const groups = people.map((person) => person.keys.slice(0, perPerson));
    const urls = [frameUrl, ...(await Promise.all(groups.flat().map((key) => readUrl(key))))];
    let index = 1;
    const named = people.map((person, i) => {
      const tags = groups[i]!.map(() => `<IMAGE_${index++}>`).join(' ');
      return `${person.name} is the person in ${tags}`;
    });
    const references = `<IMAGE_0> is the opening frame: match its framing, place, light and wardrobe. ${named.join('; ')}; their face, bone structure, skin tone and hair stay exactly as in those images in every frame.`;
    return {
      ...model.extra,
      prompt: motionPrompt({ ...input.prompt, references }),
      reference_image_urls: urls,
      aspect_ratio: aspectRatio,
      ...(input.duration ? { duration: Number.parseFloat(input.duration) } : {}),
    };
  }
  // Kling O1: @Image1 = start frame, @ElementN = character N (frontal + 1-3 references).
  const people = input.elements.slice(0, 3);
  const perPerson = Math.min(4, Math.max(2, Math.floor((REFERENCE_IMAGE_LIMIT - 1) / people.length)));
  const elements = await Promise.all(
    people.map(async (person) => {
      const [frontal, ...rest] = person.keys.slice(0, perPerson);
      const frontalUrl = await readUrl(frontal!);
      const others = await Promise.all(rest.map((key) => readUrl(key)));
      // The model needs at least one reference image besides the frontal one.
      return { frontal_image_url: frontalUrl, reference_image_urls: others.length ? others : [frontalUrl] };
    }),
  );
  const named = people.map((person, i) => `@Element${i + 1} is ${person.name}`).join('; ');
  const references = `Take @Image1 as the start frame: same framing, place, light and wardrobe. ${named}; each keeps exactly the face, bone structure, skin tone and hair of their element in every frame.`;
  return {
    ...model.extra,
    prompt: motionPrompt({ ...input.prompt, references }),
    image_urls: [frameUrl],
    elements,
    aspect_ratio: aspectRatio,
    ...(input.duration ? { duration: input.duration } : {}),
  };
}

/** Tokens a take costs, given the settings (also used for the up-front estimate). */
export function takeCost(settings: StudioSettings, spec: CostSpec): number {
  const { models, costs } = settings;
  if (spec.edit) {
    const seconds = Math.ceil(spec.edit.seconds);
    return seconds * costs.videoEditPerSecond + (spec.lipSync && spec.music && models.lipSync.enabled ? seconds * costs.lipSyncPerSecond : 0);
  }
  const usesKeyframe = spec.featuresSubject && spec.identityKeys.length > 0 && models.keyframe.enabled;
  const seconds = pickDuration(animationModel(settings, spec, Boolean(usesKeyframe || spec.sceneKey)), spec.durationSec).seconds;
  const lipSync = spec.lipSync && spec.music && models.lipSync.enabled ? Math.ceil(spec.durationSec) * costs.lipSyncPerSecond : 0;
  return (usesKeyframe ? costs.keyframe : 0) + Math.ceil(seconds) * costs.videoPerSecond + lipSync;
}

/** Tokens for the fal.ai stages a take already completed (its saved outputs), never more than a full take. */
export function paidStagesCost(settings: StudioSettings, spec: TakeRow['spec'], outputs: TakeRow['outputs'] | null): number {
  if (!outputs) return 0;
  const { costs } = settings;
  if (spec.edit) {
    const seconds = Math.ceil(spec.edit.seconds);
    return (outputs['EDIT'] ? seconds * costs.videoEditPerSecond : 0) + (outputs['LIPSYNC'] ? seconds * costs.lipSyncPerSecond : 0);
  }
  const usesKeyframe = Boolean(outputs['KEYFRAME']);
  let total = usesKeyframe ? costs.keyframe : 0;
  if (outputs['ANIMATING']) total += Math.ceil(pickDuration(animationModel(settings, spec, Boolean(usesKeyframe || spec.sceneKey)), spec.durationSec).seconds) * costs.videoPerSecond;
  if (outputs['LIPSYNC']) total += Math.ceil(spec.durationSec) * costs.lipSyncPerSecond;
  return Math.min(total, takeCost(settings, spec));
}

async function load(takeId: string): Promise<TakeRow | undefined> {
  const [row] = await withSqlRetry(() => sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId}`);
  return row;
}

export async function runTake(takeId: string): Promise<void> {
  let take = await load(takeId);
  if (!take || !ACTIVE_TAKE.includes(take.status)) return;
  const { spec } = take;
  const settings = await getStudioSettings();
  const { models } = settings;
  const size = ASPECTS[spec.aspect];
  const workDir = await mkdtemp(join(tmpdir(), `take-${takeId.slice(0, 8)}-`));
  const engines: string[] = [];
  let lastTouch = 0;

  const set = async (patch: Partial<Record<string, unknown>>): Promise<void> => {
    await withSqlRetry(() => sql`UPDATE studio_takes SET ${sql(patch as Record<string, never>)} WHERE id = ${takeId}`);
  };
  const emit = (status: string, detail?: string): void => {
    if (!take) return;
    publishProgress({ kind: 'studio', workspaceId: take.workspaceId, projectId: take.projectId, take: { id: takeId, sceneId: take.sceneId, status }, ...(detail ? { detail } : {}) });
  };
  const enter = async (status: TakeStatus): Promise<void> => {
    await check();
    await set({ status });
    emit(status);
  };
  const check = async (): Promise<void> => {
    const [row] = await withSqlRetry(() => sql<{ status: TakeStatus }[]>`SELECT status FROM studio_takes WHERE id = ${takeId}`);
    if (!row || row.status === 'CANCELED') throw new Canceled('Canceled');
    if (take?.reservationId && Date.now() - lastTouch > 60_000) {
      lastTouch = Date.now();
      await withSqlRetry(() => touchReservation(take!.reservationId!)).catch(() => undefined);
    }
  };
  /** Submits (or resumes) a fal.ai request for `stage` and returns its output. */
  const run = async (stage: string, endpoint: string, input: Record<string, unknown>): Promise<unknown> => {
    // Already paid for on an earlier attempt: reuse it, don't call fal.ai again.
    const saved = take?.outputs?.[stage];
    if (saved) {
      engines.push(`${stage.toLowerCase()}: reused saved result (not charged again)`);
      return saved;
    }
    let handle: fal.FalHandle;
    if (take?.falRequest?.stage === stage && take.falRequest.endpoint === endpoint) {
      handle = take.falRequest;
    } else {
      handle = await fal.submit(endpoint, input);
      await set({ falRequest: json({ stage, ...handle }) });
    }
    const started = Date.now();
    const result = await fal.wait(handle, { onTick: check }).catch(async (error: unknown) => {
      if (error instanceof Canceled) await fal.cancel(handle);
      // A passing provider problem (overload, timeout, 5xx): send the same request once more.
      if (fal.isTransient(error)) {
        engines.push(`${stage.toLowerCase()}: retried after a temporary engine error`);
        const again = await fal.submit(endpoint, input);
        await set({ falRequest: json({ stage, ...again }) });
        return fal.wait(again, { onTick: check }).catch(async (retryError: unknown) => {
          if (retryError instanceof Canceled) await fal.cancel(again);
          throw retryError;
        });
      }
      throw error;
    });
    // Saved the moment it arrives, before anything else can fail.
    const outputs = { ...(take?.outputs ?? {}), [stage]: result };
    await set({ falRequest: null, outputs: json(outputs) });
    if (take) {
      take.falRequest = null;
      take.outputs = outputs;
    }
    engines.push(`${stage.toLowerCase()}: ${endpoint} (${Math.round((Date.now() - started) / 1000)} s)`);
    return result;
  };

  const syncing = Boolean(spec.lipSync && spec.music && models.lipSync.enabled);
  const promptInput: PromptInput = {
    scene: spec.prompt || spec.description,
    // A lip-synced face must stay large and steady: a kinetic move becomes its face-safe form.
    shot: syncing ? lipSafeShot(spec.shot) : spec.shot,
    energy: spec.energy,
    hook: spec.hook,
    visual: spec.visual,
    style: spec.style,
    identity: spec.identityProfile,
    featuresSubject: spec.featuresSubject,
    aspect: spec.aspect,
    rhythm: spec.rhythm,
    place: spec.place,
    creative: spec.creative,
    musicVideo: spec.musicVideo,
    lipSync: syncing,
    lyric: spec.lyric,
    performance: spec.performance,
  };

  try {
    /* KEYFRAME ---------------------------------------------------------- */
    let frameKey = take.keyframeKey;
    let usedKeyframeModel = false;
    if (!frameKey && !spec.edit) {
      const useIdentity = spec.featuresSubject && spec.identityKeys.length > 0 && models.keyframe.enabled;
      if (useIdentity || spec.sceneKey) {
        await enter('KEYFRAME');
        const raw = join(workDir, 'frame-raw');
        if (useIdentity && spec.likeness && !spec.sceneKey && models.likenessImage.enabled) {
          // The creator's trained identity model renders them exactly; conformed to the aspect below.
          const long = 1536;
          const ratio = size.width / size.height;
          const imageSize = ratio >= 1 ? { width: long, height: Math.round(long / ratio / 16) * 16 } : { width: Math.round(long * ratio / 16) * 16, height: long };
          const result = await run('KEYFRAME', models.likenessImage.endpoint, {
            ...models.likenessImage.extra,
            prompt: `${spec.likeness.triggerWord} person. ${keyframePrompt(promptInput)}`,
            loras: [{ path: await readUrl(spec.likeness.loraKey), scale: 1 }],
            image_size: imageSize,
          });
          await downloadUrl(fal.outputUrl(result, 'image'), raw);
          usedKeyframeModel = true;
        } else if (useIdentity) {
          const references = [...(spec.sceneKey ? [spec.sceneKey] : []), ...spec.identityKeys].slice(0, 5);
          const urls = await Promise.all(references.map((key) => readUrl(key)));
          const result = await run('KEYFRAME', models.keyframe.endpoint, { ...models.keyframe.extra, prompt: keyframePrompt(promptInput), image_urls: urls });
          await downloadUrl(fal.outputUrl(result, 'image'), raw);
          usedKeyframeModel = true;
        } else {
          await downloadToFile(spec.sceneKey!, raw);
        }
        const framed = join(workDir, 'frame.png');
        await conformImage(raw, framed, size.width, size.height);
        frameKey = keys.studioTake(take.workspaceId, take.projectId, takeId, usedKeyframeModel ? 'keyframe.png' : 'frame.png');
        await uploadFile(frameKey, framed, 'image/png');
        await set({ keyframeKey: frameKey });
      }
    }

    /**
     * The shot's isolated vocal, `seconds` long (silent between sung lines), uploaded for an engine:
     * used as Seedance's @Audio1 before animating and by the lip-sync pass after. The song and the
     * stem are fetched once per take.
     */
    let voiceSource: { song: string; source: string; isolated: boolean } | null = null;
    const owner = { workspaceId: take.workspaceId, projectId: take.projectId };
    const vocalFor = async (seconds: number, soft = softDelivery(promptInput)): Promise<{ key: string; song: string }> => {
      const music = spec.music!;
      if (!voiceSource) {
        // Isolated vocals (cached per mix), so only the voice drives the mouth.
        const song = join(workDir, 'song');
        await downloadToFile(music.key, song);
        const stem = await vocalStem(music.key, models.vocalStem, run, workDir);
        let source = song;
        if (stem) {
          source = join(workDir, 'stem.wav');
          await downloadToFile(stem.key, source);
          engines.push(`vocals: ${stem.reused ? 'cached stem' : models.vocalStem.endpoint}`);
        } else {
          engines.push('vocals: stem unavailable, band-passed mix');
        }
        voiceSource = { song, source, isolated: Boolean(stem) };
      }
      // Hums, low choruses and cool lines are sung softly: small mouth, no forced shapes.
      const slice = join(workDir, `slice-${Math.round(seconds * 1000)}.wav`);
      await vocalSlice({ source: voiceSource.source, isolated: voiceSource.isolated, start: music.start, seconds, vocals: music.vocals, out: slice, soft });
      const key = keys.studioTake(owner.workspaceId, owner.projectId, takeId, 'audio.wav');
      await uploadFile(key, slice, 'audio/wav');
      return { key, song: voiceSource.song };
    };
    /** The video model was given the vocal itself (Seedance 2.x @Audio1). */
    let nativeVocal = false;

    /* ANIMATING (or EDIT for post-processing) --------------------------- */
    await enter('ANIMATING');
    let duration: { param: string | null; seconds: number };
    let videoUrl: string;
    if (spec.edit) {
      // Post-processing: the edit model reworks the finished take, keeping its motion.
      if (!models.videoEdit.enabled) throw new Error('Video post-processing is switched off in the console.');
      duration = { param: null, seconds: spec.edit.seconds };
      const references = await Promise.all(spec.edit.referenceKeys.slice(0, 4).map((key) => readUrl(key)));
      const result = await run('EDIT', models.videoEdit.endpoint, {
        ...models.videoEdit.extra,
        prompt: spec.edit.instruction,
        video_url: await readUrl(spec.edit.sourceVideoKey),
        ...(references.length ? { image_urls: references } : {}),
      });
      videoUrl = fal.outputUrl(result, 'video');
    } else {
      // Kinetic camera shots (FPV, orbits, whip pans…) can go to the model the admin routes them to:
      // the best camera model films the camera shots, the best identity / lip-sync model the rest.
      const routed = !syncing && KINETIC_SHOTS.has(promptInput.shot) ? await kineticModel(Boolean(frameKey)) : null;
      const model = routed ?? animationModel(settings, spec, Boolean(frameKey));
      if (routed) engines.push(`camera shot routed to ${routed.endpoint}`);
      if (!model.enabled) throw new Error(`The ${frameKey ? 'image' : 'text'}-to-video model is switched off in the console.`);
      duration = pickDuration(model, spec.durationSec);
      let input: Record<string, unknown>;
      if (frameKey && model === models.referenceVideo && spec.identityElements?.length && videoFamily(model.endpoint) === 'seedance2') {
        // Seedance 2.x: start frame + identity photos as @Image tags, and on a lip-synced shot the
        // shot's isolated vocal as @Audio1, so the model animates the singer to the song itself.
        const vocal = spec.lipSync && spec.music ? await vocalFor(duration.seconds) : null;
        const elements = spec.identityElements;
        input = seedanceReferenceRequest(model, {
          frameUrl: await readUrl(frameKey),
          people: await Promise.all(elements.map(async (person) => ({ name: person.name, urls: await Promise.all(person.keys.slice(0, 3).map((key) => readUrl(key))) }))),
          prompt: (references) => motionPrompt({ ...promptInput, references }),
          negative: negativePrompt(promptInput.lipSync ?? false, { energy: spec.energy, visual: spec.visual, subject: promptInput.featuresSubject, scene: promptInput.scene }),
          duration: duration.param,
          aspect: ASPECTS[spec.aspect].model,
          vocalUrl: vocal ? await readUrl(vocal.key) : null,
          singer: elements[0]?.name ?? null,
        });
        nativeVocal = Boolean(vocal);
        engines.push(`identity: ${elements.length} reference(s)${vocal ? ' + the vocal as @Audio1 (native lip sync)' : ''}`);
      } else if (frameKey && model === models.referenceVideo && spec.identityElements?.length) {
        input = await referenceRequest(model, { frameKey, elements: spec.identityElements, prompt: promptInput, duration: duration.param, aspect: spec.aspect });
        engines.push(`identity: ${spec.identityElements.length} reference element(s)`);
      } else {
        input = animationRequest(model, {
          prompt: motionPrompt(promptInput),
          negative: negativePrompt(promptInput.lipSync ?? false, { energy: spec.energy, visual: spec.visual, subject: promptInput.featuresSubject, scene: promptInput.scene }),
          duration: duration.param,
          imageUrl: frameKey ? await readUrl(frameKey) : null,
          aspect: size.model,
        });
      }
      videoUrl = fal.outputUrl(await run('ANIMATING', model.endpoint, input), 'video');
    }

    /* LIPSYNC ----------------------------------------------------------- */
    let lipSynced = false;
    /** Set when the take's final file is already on disk (lip-synced + muxed). */
    let finalFile: string | null = null;
    const trustNative = nativeVocal && (await getVideoModelSettings()).nativeLipSync === 'native';
    if (spec.lipSync && spec.music && trustNative) {
      // The video model already sang to the vocal (Seedance @Audio1) and the admin trusts it:
      // no lip-sync pass, just the mastered mix under the picture.
      await enter('LIPSYNC');
      const base = join(workDir, 'base.mp4');
      await downloadUrl(videoUrl, base);
      const seconds = (await probe(base)).durationSec || duration.seconds;
      const song = join(workDir, 'song');
      await downloadToFile(spec.music.key, song);
      finalFile = join(workDir, 'take.mp4');
      await muxMaster({ video: base, song, start: spec.music.start, seconds, out: finalFile });
      engines.push('lip sync: native (the video model, no separate pass)');
    } else if (spec.lipSync && spec.music && models.lipSync.enabled) {
      await enter('LIPSYNC');
      const music = spec.music;
      // The base clip's real length (models render 5.04 s for "5"): the audio is cut to exactly this.
      const base = join(workDir, 'base.mp4');
      await downloadUrl(videoUrl, base);
      const seconds = (await probe(base)).durationSec || duration.seconds;
      // Music-video performance shots use the expressive model (face moves with the emotion);
      // it takes ≤ 15 s, so longer clips (and other takes) use the standard one.
      const expressive = spec.musicVideo && models.lipSyncExpressive.enabled && seconds <= REACT_MAX_SECONDS;
      const syncModel = expressive ? models.lipSyncExpressive : models.lipSync;
      if (isReactLipSync(syncModel.endpoint) && seconds > REACT_MAX_SECONDS) throw new Error(`react-1 lip sync takes clips up to ${REACT_MAX_SECONDS} s; this one is ${seconds.toFixed(1)} s.`);

      // 1-2. The isolated vocal under this shot, exactly as long as the clip, silent between sung lines.
      const soft = softDelivery(promptInput);
      const { key: audioKey, song } = await vocalFor(seconds, soft);
      if (nativeVocal) engines.push('lip sync: refined over the native sync');

      // 3. Lip sync, frame-exact (cut_off); expressive: the scene's emotion + intensity.
      const synced = await run('LIPSYNC', syncModel.endpoint, lipSyncInput(syncModel, videoUrl, await readUrl(audioKey), spec.performance, soft));
      if (expressive) engines.push(`performance: ${spec.performance?.emotion ?? 'neutral'} · intensity ${soft ? '1 (soft passage)' : (spec.performance?.intensity ?? 2)}`);
      const syncedFile = join(workDir, 'synced.mp4');
      await downloadUrl(fal.outputUrl(synced, 'video'), syncedFile);

      // 4. The synced picture over the mastered stereo mix (not the acapella the model heard).
      finalFile = join(workDir, 'take.mp4');
      await muxMaster({ video: syncedFile, song, start: music.start, seconds: (await probe(syncedFile)).durationSec || seconds, out: finalFile });
      lipSynced = true;
    }

    /* STORING ----------------------------------------------------------- */
    await enter('STORING');
    const video = finalFile ?? join(workDir, 'take.mp4');
    const thumb = join(workDir, 'thumb.jpg');
    if (!finalFile) await downloadUrl(videoUrl, video);
    const media = await probe(video);
    await thumbnail(video, thumb, Math.min(1, media.durationSec / 3));
    const videoKey = keys.studioTake(take.workspaceId, take.projectId, takeId, 'video.mp4');
    const thumbKey = keys.studioTake(take.workspaceId, take.projectId, takeId, 'thumb.jpg');
    await Promise.all([uploadFile(videoKey, video, 'video/mp4'), uploadFile(thumbKey, thumb, 'image/jpeg')]);
    // Stopped while uploading: honour it (READY would overwrite CANCELED).
    await check();

    const { costs } = settings;
    const cost =
      (usedKeyframeModel ? costs.keyframe : 0) +
      Math.ceil(duration.seconds) * (spec.edit ? costs.videoEditPerSecond : costs.videoPerSecond) +
      (lipSynced ? Math.ceil(duration.seconds) * costs.lipSyncPerSecond : 0);
    await set({
      status: 'READY',
      videoKey,
      thumbKey,
      durationSec: media.durationSec,
      cost,
      engine: engines.join(' · ').slice(0, 300),
      error: null,
      finishedAt: new Date(),
    });
    emit('READY');
    logger.info({ takeId, cost, seconds: media.durationSec, size: (await stat(video)).size }, 'studio take ready');
  } catch (error) {
    const canceled = error instanceof Canceled;
    const message = error instanceof Error ? error.message : String(error);
    if (!canceled) logger.error({ err: error, takeId }, 'studio take failed');
    emit(canceled ? 'CANCELED' : 'FAILED', canceled ? undefined : message.slice(0, 200));
    await set({ status: canceled ? 'CANCELED' : 'FAILED', error: canceled ? null : message.slice(0, 990), engine: engines.join(' · ').slice(0, 300) || null, finishedAt: new Date() }).catch(
      (writeError: unknown) => logger.error({ err: writeError, takeId }, 'could not record the failed take'),
    );
    // Stopped (or its scene deleted): nothing will ever show these files, so they leave the bucket.
    // Failed takes keep theirs: Resume reuses the stages already paid for.
    if (canceled && take) {
      await deletePrefix(`${keys.studio(take.workspaceId, take.projectId)}/takes/${takeId}/`).catch((deleteError: unknown) =>
        logger.warn({ err: deleteError, takeId }, 'canceled take files not deleted'),
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  take = await load(takeId);
  if (take?.reservationId) await settleBatch(take.reservationId, take.workspaceId).catch((error: unknown) => logger.error({ err: error, takeId }, 'take batch settlement failed'));
  // Music video "I trust your judgement": pick + approve the shot, master when the last one lands.
  if (take?.spec.kind === 'MUSIC_VIDEO') {
    await import('../musicvideo/service.js')
      .then((director) => director.onTakeFinished(takeId))
      .catch((error: unknown) => logger.error({ err: error, takeId }, 'music video auto-shoot step failed'));
  } else if (take?.status === 'READY') {
    // Commercials: VeloBot checks every finished ad shot in the background.
    const [project] = await sql<{ kind: string }[]>`SELECT kind FROM studio_projects WHERE id = ${take.projectId}`;
    if (project?.kind === 'COMMERCIAL') void import('../commercials/review.js').then((review) => review.reviewAdTake(takeId)).catch(() => undefined);
  }
}

/**
 * Once every take sharing a reservation has finished, charges the ones that
 * succeeded (one ledger entry) or releases the hold. The UPDATE … RETURNING
 * claim makes this run exactly once even when takes finish together.
 */
export async function settleBatch(reservationId: string, workspaceId: string): Promise<void> {
  const rows = await withSqlRetry(() => sql<{ status: TakeStatus }[]>`SELECT status FROM studio_takes WHERE reservation_id = ${reservationId}`);
  if (rows.some((row) => ACTIVE_TAKE.includes(row.status))) return;
  const claimed = await withSqlRetry(
    () => sql<{ projectId: string; status: TakeStatus; cost: number; spec: TakeRow['spec']; outputs: TakeRow['outputs'] | null }[]>`
      UPDATE studio_takes SET settled = true WHERE reservation_id = ${reservationId} AND settled = false RETURNING project_id, status, cost, spec, outputs`,
  );
  if (claimed.length === 0) return;
  const settings = await getStudioSettings();
  const ready = claimed.filter((row) => row.status === 'READY');
  // Stopped by the user after fal.ai already rendered something: those stages were paid
  // for, so they are charged. Failed takes stay free (they can be resumed at no fal cost).
  const canceled = claimed.map((row) => (row.status === 'CANCELED' ? paidStagesCost(settings, row.spec, row.outputs) : 0));
  const charge = ready.reduce((sum, row) => sum + row.cost, 0) + canceled.reduce((sum, value) => sum + value, 0);
  const projectId = claimed[0]!.projectId;
  if (charge === 0) {
    await releaseSystem(reservationId, workspaceId).catch(() => undefined);
    return;
  }
  const [project] = await sql<{ title: string }[]>`SELECT title FROM studio_projects WHERE id = ${projectId}`;
  const settled = await settleSystem(reservationId, workspaceId, charge, `AI video · ${(project?.title ?? 'project').slice(0, 60)}: ${ready.length} take(s) generated`);
  await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${settled.actual ?? charge}, updated_at = now() WHERE id = ${projectId}`;
}
