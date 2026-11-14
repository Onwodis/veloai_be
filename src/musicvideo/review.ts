/**
 * VeloBot's background review of every finished music-video take.
 *
 * Runs on its own when a take lands (and again on demand). Two passes:
 *   1. Technical, free: black / frozen / far-too-short footage, and timing:
 *      a lip-synced take whose song slice no longer matches the scene's place
 *      on the storyboard, or footage that runs short of the scene.
 *   2. The director looks at frames from the take next to the scene's script,
 *      the lyric under it, the song's mood, the video's story and a reference
 *      photo of each character, and flags what a professional supervisor
 *      would: weak, off-story, out of scope, poor quality, lip sync, looks AI,
 *      inconsistent cast, misfit; with the fix to try.
 * The result is saved on the take (studio_takes.review); the storyboard shows
 * a red flag on the scene, a tooltip and a banner with the proposed fixes.
 * Reviews are on the platform (no user tokens).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { keys } from '../services/storage.service.js';
import { sceneStarts } from '../studio/assemble.js';
import { softDelivery } from '../studio/cinema.js';
import { parse, photoBlock } from '../studio/director.js';
import { json, sql } from '../studio/sql.js';
import { REVIEW_FIXES, REVIEW_ISSUES, type ProjectRow, type SceneRow, type TakeReview, type TakeRow } from '../studio/types.js';
import { publishProgress } from '../realtime/events.js';
import { logger } from '../utils/logger.js';
import { videoFrames } from './audio.js';
import type { CharacterRow } from './cast.js';
import { checkTake } from './polish.js';

const ReviewSchema = z.object({
  score: z.number().int().min(1).max(10).describe('1 = unusable … 10 = broadcast-ready music-video shot'),
  summary: z.string().describe('One short sentence for a tooltip, plain words, no jargon (max ~140 characters)'),
  issues: z
    .array(
      z.object({
        kind: z.enum(REVIEW_ISSUES),
        severity: z.enum(['high', 'medium', 'low']),
        detail: z.string().describe('What is wrong, concretely, in one sentence the artist understands'),
      }),
    )
    .describe('Only real problems; empty when the shot is good'),
  fixes: z
    .array(z.object({ action: z.enum(REVIEW_FIXES), label: z.string().describe('The concrete fix in a few words, e.g. "Retake: closer framing, sing softer"') }))
    .describe('1-3 proposed fixes, best first; KEEP when the shot is fine'),
});

const SYSTEM =
  'You are the supervising director of a professional music video, checking one finished shot before it goes into the cut. ' +
  'You see frames from the shot, the scene script, the lyric heard under it, the song mood, the video story, and reference photos of the cast. ' +
  'Judge it the way a real music-video director would and flag only real problems: ' +
  'WEAK (dull, nothing happens, no energy for this part of the song), OFF_STORY (does not serve the story or the words under it), OUT_OF_SCOPE (shows something the script did not ask for), ' +
  'POOR_QUALITY (blur, warping, broken hands or faces, artefacts, bad framing), LIP_SYNC (performance shots: mouth hidden, too small, forced or over-wide mouth on a soft line, or not singing), ' +
  'TOO_AI (plastic skin, glossy over-perfect look, impossible camera, uncanny faces; the standard is real-life footage with natural imperfections), ' +
  'INCONSISTENT (a cast member does not look like their reference photos, or changes between frames), TIMING (pace or movement fights the music), MISFIT (wrong mood, place or wardrobe for the video). ' +
  'Be fair: a good shot gets score 7+ and no issues. Never invent problems you cannot see.';

const ISSUE_TIMING_DRIFT = 0.25;

async function save(takeId: string, review: TakeReview): Promise<void> {
  await sql`UPDATE studio_takes SET review = ${json(review)} WHERE id = ${takeId}`;
}

/** Reviews one take (skips takes already reviewed unless `force`). Never throws. */
export async function reviewTake(takeId: string, force = false): Promise<void> {
  const [take] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId}`;
  if (!take || take.status !== 'READY' || !take.videoKey || !take.spec.musicVideo) return;
  if (take.review && !force && take.review.status !== 'FAILED') return;
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${take.sceneId}`;
  const [project] = await sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${take.projectId}`;
  if (!scene || !project) return;
  const at = new Date().toISOString();
  await save(takeId, { status: 'RUNNING', at });
  const emit = (): void => publishProgress({ kind: 'studio', workspaceId: take.workspaceId, projectId: take.projectId, take: { id: takeId, sceneId: take.sceneId, status: 'READY' }, detail: 'review' });
  emit();

  const dir = await mkdtemp(join(tmpdir(), 'mv-review-'));
  try {
    const issues: NonNullable<TakeReview['issues']> = [];

    // 1. Technical (free).
    const technical = await checkTake(take.videoKey, scene.durationSec, dir, 'take').catch(() => null);
    if (technical) issues.push({ kind: 'POOR_QUALITY', severity: 'high', detail: technical });
    if (take.durationSec && take.durationSec < scene.durationSec - 0.3) {
      issues.push({ kind: 'TIMING', severity: 'medium', detail: `The video is ${take.durationSec.toFixed(1)} s for a ${scene.durationSec.toFixed(1)} s scene: the end would freeze.` });
    }
    if (scene.lipSync && take.spec.music) {
      const all = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE project_id = ${take.projectId} ORDER BY position`;
      const planned = (project.brief.songStart ?? 0) + (sceneStarts(all)[all.findIndex((item) => item.id === scene.id)] ?? 0);
      const drift = take.spec.music.start - planned;
      if (Math.abs(drift) > ISSUE_TIMING_DRIFT) {
        issues.push({
          kind: 'TIMING',
          severity: 'medium',
          detail: `The scene moved ${Math.abs(drift).toFixed(1)} s ${drift > 0 ? 'earlier' : 'later'} after this video was made: it still sings its original words (kept in sync in the master), but it no longer matches the storyboard slot.`,
        });
      }
    }

    // 2. The director's look at the frames.
    const frameKeys = await videoFrames(take.videoKey, (index) => `${keys.studio(take.workspaceId, take.projectId)}/takes/${takeId}/review-${index}.jpg`, 4);
    const characters = scene.characterIds.length
      ? await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE id = ANY(${scene.characterIds}::uuid[])`
      : [];
    const [mv] = await sql<{ genre: string; vision: string; mood: string | null }[]>`SELECT genre, vision, mood FROM mv_projects WHERE project_id = ${take.projectId}`;
    const soft = scene.lipSync && softDelivery({ lyric: take.spec.lyric, rhythm: take.spec.rhythm, performance: take.spec.performance });
    const context = [
      `Video: "${project.title}" (${mv?.genre ?? 'music video'}). Look and feel: ${(mv?.vision ?? '').slice(0, 600)}`,
      project.brief.script ? `Story of the video: ${project.brief.script.slice(0, 1200)}` : '',
      `Scene ${scene.position + 1} (${scene.kind.toLowerCase()}${scene.mode ? `, ${scene.mode.toLowerCase()}` : ''}, ${scene.durationSec.toFixed(1)} s): ${(scene.prompt ?? scene.description).slice(0, 1500)}`,
      scene.costume ? `Wardrobe: ${scene.costume}` : '',
      scene.location ? `Location: ${scene.location}${scene.timeOfDay ? `, ${scene.timeOfDay}` : ''}` : '',
      take.spec.lyric ? `Heard under this shot: "${take.spec.lyric.slice(0, 300)}"` : 'Instrumental under this shot.',
      take.spec.rhythm ? `Song here: ${take.spec.rhythm.section}, energy ${Math.round(take.spec.rhythm.energy * 100)}%${take.spec.rhythm.bpm ? `, ${take.spec.rhythm.bpm} BPM` : ''}.` : '',
      scene.lipSync
        ? soft
          ? 'Performance shot, SOFT line: it should be sung gently, lips barely parting; a wide or forced mouth here is a LIP_SYNC problem.'
          : 'Performance shot: the singer must face the camera with the mouth clearly visible, singing naturally.'
        : 'Not a performance shot: nobody should be singing or mouthing words.',
      characters.length ? `Cast in this shot (reference photos follow the frames, in this order): ${characters.map((character) => character.name).join(', ')}.` : '',
      issues.length ? `Already found by the technical check: ${issues.map((issue) => issue.detail).join(' ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const frames = await Promise.all(frameKeys.map((key) => photoBlock(key)));
    const references = await Promise.all(
      characters
        .flatMap((character) => (character.referenceKeys[0] ? [character.referenceKeys[0]] : []))
        .slice(0, 3)
        .map((key) => photoBlock(key).catch(() => null)),
    );
    const { data, engine } = await parse('music-video', ReviewSchema, SYSTEM, [
      { type: 'text', text: context },
      { type: 'text', text: `Frames from the shot (start → end):` },
      ...frames,
      ...(references.some(Boolean) ? [{ type: 'text' as const, text: 'Cast reference photos:' }, ...references.filter((block): block is NonNullable<typeof block> => Boolean(block))] : []),
    ]);

    const merged = [...issues, ...data.issues.filter((issue) => !issues.some((known) => known.kind === issue.kind && known.detail === issue.detail))];
    const flagged = merged.some((issue) => issue.severity !== 'low') || data.score <= 5;
    await save(takeId, {
      status: 'DONE',
      verdict: flagged ? 'FLAG' : 'GOOD',
      score: data.score,
      summary: data.summary.slice(0, 200),
      issues: merged.slice(0, 8),
      fixes: (data.fixes.length ? data.fixes : [{ action: flagged ? 'RETAKE' : 'KEEP', label: flagged ? 'Retake this scene' : 'Keep it' }]).slice(0, 3) as TakeReview['fixes'],
      at,
    });
    logger.info({ takeId, score: data.score, flagged, engine }, 'take reviewed');
  } catch (error) {
    logger.warn({ err: error, takeId }, 'take review failed');
    await save(takeId, { status: 'FAILED', at, error: 'The review could not run. Try “Re-check” later.' }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    emit();
  }
}

/** The artist keeps a flagged take anyway: the flag goes away (the review stays readable). */
export async function dismissReview(takeId: string): Promise<void> {
  await sql`UPDATE studio_takes SET review = jsonb_set(review, '{dismissedAt}', ${json(new Date().toISOString())}) WHERE id = ${takeId} AND review IS NOT NULL`;
}
