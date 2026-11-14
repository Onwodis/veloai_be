/**
 * Ad projects (one commercial each) and their stages:
 *
 *   BRIEF       objective, platform, length (≤ 60 s), goal, call to action and
 *               the general rules every scene inherits
 *   CHARACTERS  the default cast: look and voice (language, accent, tone) each
 *   DIRECTOR    the director's room: talk it through (typed or spoken); the
 *               director keeps a running summary the client approves
 *   SCRIPT      the director writes the script from all of the above (product
 *               photos included); every scene editable; becomes the shot list
 *   SHOOT / MASTER   the studio engine (takes, review, master) — next phase
 *
 * An ad is a studio project of kind COMMERCIAL (+ ad_projects), so takes,
 * reviews, storage and the master work exactly as for music videos.
 * Every paid AI call shows its price in the UI and is charged per call.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import * as studio from '../studio/service.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { Finish, ProjectRow } from '../studio/types.js';
import type { ProjectCategory } from '../config/categories.js';
import { recordSceneLine } from './voice.js';
import { readUrl } from '../services/storage.service.js';
import { AppError } from '../utils/AppError.js';
import { discuss, fitToLength, writeScript, type AdBrief, type DirectorSummary } from './adDirector.js';
import { companyAccess, loadCompany, type CompanyRow } from './companies.js';
import { loadProduct, type ProductRow } from './products.js';
import { defaultEndCard } from './endCard.js';
import { reviewAdTake } from './review.js';
import { AD_STAGES, MAX_AD_SECONDS, type AdRules, type AdScript, type AdStage, type BriefInput, type EndCard, type VersionAspect } from './schemas.js';
import { isStale, queueVersions, versionsView, type AdVersion } from './versions.js';

interface AdRow {
  projectId: string;
  workspaceId: string;
  companyId: string;
  productId: string;
  stage: AdStage;
  objective: string;
  platform: string;
  lengthSec: number;
  goal: string;
  callToAction: string;
  rules: AdRules;
  script: (AdScript & { engine?: string }) | null;
  summary: DirectorSummary | null;
  approvals: Partial<Record<AdStage, string>>;
  createdById: string | null;
  endCard: EndCard | null;
  versions: AdVersion[];
}

export const STAGE_LABEL: Record<AdStage, string> = {
  BRIEF: 'Objective & rules',
  CHARACTERS: 'Cast & voices',
  DIRECTOR: "Director's room",
  SCRIPT: 'Script',
  SHOOT: 'Shoot',
  MASTER: 'Master',
};

/** Every stage has its tools (MASTER is the last one: no approval, the film is the result). */
const BUILT: readonly AdStage[] = ['BRIEF', 'CHARACTERS', 'DIRECTOR', 'SCRIPT', 'SHOOT', 'MASTER'];

async function loadAd(workspaceId: string, projectId: string): Promise<{ project: ProjectRow; ad: AdRow; company: CompanyRow; product: ProductRow }> {
  const [project] = await sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND kind = 'COMMERCIAL' AND deleted_at IS NULL`;
  if (!project) throw AppError.notFound('Ad');
  const [ad] = await sql<AdRow[]>`SELECT * FROM ad_projects WHERE project_id = ${projectId}`;
  if (!ad) throw AppError.notFound('Ad');
  const [company, product] = await Promise.all([loadCompany(workspaceId, ad.companyId), loadProduct(ad.companyId, ad.productId)]);
  return { project, ad, company, product };
}

function assertStage(ad: AdRow, ...allowed: AdStage[]): void {
  if (allowed.includes(ad.stage)) return;
  const ahead = AD_STAGES.indexOf(ad.stage) > AD_STAGES.indexOf(allowed[0]!);
  throw AppError.conflict(`This belongs to “${STAGE_LABEL[allowed[0]!]}”. ${ahead ? 'Reopen that stage to change it.' : 'Approve the earlier stages first.'}`);
}

const briefOf = (ad: AdRow): AdBrief => ({ objective: ad.objective, platform: ad.platform, lengthSec: ad.lengthSec, goal: ad.goal, callToAction: ad.callToAction, rules: ad.rules });

/** Reserve → AI call → settle (or release on failure). */
async function charged<T>(auth: AuthContext, workspaceId: string, projectId: string, kind: string, tokens: number, note: string, work: () => Promise<T>): Promise<T> {
  const { reservation } = await reserveTokens(auth, workspaceId, kind, tokens, { projectId });
  try {
    const result = await work();
    await settleSystem(reservation.id, workspaceId, tokens, note);
    if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${tokens} WHERE id = ${projectId}`;
    return result;
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ view */

/** The logo the end card uses: the company's, else the product's own LOGO photo (signed URL for the preview). */
async function endCardLogoUrl(company: CompanyRow, productId: string): Promise<string | null> {
  if (company.logoKey) return readUrl(company.logoKey);
  const [row] = await sql<{ key: string }[]>`SELECT key FROM product_assets WHERE product_id = ${productId} AND kind = 'LOGO' AND status = 'READY' ORDER BY created_at DESC LIMIT 1`;
  return row ? readUrl(row.key) : null;
}

export async function view(auth: AuthContext, workspaceId: string, projectId: string) {
  const { project, ad, company, product } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, false);
  const [messages, base, settings] = await Promise.all([
    sql<{ id: string; author: string; content: string; spoken: boolean; createdAt: Date }[]>`
      SELECT * FROM (SELECT id, author, content, spoken, created_at FROM ad_messages WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 200) recent ORDER BY created_at`,
    // The studio's own view: takes (with reviews), output, progress and engine log, shared with music videos.
    studio.getProject(auth, workspaceId, projectId),
    getStudioSettings(),
  ]);
  const voices = new Map(base.assets.filter((asset) => asset.role === 'VOICE').map((asset) => [asset.id, asset]));
  const scenes = base.scenes.map((scene) => {
    const voice = scene.voiceAssetId ? voices.get(scene.voiceAssetId) : undefined;
    const line = ad.script?.scenes[scene.position];
    return {
      id: scene.id,
      position: scene.position,
      description: scene.description,
      lyric: scene.lyric,
      durationSec: Number(scene.durationSec),
      speaker: line?.speaker ?? null,
      line: line?.line ?? null,
      onScreenText: line?.onScreenText ?? null,
      selectedTakeId: scene.selectedTakeId,
      takes: scene.takes,
      voice: voice?.url ? { url: voice.url, durationSec: Number((voice.meta as { durationSec?: number }).durationSec ?? 0) } : null,
    };
  });
  const current = AD_STAGES.indexOf(ad.stage);
  return {
    id: project.id,
    title: project.title,
    aspect: project.aspect,
    status: project.status,
    tokensCharged: project.tokensCharged,
    createdById: project.createdById,
    company: { id: company.id, name: company.name },
    product: { id: product.id, name: product.name },
    stage: ad.stage,
    stages: AD_STAGES.map((key, index) => ({
      key,
      label: STAGE_LABEL[key],
      status: index < current ? ('approved' as const) : index === current ? ('current' as const) : ('locked' as const),
      approvedAt: ad.approvals[key] ?? null,
      available: BUILT.includes(key),
    })),
    brief: briefOf(ad),
    maxSeconds: MAX_AD_SECONDS,
    summary: ad.summary,
    messages: messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() })),
    script: ad.script,
    scenes,
    // Master: status / progress / output come from the studio project.
    master: {
      status: base.status,
      assemblyStage: base.stage,
      progress: base.progress,
      cancelRequested: base.cancelRequested,
      error: base.error,
      output: base.output,
      finish: base.finish,
      engineLog: base.engineLog,
    },
    // The end card the next master uses (saved, or the defaults from the brief and company).
    endCard: {
      ...(ad.endCard ?? defaultEndCard({ callToAction: ad.callToAction, website: company.website, brandColours: company.brandColours })),
      saved: Boolean(ad.endCard),
      logoUrl: await endCardLogoUrl(company, product.id),
      brandColours: company.brandColours,
    },
    versions: await versionsView(ad.versions, project.outputKey, project.title),
    costs: {
      chat: settings.costs.mvChat,
      script: settings.costs.mvStoryboard,
      videoPerSecond: settings.costs.videoPerSecond,
      voicePerSecond: settings.costs.ttsPerSecond,
    },
  };
}
export type AdView = Awaited<ReturnType<typeof view>>;

/* ------------------------------------------------------------------ create + brief */

export async function createAd(auth: AuthContext, workspaceId: string, companyId: string, productId: string, input: { title: string; aspect: '16:9' | '9:16' | '1:1'; category: ProjectCategory }) {
  await companyAccess(auth, workspaceId, companyId, true);
  const product = await loadProduct(companyId, productId);
  const created = await studio.createProject(auth, workspaceId, { kind: 'AI_VIDEO', category: input.category, title: input.title, aspect: input.aspect, brief: {} });
  // Created through the studio (access, defaults), then marked as a commercial.
  await sql`UPDATE studio_projects SET kind = 'COMMERCIAL' WHERE id = ${created.id}`;
  await sql`
    INSERT INTO ad_projects (project_id, workspace_id, company_id, product_id, goal, created_by_id)
    VALUES (${created.id}, ${workspaceId}, ${companyId}, ${product.id}, '', ${auth.userId})`;
  return view(auth, workspaceId, created.id);
}

export async function updateBrief(auth: AuthContext, workspaceId: string, projectId: string, input: BriefInput) {
  const { project, ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  // The cast (rules.characters) is edited on the Characters stage; everything else on the brief.
  const castOnly = ad.stage === 'CHARACTERS';
  if (!castOnly) assertStage(ad, 'BRIEF');
  const rules: AdRules = castOnly ? { ...ad.rules, characters: input.rules?.characters ?? ad.rules.characters } : { ...ad.rules, ...input.rules };
  await sql`
    UPDATE ad_projects SET
      objective = ${castOnly ? ad.objective : (input.objective ?? ad.objective)}, platform = ${castOnly ? ad.platform : (input.platform ?? ad.platform)},
      length_sec = ${castOnly ? ad.lengthSec : (input.lengthSec ?? ad.lengthSec)}, goal = ${castOnly ? ad.goal : (input.goal ?? ad.goal)},
      call_to_action = ${castOnly ? ad.callToAction : (input.callToAction ?? ad.callToAction)}, rules = ${json(rules)}, updated_at = now()
    WHERE project_id = ${projectId}`;
  if (!castOnly && (input.title || input.aspect)) {
    await sql`UPDATE studio_projects SET title = ${input.title ?? project.title}, aspect = ${input.aspect ?? project.aspect}, updated_at = now() WHERE id = ${projectId}`;
  }
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ stages */

async function checkStage(ad: AdRow): Promise<string | null> {
  switch (ad.stage) {
    case 'BRIEF':
      if (ad.goal.trim().length < 15) return 'Describe what the ad must achieve (a sentence or two).';
      if (ad.lengthSec > MAX_AD_SECONDS) return `Ads are at most ${MAX_AD_SECONDS} seconds.`;
      return null;
    case 'CHARACTERS':
      return null; // A voice-over-only ad has no cast: allowed.
    case 'DIRECTOR':
      return ad.summary && ad.summary.agreed.length ? null : 'Talk it through with the director until the summary has agreed points, then approve.';
    case 'SCRIPT': {
      if (!ad.script) return 'Write the script first.';
      const total = ad.script.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
      return total > Math.min(MAX_AD_SECONDS, ad.lengthSec) + 0.01 ? `The script runs ${total} s; the ad is ${ad.lengthSec} s.` : null;
    }
    case 'SHOOT': {
      const scenes = await sql<{ position: number; ready: boolean; needsVoice: boolean; hasVoice: boolean }[]>`
        SELECT s.position, EXISTS (SELECT 1 FROM studio_takes t WHERE t.scene_id = s.id AND t.status = 'READY') AS ready,
          (s.lyric IS NOT NULL AND s.lyric <> '') AS needs_voice, (s.voice_asset_id IS NOT NULL) AS has_voice
        FROM studio_scenes s WHERE s.project_id = ${ad.projectId} ORDER BY s.position`;
      const noVideo = scenes.filter((scene) => !scene.ready).map((scene) => scene.position + 1);
      if (noVideo.length) return `Film every scene first (scene ${noVideo.join(', ')}).`;
      const noVoice = scenes.filter((scene) => scene.needsVoice && !scene.hasVoice).map((scene) => scene.position + 1);
      if (noVoice.length) return `Record the spoken line of scene ${noVoice.join(', ')}.`;
      return null;
    }
    default:
      return 'The master is the last stage: master the ad there.';
  }
}

export async function approveStage(auth: AuthContext, workspaceId: string, projectId: string, stage: AdStage) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, stage);
  const problem = await checkStage(ad);
  if (problem) throw AppError.badRequest(problem);
  const next = AD_STAGES[Math.min(AD_STAGES.length - 1, AD_STAGES.indexOf(stage) + 1)]!;
  await sql`
    UPDATE ad_projects SET approvals = approvals || ${json({ [stage]: new Date().toISOString() })}, stage = ${next}, updated_at = now()
    WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

export async function reopenStage(auth: AuthContext, workspaceId: string, projectId: string, stage: AdStage) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  if (AD_STAGES.indexOf(stage) > AD_STAGES.indexOf(ad.stage)) throw AppError.badRequest('That stage is not open yet.');
  const keep = Object.fromEntries(Object.entries(ad.approvals).filter(([key]) => AD_STAGES.indexOf(key as AdStage) < AD_STAGES.indexOf(stage)));
  await sql`UPDATE ad_projects SET approvals = ${json(keep)}, stage = ${stage}, updated_at = now() WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ director's room */

export async function sendMessage(auth: AuthContext, workspaceId: string, projectId: string, message: string, spoken: boolean) {
  const { project, ad, company, product } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'DIRECTOR');
  const recent = await sql<{ author: string; content: string }[]>`
    SELECT author, content FROM (SELECT author, content, created_at FROM ad_messages WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 8) last ORDER BY created_at`;
  const { costs } = await getStudioSettings();
  const turn = await charged(auth, workspaceId, projectId, 'AD_DIRECTOR', costs.mvChat, `Ad · ${project.title.slice(0, 50)}: director's room`, () =>
    discuss({ company, product, brief: briefOf(ad), summary: ad.summary, recent, message }),
  );
  await sql`INSERT INTO ad_messages (project_id, author, content, spoken, created_by_id) VALUES (${projectId}, 'CREATOR', ${message}, ${spoken}, ${auth.userId})`;
  await sql`INSERT INTO ad_messages (project_id, author, content, spoken) VALUES (${projectId}, 'DIRECTOR', ${turn.reply}, ${spoken})`;
  await sql`UPDATE ad_projects SET summary = ${json(turn.summary)}, updated_at = now() WHERE project_id = ${projectId}`;
  return { project: await view(auth, workspaceId, projectId), reply: turn.reply };
}

/* ------------------------------------------------------------------ script → shot list */

/** The script's scenes become the studio shot list (each prompt carries the general rules). */
async function writeShotList(workspaceId: string, projectId: string, ad: AdRow, script: AdScript): Promise<void> {
  const rules = ad.rules;
  const look = [
    rules.environment && `Setting: ${rules.environment}`,
    rules.location && `Location: ${rules.location}`,
    rules.castEthnicity && `Cast: ${rules.castEthnicity}`,
    rules.costume && `Wardrobe: ${rules.costume}`,
    rules.dressSense && `Dress sense: ${rules.dressSense}`,
    rules.composure && `Composure: ${rules.composure}`,
  ]
    .filter(Boolean)
    .join('. ');
  // Old takes of replaced scenes: running ones stop (their files go with them), finished ones' files go now.
  const oldTakes = await studio.finishedTakeIds(projectId);
  await sql.begin(async (tx) => {
    await tx`UPDATE studio_takes SET status = 'CANCELED', finished_at = now() WHERE project_id = ${projectId} AND status IN ('QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING')`;
    await tx`DELETE FROM studio_scenes WHERE project_id = ${projectId}`;
    for (const [position, scene] of script.scenes.entries()) {
      const prompt = [scene.visual, scene.camera && `Camera: ${scene.camera}`, look, scene.onScreenText && `On-screen text: "${scene.onScreenText}"`].filter(Boolean).join('. ');
      await tx`
        INSERT INTO studio_scenes (project_id, position, kind, description, prompt, shot, transition, duration_sec, features_subject, lip_sync, lyric)
        VALUES (${projectId}, ${position}, 'STORY', ${scene.visual.slice(0, 1000)}, ${prompt.slice(0, 2000)}, 'medium', 'cut', ${scene.seconds},
          -- Ad cast are written characters (synthesised from the rules), not the user's likeness.
          false, false, ${(scene.line ? `${scene.speaker ? `${scene.speaker}: ` : ''}${scene.line}` : '').slice(0, 300) || null})`;
    }
  });
  await studio.dropTakeFiles(workspaceId, projectId, oldTakes);
}

export async function generateScript(auth: AuthContext, workspaceId: string, projectId: string, notes?: string) {
  const { project, ad, company, product } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'SCRIPT');
  const photos = await sql<{ key: string }[]>`
    SELECT key FROM product_assets WHERE product_id = ${product.id} AND status = 'READY' AND kind IN ('PACKSHOT', 'PHOTO', 'LOGO') ORDER BY kind = 'PACKSHOT' DESC, created_at LIMIT 2`;
  const { costs } = await getStudioSettings();
  const script = await charged(auth, workspaceId, projectId, 'AD_SCRIPT', costs.mvStoryboard, `Ad · ${project.title.slice(0, 50)}: script`, () =>
    writeScript({ company, product, brief: briefOf(ad), summary: ad.summary, productPhotoKeys: photos.map((photo) => photo.key), notes }),
  );
  await sql`UPDATE ad_projects SET script = ${json(script)}, updated_at = now() WHERE project_id = ${projectId}`;
  await writeShotList(workspaceId, projectId, ad, script);
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ shoot + master */

async function loadScene(projectId: string, sceneId: string): Promise<{ id: string; position: number; durationSec: number }> {
  const [scene] = await sql<{ id: string; position: number; durationSec: number }[]>`SELECT id, position, duration_sec FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  return scene;
}

/** Films one scene (one take; regenerate for another). dryRun = the price only. */
export async function shootScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, dryRun: boolean) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'SHOOT');
  await loadScene(projectId, sceneId);
  const result = await studio.generate(auth, workspaceId, projectId, [sceneId], 1, dryRun);
  return { estimate: result.estimate, ad: dryRun ? null : await view(auth, workspaceId, projectId) };
}

/** Picks which finished take the master uses for a scene. */
export async function pickTake(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, takeId: string) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'SHOOT');
  const [take] = await sql<{ id: string }[]>`SELECT id FROM studio_takes WHERE id = ${takeId} AND scene_id = ${sceneId} AND project_id = ${projectId} AND status = 'READY'`;
  if (!take) throw AppError.badRequest('Pick a finished take of this scene.');
  await sql`UPDATE studio_scenes SET selected_take_id = ${takeId}, updated_at = now() WHERE id = ${sceneId}`;
  return view(auth, workspaceId, projectId);
}

/** Records the scene's spoken line in its speaker's voice (charged per second of speech). */
export async function recordLine(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  const { project, ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'SHOOT');
  const scene = await loadScene(projectId, sceneId);
  const line = ad.script?.scenes[scene.position];
  if (!line?.line?.trim()) throw AppError.badRequest('This scene has no spoken line in the script.');
  const result = await recordSceneLine(auth, {
    workspaceId,
    projectId,
    projectTitle: project.title,
    sceneId,
    speaker: line.speaker,
    line: line.line,
    seconds: Number(scene.durationSec),
    rules: ad.rules,
  });
  return { ad: await view(auth, workspaceId, projectId), ...result };
}

/** Masters the ad (dryRun = price only): every scene's picked (else newest) take, the voices at their scenes. */
export async function masterAd(auth: AuthContext, workspaceId: string, projectId: string, finish: Partial<Finish> | undefined, dryRun: boolean) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'MASTER');
  if (!dryRun) {
    await sql`
      UPDATE studio_scenes s SET selected_take_id = (
        SELECT t.id FROM studio_takes t WHERE t.scene_id = s.id AND t.status = 'READY' ORDER BY t.created_at DESC LIMIT 1)
      WHERE s.project_id = ${projectId} AND (s.selected_take_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM studio_takes t2 WHERE t2.id = s.selected_take_id AND t2.status = 'READY'))`;
  }
  // Ads never pass 60 s, whatever was edited since the script.
  const [{ total } = { total: 0 }] = await sql<{ total: number }[]>`SELECT COALESCE(sum(duration_sec), 0)::float AS total FROM studio_scenes WHERE project_id = ${projectId}`;
  if (total > MAX_AD_SECONDS + 0.01) throw AppError.badRequest(`The scenes add up to ${total.toFixed(1)} s; ads are at most ${MAX_AD_SECONDS} s.`);
  const result = await studio.assemble(auth, workspaceId, projectId, finish, dryRun);
  return { estimate: result.estimate, ad: dryRun ? null : await view(auth, workspaceId, projectId) };
}

/** Pause (keep = playable preview of what's done) or cancel the running master. */
export async function stopAdMaster(auth: AuthContext, workspaceId: string, projectId: string, keep: boolean) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  await studio.cancel(auth, workspaceId, projectId, keep);
  return view(auth, workspaceId, projectId);
}

/** The end card the next master uses (free; applied when the ad is mastered). */
export async function saveEndCard(auth: AuthContext, workspaceId: string, projectId: string, card: EndCard | null) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'MASTER');
  await sql`UPDATE ad_projects SET end_card = ${card ? json(card) : null}, updated_at = now() WHERE project_id = ${projectId}`;
  return view(auth, workspaceId, projectId);
}

/** Platform versions of the current master (local rendering, no tokens). */
export async function makeVersions(auth: AuthContext, workspaceId: string, projectId: string, aspects: VersionAspect[], fit: 'blur' | 'crop') {
  const { project, ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'MASTER');
  if (project.status === 'ASSEMBLING') throw AppError.conflict('Wait for the master to finish first.');
  if (!project.outputKey) throw AppError.badRequest('Master the ad first: versions are made from the finished master.');
  const lastLog = project.engineLog?.at(-1)?.stage;
  if (lastLog === 'PREVIEW' || lastLog === 'PAUSED') throw AppError.badRequest('The master is paused. Finish it, then make the versions.');
  if (ad.versions.some((version) => (version.status === 'QUEUED' || version.status === 'RUNNING') && !isStale(version))) throw AppError.conflict('Versions are being made. Wait for them to finish.');
  const wanted = [...new Set(aspects)].filter((aspect) => aspect !== project.aspect);
  if (!wanted.length) throw AppError.badRequest(`The master is already ${project.aspect}: pick another frame.`);
  await queueVersions({ id: projectId, workspaceId, outputKey: project.outputKey }, wanted, fit);
  return view(auth, workspaceId, projectId);
}

/** Re-check: VeloBot reviews the scene's picked (or newest finished) take again, in the background. */
export async function reviewAdScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  const [take] = await sql<{ id: string }[]>`
    SELECT t.id FROM studio_takes t JOIN studio_scenes s ON s.id = t.scene_id
    WHERE t.scene_id = ${sceneId} AND s.project_id = ${projectId} AND t.status = 'READY'
    ORDER BY (t.id = s.selected_take_id) DESC, t.created_at DESC LIMIT 1`;
  if (!take) throw AppError.badRequest('This scene has no finished video to check yet.');
  await sql`UPDATE studio_takes SET review = ${json({ status: 'RUNNING', at: new Date().toISOString() })} WHERE id = ${take.id}`;
  void reviewAdTake(take.id, true);
  return view(auth, workspaceId, projectId);
}

/** Keep a flagged take anyway: the red flag goes (the review stays readable). */
export async function keepAdTake(auth: AuthContext, workspaceId: string, projectId: string, takeId: string) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  await sql`
    UPDATE studio_takes SET review = jsonb_set(review, '{dismissedAt}', ${json(new Date().toISOString())})
    WHERE id = ${takeId} AND project_id = ${projectId} AND review IS NOT NULL`;
  return view(auth, workspaceId, projectId);
}

/** The client's own edits to the script (free); held to the ad length like the director's. */
export async function saveScript(auth: AuthContext, workspaceId: string, projectId: string, input: AdScript) {
  const { ad } = await loadAd(workspaceId, projectId);
  await companyAccess(auth, workspaceId, ad.companyId, true);
  assertStage(ad, 'SCRIPT');
  const total = input.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  const limit = Math.min(MAX_AD_SECONDS, ad.lengthSec);
  if (total > limit + 0.01) throw AppError.badRequest(`The scenes add up to ${total} s; this ad is ${limit} s. Shorten a scene (or raise the length on the brief, up to ${MAX_AD_SECONDS} s).`);
  const script = { ...fitToLength(input, ad.lengthSec), engine: ad.script?.engine };
  await sql`UPDATE ad_projects SET script = ${json(script)}, updated_at = now() WHERE project_id = ${projectId}`;
  await writeShotList(workspaceId, projectId, ad, script);
  return view(auth, workspaceId, projectId);
}
