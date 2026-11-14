/**
 * The reel pipeline for one project:
 *
 *   PROBE       download from R2, ffprobe duration/size; re-check the token
 *               hold against the *measured* duration (extend or fail cleanly)
 *   AUDIO       ffmpeg → 16 kHz mono speech audio (chunked for long videos)
 *   TRANSCRIBE  word-level speech-to-text
 *   HOOKS       pick the best self-contained moments (Claude / heuristic)
 *   RENDER      per clip: cut, reframe 9:16, animated captions, loudness,
 *               H.264 → upload reel + thumbnail to R2
 *   FINALIZE    charge tokens for the work actually done, record usage
 *
 * Billing: tokens were reserved before upload. On success the job is charged
 * for the measured minutes and the reels actually produced. On failure only
 * the stages that completed are charged; on cancel before transcription,
 * nothing is.
 *
 * Resume: what each step has been charged for is kept in `options.billed`.
 * A retried job reuses its saved transcript, hooks and finished reels, and is
 * only charged the difference, so a failure late in the job never makes the
 * creator pay for transcription twice.
 *
 * Every database call goes through `withDbRetry`: a momentary Neon outage
 * (compute waking, pooler dropping a connection) is retried instead of
 * failing minutes of finished work.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaProject, PipelineStage, Prisma, Reel, UsageMetric } from '@prisma/client';
import { prisma, withDbRetry } from '../config/database.js';
import { estimateTask, STEP_LABEL, STEP_UNIT, TASK_STEPS, type BilledSteps, type TaskStep } from '../config/tokenSettings.js';
import { resolveEngine } from '../services/ai.service.js';
import { currentSubscription } from '../services/billing.service.js';
import { getTokenSettings } from '../services/settings.service.js';
import { downloadToFile, keys, uploadFile } from '../services/storage.service.js';
import { extendReservation, releaseSystem, settleSystem, touchReservation } from '../services/token.service.js';
import { publishProgress, type ProgressEvent } from '../realtime/events.js';
import { logger } from '../utils/logger.js';
import type { CaptionStyle } from './captions.js';
import { probe } from './ffmpeg.js';
import { detectHooks } from './hooks.js';
import type { ReelPlan } from './edit.js';
import { DEFAULT_STYLE, renderReel, type EditStyle, type Framing } from './render.js';
import { editsForReel, type ReelScript } from './script.js';
import { extractAudio, transcribe, type Word } from './transcribe.js';

export interface ProjectOptions {
  framing: Framing;
  captionStyle: CaptionStyle | 'none';
  targetSeconds: number;
  declaredDurationSec: number;
  /** Creator's free-text directions for the AI picker. */
  directions?: string;
  /** Reel script as typed (shown back in the UI) and as parsed at upload. */
  script?: string;
  plan?: ReelScript;
  /** Quantity already charged per step (minutes or reels); see "Resume" above. */
  billed?: BilledSteps;
  /** Finishing: mute, colour look, jump cuts, noise cleanup, auto effects (defaults in render.ts). */
  style?: Partial<EditStyle>;
  /** The AI's hook headline + flashpoints per reel, by reel index (kept for re-renders). */
  reelPlans?: ReelPlan[];
  /** Set when the reel count was raised: keep existing reels, pick only the extra ones. */
  topUp?: boolean;
  /** One-click "Swap visual style": per-reel look / caption overrides, by reel index. */
  reelStyles?: Record<number, ReelStyle>;
  /** One-click "Regenerate hook": reels whose hook, title and caption the AI rewrites on the next run. */
  rehook?: string[];
}

export interface ReelStyle {
  look?: EditStyle['look'];
  captionStyle?: CaptionStyle | 'none';
}

/**
 * Visual presets the "Swap visual style" button cycles through: a colour look
 * paired with a caption style that suits it. Re-rendering one reel from the
 * cached transcript costs only that reel's captions + export.
 */
export const VISUAL_PRESETS: readonly (Required<ReelStyle> & { name: string })[] = [
  // Real-life first: subtle grades that keep skin and light true (the music-video standard).
  { name: 'Natural karaoke', look: 'natural', captionStyle: 'karaoke' },
  { name: 'Filmic minimal', look: 'filmic', captionStyle: 'minimal' },
  { name: 'Natural pop', look: 'natural', captionStyle: 'pop' },
  { name: 'Golden hour minimal', look: 'golden-hour', captionStyle: 'minimal' },
  { name: 'Filmic karaoke', look: 'filmic', captionStyle: 'karaoke' },
  { name: 'Cool night minimal', look: 'cool-night', captionStyle: 'minimal' },
  { name: 'Noir minimal', look: 'noir', captionStyle: 'minimal' },
];

/**
 * What a project has already paid for. Projects created before resume
 * support have no `billed` record, so it is inferred from the saved work
 * (each piece was charged when it was produced).
 */
export function billedSoFar(project: Pick<MediaProject, 'options' | 'transcript' | 'durationSec'>, reels: Pick<Reel, 'status'>[]): BilledSteps {
  const options = project.options as unknown as ProjectOptions;
  if (options.billed) return options.billed;
  const minutes = project.durationSec ? Math.ceil(project.durationSec / 60) : 0;
  const billed: BilledSteps = {};
  if (project.transcript) billed.TRANSCRIPTION = minutes;
  if (reels.length > 0) {
    billed.HOOK_DETECTION = minutes;
    billed.AI_TITLES = reels.filter((reel) => reel.status === 'READY').length;
  }
  return billed;
}

interface SavedTranscript {
  words: Word[];
  text: string;
}

interface LogEntry {
  stage: PipelineStage;
  engine: string;
  ms: number;
  detail?: string;
}

class Canceled extends Error {}

/** Progress range for each stage (start, end). */
const RANGE: Record<PipelineStage, [number, number]> = {
  PROBE: [0, 5],
  AUDIO: [5, 10],
  TRANSCRIBE: [10, 35],
  HOOKS: [35, 45],
  RENDER: [45, 96],
  FINALIZE: [96, 100],
};

/** Usage counters are reporting only: a failure here never fails the job. */
async function addUsage(workspaceId: string, metric: UsageMetric, quantity: number): Promise<void> {
  if (quantity <= 0) return;
  try {
    const { currentPeriodStart } = await withDbRetry(() => currentSubscription(workspaceId));
    await withDbRetry(() =>
      prisma.usageCounter.upsert({
        where: { workspaceId_metric_periodStart: { workspaceId, metric, periodStart: currentPeriodStart } },
        update: { quantity: { increment: Math.round(quantity) } },
        create: { workspaceId, metric, periodStart: currentPeriodStart, quantity: Math.round(quantity) },
      }),
    );
  } catch (error) {
    logger.warn({ err: error, workspaceId, metric }, 'usage counter update failed (non-fatal)');
  }
}

export async function runProject(projectId: string): Promise<void> {
  const project = await withDbRetry(() => prisma.mediaProject.findUnique({ where: { id: projectId } }));
  if (!project || project.status === 'CANCELED' || project.status === 'READY') return;

  const options = project.options as unknown as ProjectOptions;
  const existingReels = await withDbRetry(() => prisma.reel.findMany({ where: { projectId }, orderBy: { index: 'asc' } }));
  const billed = billedSoFar(project, existingReels);
  const saved = project.transcript as unknown as SavedTranscript | null;
  const resuming = Boolean(saved?.words?.length) || existingReels.length > 0;
  const priorCharged = project.tokensCharged ?? 0;

  const workDir = await mkdtemp(join(tmpdir(), `reel-${projectId.slice(0, 8)}-`));
  const log: LogEntry[] = resuming && Array.isArray(project.engineLog) ? [...(project.engineLog as unknown as LogEntry[])] : [];
  const completed = new Set<TaskStep>();
  const controller = new AbortController();
  let minutes = 0;
  let reelsReady = existingReels.filter((reel) => reel.status === 'READY').length;
  let stage: PipelineStage = 'PROBE';

  // Live progress for the project page (WebSocket via Redis pub/sub); never blocks the job.
  const emit = (event: Partial<Omit<ProgressEvent, 'kind' | 'workspaceId' | 'projectId' | 'at'>>, throttleMs = 0): void =>
    publishProgress({ kind: 'reels', workspaceId: project.workspaceId, projectId, status: 'PROCESSING', stage, ...event }, throttleMs);
  const update = (data: Prisma.MediaProjectUpdateInput): Promise<unknown> => withDbRetry(() => prisma.mediaProject.update({ where: { id: projectId }, data }));
  const cancelRequested = async (): Promise<boolean> =>
    Boolean((await withDbRetry(() => prisma.mediaProject.findUnique({ where: { id: projectId }, select: { cancelRequested: true } })))?.cancelRequested);
  const enter = async (next: PipelineStage): Promise<void> => {
    if (await cancelRequested()) throw new Canceled('Canceled by user');
    stage = next;
    emit({ stage: next, progress: RANGE[next][0] });
    await update({ stage: next, progress: RANGE[next][0], engineLog: log as unknown as Prisma.InputJsonValue });
    if (project.reservationId) await withDbRetry(() => touchReservation(project.reservationId!));
  };
  const timed = async <T>(engine: string, fn: () => Promise<T>, detail?: (result: T) => string): Promise<T> => {
    const started = Date.now();
    const result = await fn();
    log.push({ stage, engine, ms: Date.now() - started, ...(detail ? { detail: detail(result) } : {}) });
    return result;
  };
  const reused = (engine: string, detail: string): void => {
    log.push({ stage, engine, ms: 0, detail });
  };

  await update({ status: 'PROCESSING', startedAt: new Date(), error: null });
  emit({ stage: 'PROBE', progress: 0, detail: resuming ? 'Resuming from saved work' : 'Starting' });
  logger.info({ projectId, resuming, billed }, resuming ? 'pipeline resumed' : 'pipeline started');

  try {
    /* PROBE ------------------------------------------------------------ */
    await enter('PROBE');
    const source = join(workDir, `source${project.sourceName.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? '.mp4'}`);
    await timed('Cloudflare R2 download', () => downloadToFile(project.sourceKey, source));
    const media = await timed('ffprobe', () => probe(source), (result) => `${result.durationSec.toFixed(1)} s, ${result.width}×${result.height}, audio: ${result.hasAudio ? 'yes' : 'no'}`);
    if (!media.hasAudio) throw new Error('This video has no audio track, so there is no speech to find hooks in.');
    if (media.durationSec < 10) throw new Error('The video is shorter than 10 seconds.');
    minutes = Math.ceil(media.durationSec / 60);
    await update({ durationSec: media.durationSec, width: media.width, height: media.height });
    emit({ progress: RANGE.PROBE[1], detail: `${Math.round(media.durationSec)} s · ${media.width}×${media.height}` });

    // The hold was sized from the browser's duration; re-check against reality
    // (only the steps not already paid for on an earlier run).
    const settings = await getTokenSettings();
    const measured = estimateTask(settings, { sourceMinutes: media.durationSec / 60, reels: project.requestedReels }, billed);
    if (project.reservationId && !(await withDbRetry(() => extendReservation(project.reservationId!, project.workspaceId, measured.reserve)))) {
      throw new Error(`This video is ${minutes} min long and needs ${measured.reserve} tokens reserved; the workspace doesn't have enough available. Buy tokens and retry.`);
    }

    /* AUDIO + TRANSCRIBE ----------------------------------------------- */
    let words: Word[];
    let language = project.language;
    if (saved?.words?.length) {
      await enter('TRANSCRIBE');
      words = saved.words;
      reused('saved transcript (resumed)', `${words.length} words reused, not charged again`);
    } else {
      await enter('AUDIO');
      const { chunks, audioFile } = await timed('ffmpeg audio extract', () => extractAudio(source, workDir), (result) => `${result.chunks.length} chunk(s), 16 kHz mono`);
      await uploadFile(keys.audio(project.workspaceId, projectId), audioFile, 'audio/mpeg').catch((error: unknown) => logger.warn({ err: error }, 'audio upload failed (non-fatal)'));

      await enter('TRANSCRIBE');
      const transcriber = await resolveEngine('transcription');
      const transcript = await timed('transcription', () => transcribe(chunks, transcriber, controller.signal), (result) => `${result.engine}: ${result.words.length} words, language ${result.language ?? '?'}`);
      log[log.length - 1]!.engine = transcript.engine;
      words = transcript.words;
      language = transcript.language;
      emit({ progress: RANGE.TRANSCRIBE[1], detail: `${transcript.words.length.toLocaleString('en')} words` });
      // Saved before anything else can fail, so a retry never transcribes (or charges) twice.
      await update({ transcript: { words: transcript.words, text: transcript.text.slice(0, 200_000) } as unknown as Prisma.InputJsonValue, language: transcript.language, progress: RANGE.TRANSCRIBE[1] });
      await addUsage(project.workspaceId, 'TRANSCRIPTION_SECONDS', transcript.audioSeconds);
    }
    completed.add('TRANSCRIPTION');

    /* HOOKS ------------------------------------------------------------ */
    await enter('HOOKS');
    let reels: Reel[];
    if (existingReels.length > 0 && options.topUp && existingReels.length < project.requestedReels) {
      // Reel count raised: the finished reels stay; pick only the extra moments,
      // never overlapping the ones already used.
      const extra = project.requestedReels - existingReels.length;
      const engine = await resolveEngine('hooks');
      const pick = (avoidExisting: boolean) =>
        detectHooks(
          words,
          {
            count: extra,
            targetSeconds: options.targetSeconds,
            durationSec: media.durationSec,
            language,
            directions: options.directions,
            skips: [...(options.plan?.skips ?? []), ...(avoidExisting ? existingReels.map((reel) => ({ start: reel.startSec, end: reel.endSec })) : [])],
          },
          engine,
        );
      const hooks = await timed(
        'hook detection (extra reels)',
        // A short video may have no speech left outside the existing reels:
        // then the extra reels are alternative cuts of the same moments.
        () => pick(true).catch(() => pick(false)),
        (result) => `${result.clips.length} new clip(s) added to ${existingReels.length}`,
      );
      log[log.length - 1]!.engine = hooks.engine;
      // Never add an exact duplicate of a reel the project already has.
      hooks.clips = hooks.clips.filter((clip) => !existingReels.some((reel) => Math.abs(reel.startSec - clip.start) < 1 && Math.abs(reel.endSec - clip.end) < 1));
      await addUsage(project.workspaceId, 'AI_TOKENS', hooks.llmInputTokens + hooks.llmOutputTokens);
      const offset = Math.max(...existingReels.map((reel) => reel.index)) + 1;
      const added = hooks.clips.length
        ? await withDbRetry(() =>
            prisma.reel.createManyAndReturn({
              data: hooks.clips.map((clip, index) => ({
                projectId,
                workspaceId: project.workspaceId,
                index: offset + index,
                title: clip.title.slice(0, 160),
                hook: clip.hook.slice(0, 500),
                hookScore: clip.score,
                startSec: clip.start,
                endSec: clip.end,
                caption: clip.caption.slice(0, 1000),
                hashtags: clip.hashtags.slice(0, 8).map((tag) => tag.slice(0, 40)),
              })),
            }),
          )
        : [];
      const plans = [...(options.reelPlans ?? [])];
      hooks.clips.forEach((clip, index) => {
        plans[offset + index] = { hookText: clip.hookText, beats: clip.beats };
      });
      options.reelPlans = plans;
      delete options.topUp;
      reels = [...existingReels, ...added].sort((a, b) => a.index - b.index);
      await update({ options: options as unknown as Prisma.InputJsonValue, ...(added.length < extra ? { requestedReels: reels.length } : {}) });
    } else if (existingReels.length > 0 && options.rehook?.length) {
      // One-click "Regenerate hook": the AI rewrites the hook, title and caption
      // for the same moment, from the cached transcript (no new transcription).
      const engine = await resolveEngine('hooks');
      const plans = [...(options.reelPlans ?? [])];
      for (const reel of existingReels.filter((item) => options.rehook!.includes(item.id))) {
        const span = words.filter((word) => word.s >= reel.startSec - 0.05 && word.e <= reel.endSec + 0.05);
        const previous = plans[reel.index]?.hookText || reel.title;
        const hooks = await timed(
          'hook rewrite (one-click variation)',
          () =>
            detectHooks(
              span,
              {
                count: 1,
                targetSeconds: Math.round(reel.endSec - reel.startSec),
                durationSec: media.durationSec,
                language,
                directions: [
                  options.directions ?? '',
                  `This is a variation of an existing reel. Use the whole passage. Write a clearly different angle: a new on-screen hook headline, title and caption. Do not reuse this headline: "${previous.slice(0, 80)}".`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
              engine,
            ),
          (result) => `reel ${reel.index + 1}: ${result.clips[0] ? `“${result.clips[0].hookText}”` : 'no new angle found, kept the old one'}`,
        );
        log[log.length - 1]!.engine = `${hooks.engine} (variation)`;
        await addUsage(project.workspaceId, 'AI_TOKENS', hooks.llmInputTokens + hooks.llmOutputTokens);
        const clip = hooks.clips[0];
        if (!clip) continue;
        // Same cut, new words: the reel keeps its start / end.
        plans[reel.index] = { hookText: clip.hookText, beats: clip.beats.filter((beat) => beat.t > reel.startSec + 0.8 && beat.t < reel.endSec - 0.3) };
        const updated = await withDbRetry(() =>
          prisma.reel.update({
            where: { id: reel.id },
            data: { title: clip.title.slice(0, 160), hook: clip.hook.slice(0, 500), hookScore: clip.score, caption: clip.caption.slice(0, 1000), hashtags: clip.hashtags.slice(0, 8).map((tag) => tag.slice(0, 40)) },
          }),
        );
        existingReels[existingReels.indexOf(reel)] = updated;
      }
      options.reelPlans = plans;
      delete options.rehook;
      await update({ options: options as unknown as Prisma.InputJsonValue });
      reels = existingReels;
    } else if (existingReels.length > 0) {
      reels = existingReels;
      reused('saved hooks (resumed)', `${reels.length} clip(s) reused, ${reelsReady} already rendered`);
    } else {
      const hooks = await timed(
        'hook detection',
        async () =>
          detectHooks(
            words,
            {
              count: project.requestedReels,
              targetSeconds: options.targetSeconds,
              durationSec: media.durationSec,
              language,
              directions: options.directions,
              forced: options.plan?.clips ?? [],
              skips: options.plan?.skips ?? [],
            },
            await resolveEngine('hooks'),
          ),
        (result) => `${result.clips.length} clip(s); ${result.llmInputTokens + result.llmOutputTokens} LLM tokens`,
      );
      log[log.length - 1]!.engine = hooks.engine;
      await addUsage(project.workspaceId, 'AI_TOKENS', hooks.llmInputTokens + hooks.llmOutputTokens);
      if (hooks.clips.length === 0) {
        completed.add('HOOK_DETECTION');
        throw new Error('No clip-worthy moments were found in this video.');
      }
      // One multi-row INSERT (an interactive transaction can time out on Neon's pooler).
      reels = await withDbRetry(() =>
        prisma.reel.createManyAndReturn({
          data: hooks.clips.map((clip, index) => ({
            projectId,
            workspaceId: project.workspaceId,
            index,
            title: clip.title.slice(0, 160),
            hook: clip.hook.slice(0, 500),
            hookScore: clip.score,
            startSec: clip.start,
            endSec: clip.end,
            caption: clip.caption.slice(0, 1000),
            hashtags: clip.hashtags.slice(0, 8).map((tag) => tag.slice(0, 40)),
          })),
        }),
      );
      reels.sort((a, b) => a.index - b.index);
      options.reelPlans = hooks.clips.map((clip) => ({ hookText: clip.hookText, beats: clip.beats }));
      await update({ options: options as unknown as Prisma.InputJsonValue });
    }
    const style: EditStyle = { ...DEFAULT_STYLE, ...options.style };
    completed.add('HOOK_DETECTION');
    completed.add('AI_TITLES');

    /* RENDER ----------------------------------------------------------- */
    await enter('RENDER');
    const [from, to] = RANGE.RENDER;
    let storedBytes = 0;
    let lastProgress = -1;
    let lastProgressAt = 0;
    for (const [index, reel] of reels.entries()) {
      if (reel.status === 'READY') continue; // rendered on an earlier run
      if (await cancelRequested()) throw new Canceled('Canceled by user');
      try {
        const edits = editsForReel(options.plan, reel.startSec, reel.endSec);
        const titleSeconds = options.plan?.titleSeconds;
        const output = await timed(
          `ffmpeg edit (${options.framing ?? 'original'}, look ${style.look}${style.jumpCuts ? ', jump cuts' : ''}${style.autoEffects ? ', auto effects' : ''}${style.denoise ? ', denoise' : ''}${style.muted ? ', muted' : ''}${edits.length ? `, ${edits.length} script edit(s)` : ''})`,
          () =>
            renderReel({
              source,
              workDir,
              reelId: reel.id,
              start: reel.startSec,
              end: reel.endSec,
              words,
              framing: options.framing ?? 'original',
              captionStyle: options.reelStyles?.[reel.index]?.captionStyle ?? options.captionStyle,
              hasAudio: media.hasAudio,
              sourceSize: { width: media.width, height: media.height },
              style: options.reelStyles?.[reel.index]?.look ? { ...style, look: options.reelStyles[reel.index]!.look! } : style,
              plan: options.reelPlans?.[reel.index],
              edits,
              title: titleSeconds ? { text: reel.title, seconds: titleSeconds } : undefined,
              signal: controller.signal,
              onProgress: (fraction) => {
                // ffmpeg reports several times a second; one write every 3 s is plenty
                // (each is a round trip to Neon, and they used to queue up behind the render).
                const progress = Math.round(from + ((index + fraction) / reels.length) * (to - from));
                emit({ progress, detail: `Reel ${index + 1} of ${reels.length}`, reel: { index, total: reels.length, fraction } }, 400);
                if (progress === lastProgress || Date.now() - lastProgressAt < 3000) return;
                lastProgress = progress;
                lastProgressAt = Date.now();
                void prisma.mediaProject.update({ where: { id: projectId }, data: { progress } }).catch(() => undefined);
              },
            }),
          (result) => `reel ${index + 1}/${reels.length}: ${result.durationSec.toFixed(1)} s, ${result.cuts} jump cut(s), ${result.effects} effect(s)`,
        );
        const videoKey = keys.reel(project.workspaceId, projectId, reel.id, 'mp4');
        const thumbKey = keys.reel(project.workspaceId, projectId, reel.id, 'jpg');
        await Promise.all([uploadFile(videoKey, output.video, 'video/mp4'), uploadFile(thumbKey, output.thumb, 'image/jpeg')]);
        const size = (await stat(output.video)).size;
        await withDbRetry(() => prisma.reel.update({ where: { id: reel.id }, data: { status: 'READY', error: null, videoKey, thumbKey, sizeBytes: BigInt(size) } }));
        storedBytes += size;
        reelsReady += 1;
      } catch (error) {
        if (error instanceof Canceled) throw error;
        logger.error({ err: error, reelId: reel.id }, 'reel render failed');
        await withDbRetry(() => prisma.reel.update({ where: { id: reel.id }, data: { status: 'FAILED', error: (error instanceof Error ? error.message : String(error)).slice(0, 480) } }));
      }
      const done = Math.round(from + ((index + 1) / reels.length) * (to - from));
      emit({ progress: done, detail: `Reel ${index + 1} of ${reels.length} ready`, reel: { index, total: reels.length, fraction: 1 } });
      await update({ progress: done });
    }
    if (reelsReady === 0) throw new Error('Every reel failed to render. See the engine log for details.');
    completed.add('REFRAME');
    completed.add('CAPTIONS');
    completed.add('EXPORT');

    /* FINALIZE --------------------------------------------------------- */
    await enter('FINALIZE');
    const result = await finalizeCharge(project.reservationId, project.workspaceId, minutes, reelsReady, completed, billed, project.title);
    if (!resuming) {
      await addUsage(project.workspaceId, 'PROCESSING_MINUTES', minutes);
      await addUsage(project.workspaceId, 'STORAGE_MB', (project.sourceSize > 0n ? Number(project.sourceSize) : 0) / 1_048_576);
    }
    await addUsage(project.workspaceId, 'REELS_EXPORTED', reelsReady - existingReels.filter((reel) => reel.status === 'READY').length);
    await addUsage(project.workspaceId, 'STORAGE_MB', storedBytes / 1_048_576);
    await update({
      status: 'READY',
      stage: 'FINALIZE',
      progress: 100,
      tokensCharged: priorCharged + result.charge,
      options: { ...options, billed: result.billed } as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
      engineLog: log as unknown as Prisma.InputJsonValue,
    });
    emit({ status: 'READY', stage: 'FINALIZE', progress: 100, detail: `${reelsReady} reel${reelsReady === 1 ? '' : 's'} ready` });
    logger.info({ projectId, reels: reelsReady, tokens: result.charge, resumed: resuming }, 'pipeline finished');
  } catch (error) {
    controller.abort();
    const canceled = error instanceof Canceled;
    const message = error instanceof Error ? error.message : String(error);
    logger[canceled ? 'info' : 'error']({ err: canceled ? undefined : error, projectId, stage }, canceled ? 'pipeline canceled' : 'pipeline failed');
    let result = { charge: 0, billed };
    try {
      result = await finalizeCharge(project.reservationId, project.workspaceId, minutes, reelsReady, completed, billed, project.title);
    } catch (billingError) {
      logger.error({ err: billingError, projectId }, 'settling a failed job failed');
    }
    // If even this write can't reach the database, the project stays PROCESSING
    // and recoverStuckProjects() resumes it on the next start.
    await update({
      status: canceled ? 'CANCELED' : 'FAILED',
      error: canceled ? null : message.slice(0, 990),
      tokensCharged: priorCharged + result.charge,
      options: { ...options, billed: result.billed } as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
      engineLog: log as unknown as Prisma.InputJsonValue,
    })
      .then(() => emit({ status: canceled ? 'CANCELED' : 'FAILED', detail: canceled ? 'Canceled' : message.slice(0, 200) }))
      .catch((writeError: unknown) => logger.error({ err: writeError, projectId }, 'could not record the failed job'));
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Charges completed steps for whatever they haven't been charged for yet
 * (minute steps up to the measured minutes, reel steps up to the reels
 * rendered), settles the hold, and returns the updated `billed` record.
 * Releases the hold when nothing new is billable.
 */
async function finalizeCharge(
  reservationId: string | null,
  workspaceId: string,
  minutes: number,
  reelsReady: number,
  completed: Set<TaskStep>,
  billed: BilledSteps,
  title: string,
): Promise<{ charge: number; billed: BilledSteps }> {
  if (!reservationId) return { charge: 0, billed };
  const { taskCosts } = await withDbRetry(() => getTokenSettings());
  const next: BilledSteps = { ...billed };
  const lines: string[] = [];
  let charge = 0;
  for (const step of TASK_STEPS) {
    if (!completed.has(step)) continue;
    const unit = STEP_UNIT[step];
    const target = unit === 'minute' ? minutes : reelsReady;
    const already = billed[step] ?? 0;
    if (target > already) {
      const quantity = target - already;
      charge += taskCosts[step] * quantity;
      next[step] = target;
      lines.push(`${STEP_LABEL[step]} ${quantity} ${unit === 'minute' ? 'min' : quantity === 1 ? 'reel' : 'reels'}`);
    }
  }
  if (charge === 0) {
    await withDbRetry(() => releaseSystem(reservationId, workspaceId)).catch(() => undefined);
    return { charge: 0, billed: next };
  }
  // Shown in the workspace's token history: which project, and what each step cost.
  const note = `Reels · ${title.slice(0, 60)}: ${lines.join(', ')}`;
  const settled = await withDbRetry(() => settleSystem(reservationId, workspaceId, charge, note));
  return { charge: settled.actual ?? charge, billed: next };
}
