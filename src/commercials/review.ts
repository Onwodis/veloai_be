/**
 * VeloBot's background review of every finished ad take (the commercials
 * counterpart of musicvideo/review.ts; same TakeReview shape, so the shoot
 * stage shows the same flag, tooltip and fixes).
 *
 *   1. Technical, free: black / frozen / too-short footage.
 *   2. The supervising director looks at frames from the take next to the
 *      scene's script line, the brief (objective, platform, rules), the brand
 *      and the real product photos, and flags what an agency producer would:
 *      product wrong or missing, off-brief, off-brand, weak hook, poor quality,
 *      looks AI, wrong cast / wardrobe / setting, pacing that fights the line.
 * Reviews are on the platform (no user tokens).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { videoFrames } from '../musicvideo/audio.js';
import { checkTake } from '../musicvideo/polish.js';
import { publishProgress } from '../realtime/events.js';
import { keys } from '../services/storage.service.js';
import { parse, photoBlock } from '../studio/director.js';
import { json, sql } from '../studio/sql.js';
import { REVIEW_FIXES, REVIEW_ISSUES, type SceneRow, type TakeReview, type TakeRow } from '../studio/types.js';
import { logger } from '../utils/logger.js';
import type { AdRules, AdScript } from './schemas.js';

const ReviewSchema = z.object({
  score: z.number().int().min(1).max(10).describe('1 = unusable … 10 = broadcast-ready commercial shot'),
  summary: z.string().describe('One short sentence for a tooltip, plain words, no jargon (max ~140 characters)'),
  issues: z
    .array(z.object({ kind: z.enum(REVIEW_ISSUES), severity: z.enum(['high', 'medium', 'low']), detail: z.string().describe('What is wrong, concretely, in one sentence the client understands') }))
    .describe('Only real problems; empty when the shot is good'),
  fixes: z
    .array(z.object({ action: z.enum(REVIEW_FIXES), label: z.string().describe('The concrete fix in a few words, e.g. "Retake: show the bottle label clearly"') }))
    .describe('1-3 proposed fixes, best first; KEEP when the shot is fine'),
});

const SYSTEM =
  'You are the agency producer and supervising director of a professional TV / social commercial, checking one finished shot before it goes into the cut. ' +
  'You see frames from the shot, the scene script (visual, spoken line, on-screen text), the brief, the brand and photos of the real product. Flag only real problems: ' +
  'OFF_STORY (does not do what the script scene asks, or does not serve the objective), OUT_OF_SCOPE (shows something the script did not ask for, e.g. a competitor or a different product), ' +
  'MISFIT (off-brand: wrong mood, setting, wardrobe, cast or country for the brief and rules; the product looks different from its photos: wrong packaging, colour, logo or shape), ' +
  'WEAK (no energy, nothing happens, a hook that would be scrolled past), POOR_QUALITY (blur, warping, broken hands or faces, garbled text or logos, artefacts, bad framing), ' +
  'TOO_AI (plastic skin, glossy over-perfect look, impossible camera; the standard is real-life footage with natural imperfections), ' +
  'INCONSISTENT (a cast member changes between frames), TIMING (pace or movement fights the spoken line or the scene length), LIP_SYNC (someone visibly talks but the mouth is hidden or unnatural). ' +
  'Be fair: a good shot gets 7+ and no issues. Never invent problems you cannot see.';

async function save(takeId: string, review: TakeReview): Promise<void> {
  await sql`UPDATE studio_takes SET review = ${json(review)} WHERE id = ${takeId}`;
}

interface AdContextRow {
  objective: string;
  platform: string;
  goal: string;
  callToAction: string;
  rules: AdRules;
  script: AdScript | null;
  companyName: string;
  tone: string;
  productName: string;
  productDescription: string;
  productId: string;
}

/** Reviews one ad take (skips takes already reviewed unless `force`). Never throws. */
export async function reviewAdTake(takeId: string, force = false): Promise<void> {
  const [take] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId}`;
  if (!take || take.status !== 'READY' || !take.videoKey) return;
  if (take.review && !force && take.review.status !== 'FAILED') return;
  const [scene] = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE id = ${take.sceneId}`;
  const [ad] = await sql<AdContextRow[]>`
    SELECT a.objective, a.platform, a.goal, a.call_to_action, a.rules, a.script, c.name AS company_name, c.tone,
      p.name AS product_name, p.description AS product_description, p.id AS product_id
    FROM ad_projects a JOIN companies c ON c.id = a.company_id JOIN products p ON p.id = a.product_id
    WHERE a.project_id = ${take.projectId}`;
  if (!scene || !ad) return;
  const at = new Date().toISOString();
  await save(takeId, { status: 'RUNNING', at });
  const emit = (): void => publishProgress({ kind: 'studio', workspaceId: take.workspaceId, projectId: take.projectId, take: { id: takeId, sceneId: take.sceneId, status: 'READY' }, detail: 'review' });
  emit();

  const dir = await mkdtemp(join(tmpdir(), 'ad-review-'));
  try {
    const issues: NonNullable<TakeReview['issues']> = [];
    const technical = await checkTake(take.videoKey, scene.durationSec, dir, 'take').catch(() => null);
    if (technical) issues.push({ kind: 'POOR_QUALITY', severity: 'high', detail: technical });
    if (take.durationSec && take.durationSec < scene.durationSec - 0.3) {
      issues.push({ kind: 'TIMING', severity: 'medium', detail: `The video is ${take.durationSec.toFixed(1)} s for a ${scene.durationSec.toFixed(1)} s scene: the end would freeze.` });
    }

    const line = ad.script?.scenes[scene.position];
    const rules = ad.rules;
    const context = [
      `Brand: ${ad.companyName}${ad.tone ? ` (tone: ${ad.tone})` : ''}. Product: ${ad.productName}. ${ad.productDescription.slice(0, 600)}`,
      `Brief: ${ad.objective.toLowerCase().replace('_', ' ')} on ${ad.platform.toLowerCase()}. Goal: ${ad.goal.slice(0, 400)}. Call to action: ${ad.callToAction || 'none'}.`,
      [rules.environment && `Setting: ${rules.environment}`, rules.location && `Location: ${rules.location}`, rules.country && `Country: ${rules.country}`, rules.castEthnicity && `Cast: ${rules.castEthnicity}`, rules.costume && `Wardrobe: ${rules.costume}`]
        .filter(Boolean)
        .join('. '),
      `Scene ${scene.position + 1} of the script (${scene.durationSec.toFixed(1)} s): ${(line?.visual ?? scene.description).slice(0, 1200)}`,
      line?.camera ? `Camera: ${line.camera}` : '',
      line?.line ? `Spoken over it${line.speaker ? ` by ${line.speaker}` : ''}: "${line.line}"` : 'No spoken line in this scene.',
      line?.onScreenText ? `On-screen text added in the edit (not expected in the footage): "${line.onScreenText}"` : '',
      scene.position === 0 ? 'This is the HOOK: it must stop the scroll in the first 2 seconds.' : '',
      issues.length ? `Already found by the technical check: ${issues.map((issue) => issue.detail).join(' ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const frameKeys = await videoFrames(take.videoKey, (index) => `${keys.studio(take.workspaceId, take.projectId)}/takes/${takeId}/review-${index}.jpg`, 4);
    const photos = await sql<{ key: string }[]>`
      SELECT key FROM product_assets WHERE product_id = ${ad.productId} AND status = 'READY' AND kind IN ('PACKSHOT', 'PHOTO') ORDER BY kind = 'PACKSHOT' DESC, created_at LIMIT 2`;
    const [frames, references] = await Promise.all([
      Promise.all(frameKeys.map((key) => photoBlock(key))),
      Promise.all(photos.map((photo) => photoBlock(photo.key).catch(() => null))),
    ]);
    const productPhotos = references.filter((block): block is NonNullable<typeof block> => Boolean(block));
    const { data, engine } = await parse('commercial', ReviewSchema, SYSTEM, [
      { type: 'text', text: context },
      { type: 'text', text: 'Frames from the shot (start → end):' },
      ...frames,
      ...(productPhotos.length ? [{ type: 'text' as const, text: 'Photos of the real product (it must look like this whenever it is on screen):' }, ...productPhotos] : []),
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
    logger.info({ takeId, score: data.score, flagged, engine }, 'ad take reviewed');
  } catch (error) {
    logger.warn({ err: error, takeId }, 'ad take review failed');
    await save(takeId, { status: 'FAILED', at, error: 'The review could not run. Try “Re-check” later.' }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    emit();
  }
}
