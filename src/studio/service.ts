/**
 * AI video studio: projects, uploads, identity, shot list, takes, assembly.
 *
 * Flow:
 *   1. create a project (AI video from a script, or music video)
 *   2. upload photos (of the creator, and optional scene photos) + music
 *   3. identity: Claude reads the creator's photos → face/body-frame profile
 *   4. shot list: written by the creator and/or planned by the director
 *   5. generate N takes per scene (token-gated), review, pick one per scene
 *   6. assemble: enhance, join with transitions, grade, master (token-gated)
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { deleteObject, deletePrefix, headObject, keys, presignPut, readUrl } from '../services/storage.service.js';
import { withMoves } from '../moves/prompt.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import { meContext, mentionsMe, replaceMe } from '../likeness/service.js';
import { trackUpload } from '../storage/ledger.js';
import { assertStorage, SIZE_ESTIMATE } from '../storage/service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { ENGINE_NAME, hideEngine } from '../utils/engineName.js';
import { sceneStarts } from './assemble.js';
import { clampText, LOOKS } from './cinema.js';
import { parseEdits, type ClipEdits } from './clipEdits.js';
import { analyzeIdentity as runIdentity, planScenes } from './director.js';
import * as fal from './fal.js';
import { assemblyRunning, enqueueAssembly, enqueueTake, pauseInterruptedAssembly } from './queue.js';
import type { CreateAssetInput, CreateStudioInput, SceneInput, UpdateStudioInput } from './schemas.js';
import { getStudioSettings } from './settings.js';
import { json, sql, type Tx } from './sql.js';
import { settleBatch, takeCost } from './takes.js';
import { sceneCasts, type SceneCast } from '../musicvideo/cast.js';
import { songContext } from '../musicvideo/songmap.js';
import { cutToRange, syncPlan } from '../musicvideo/sync.js';
import { ACTIVE_TAKE, DEFAULT_FINISH, type AssetRow, type Finish, type Identity, type ProjectRow, type SceneRow, type TakeRow, type TakeSpec } from './types.js';

/* ------------------------------------------------------------------ music rhythm for prompts */

interface StoredAnalysis {
  bpm: number | null;
  energy: number[];
  sections: { start: number; end: number; label: string }[];
}

async function songAnalysis(projectId: string, assetId: string): Promise<StoredAnalysis | null> {
  const [row] = await sql<{ audioAnalysis: Record<string, StoredAnalysis> | null }[]>`SELECT audio_analysis FROM mv_projects WHERE project_id = ${projectId}`.catch(() => []);
  return row?.audioAnalysis?.[assetId] ?? null;
}

/** Tempo, section and energy of the song under a shot (energy curve is 0.5 s windows). */
function rhythmAt(analysis: StoredAnalysis | null, start: number, duration: number): TakeSpec['rhythm'] {
  if (!analysis) return undefined;
  const from = Math.max(0, Math.floor(start / 0.5));
  const to = Math.min(analysis.energy.length, Math.ceil((start + duration) / 0.5));
  const window = analysis.energy.slice(from, Math.max(from + 1, to));
  const energy = window.length ? window.reduce((sum, value) => sum + value, 0) / window.length : 0.5;
  const section = analysis.sections.find((item) => start + duration / 2 >= item.start && start + duration / 2 < item.end)?.label ?? 'Verse';
  return { bpm: analysis.bpm, section, energy: +energy.toFixed(2) };
}

/* ------------------------------------------------------------------ access */

async function access(auth: AuthContext, workspaceId: string, write: boolean): Promise<void> {
  if (auth.role === 'SUPER_ADMIN') return;
  await requireMembership(auth.userId, workspaceId, write ? ['OWNER', 'EDITOR'] : undefined);
}

async function loadProject(workspaceId: string, projectId: string): Promise<ProjectRow> {
  const [row] = await sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!row) throw AppError.notFound('Project');
  return row;
}

const assertEditable = (project: ProjectRow): void => {
  if (project.status === 'ASSEMBLING') throw AppError.conflict('The film is being assembled. Wait for it to finish (or cancel it) before editing.');
};

/* ------------------------------------------------------------------ views */

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

async function takeView(take: TakeRow) {
  return {
    id: take.id,
    status: take.status,
    /** A failed take with paid fal.ai results (or a saved first frame) can resume without paying again. */
    resumable: take.status === 'FAILED' && (Object.keys(take.outputs ?? {}).length > 0 || Boolean(take.keyframeKey)),
    edit: take.spec.edit ? { kind: take.spec.edit.kind, sourceTakeId: take.spec.edit.sourceTakeId } : null,
    durationSec: take.durationSec,
    cost: take.cost,
    error: hideEngine(take.error),
    engine: hideEngine(take.engine),
    // VeloBot's review (music videos): flags + proposed fixes for the storyboard.
    review: take.review
      ? {
          ...take.review,
          summary: hideEngine(take.review.summary),
          issues: take.review.issues?.map((issue) => ({ ...issue, detail: hideEngine(issue.detail) })),
        }
      : null,
    createdAt: take.createdAt.toISOString(),
    finishedAt: iso(take.finishedAt),
    videoUrl: take.videoKey ? await readUrl(take.videoKey) : null,
    thumbUrl: take.thumbKey ? await readUrl(take.thumbKey) : null,
    keyframeUrl: take.keyframeKey ? await readUrl(take.keyframeKey) : null,
  };
}

async function assetView(asset: AssetRow) {
  return {
    id: asset.id,
    role: asset.role,
    name: asset.name,
    contentType: asset.contentType,
    size: Number(asset.size),
    meta: asset.meta,
    status: asset.status,
    url: asset.status === 'READY' ? await readUrl(asset.key) : null,
    createdAt: asset.createdAt.toISOString(),
  };
}

function summary(project: ProjectRow) {
  return {
    id: project.id,
    kind: project.kind,
    title: project.title,
    status: project.status,
    aspect: project.aspect,
    progress: project.progress,
    stage: project.stage,
    tokensCharged: project.tokensCharged,
    /** A stop was asked for and the engine is winding down (a few seconds). */
    cancelRequested: project.cancelRequested,
    error: hideEngine(project.error),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    finishedAt: iso(project.finishedAt),
  };
}

async function fullView(project: ProjectRow) {
  const [assets, scenes, takes, settings] = await Promise.all([
    sql<AssetRow[]>`SELECT * FROM studio_assets WHERE project_id = ${project.id} ORDER BY created_at`,
    sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE project_id = ${project.id} ORDER BY position`,
    sql<TakeRow[]>`SELECT * FROM studio_takes WHERE project_id = ${project.id} AND status <> 'CANCELED' ORDER BY created_at`,
    getStudioSettings(),
  ]);
  const starts = sceneStarts(scenes);
  return {
    ...summary(project),
    brief: project.brief,
    finish: { ...DEFAULT_FINISH, ...project.finish },
    identity: project.identity ? { ...project.identity, engine: hideEngine(project.identity.engine) } : null,
    consentAt: iso(project.consentAt),
    musicAssetId: project.musicAssetId,
    assets: await Promise.all(assets.map(assetView)),
    scenes: await Promise.all(
      scenes.map(async (scene, index) => ({
        id: scene.id,
        position: scene.position,
        description: scene.description,
        prompt: scene.prompt,
        shot: scene.shot,
        transition: scene.transition,
        durationSec: scene.durationSec,
        featuresSubject: scene.featuresSubject,
        lipSync: scene.lipSync,
        photoAssetIds: scene.photoAssetIds,
        selectedTakeId: scene.selectedTakeId,
        kind: scene.kind ?? 'STORY',
        characterIds: scene.characterIds ?? [],
        costume: scene.costume ?? null,
        location: scene.location ?? null,
        timeOfDay: scene.timeOfDay ?? null,
        lyric: scene.lyric ?? null,
        transitionMode: scene.transitionMode ?? 'AI',
        subtitles: scene.subtitles ?? true,
        edits: parseEdits(scene.edits),
        mode: scene.mode ?? null,
        emotion: scene.emotion ?? null,
        intensity: scene.intensity ?? null,
        voiceAssetId: scene.voiceAssetId ?? null,
        moves: scene.moves ?? [],
        approvedAt: iso(scene.approvedAt ?? null),
        shotApprovedAt: iso(scene.shotApprovedAt ?? null),
        startsAt: starts[index] ?? 0,
        takes: await Promise.all(takes.filter((take) => take.sceneId === scene.id).map(takeView)),
      })),
    ),
    output: project.outputKey
      ? {
          videoUrl: await readUrl(project.outputKey),
          downloadUrl: await readUrl(project.outputKey, `${project.title}.mp4`),
          thumbUrl: project.thumbKey ? await readUrl(project.thumbKey) : null,
          durationSec: project.outputDuration,
          sizeBytes: project.outputSize ? Number(project.outputSize) : null,
        }
      : null,
    // Users see "the film engine", never the providers / models (utils/engineName.ts).
    engineLog: project.engineLog.slice(-60).map((entry) => ({ ...entry, engine: hideEngine(entry.engine), ...(entry.detail ? { detail: hideEngine(entry.detail) } : {}) })),
    rates: {
      ...settings.costs,
      imageToVideoDurations: settings.models.imageToVideo.durations,
      textToVideoDurations: settings.models.textToVideo.durations,
      maxTakesPerRequest: settings.limits.maxTakesPerRequest,
      maxScenes: settings.limits.maxScenes,
      maxPhotos: settings.limits.maxPhotos,
      generationAvailable: fal.falConfigured(),
    },
  };
}
export type StudioProjectView = Awaited<ReturnType<typeof fullView>>;

/* ------------------------------------------------------------------ projects */

export async function listProjects(auth: AuthContext, workspaceId: string, page: number, pageSize: number) {
  await access(auth, workspaceId, false);
  const [rows, [count]] = await Promise.all([
    sql<(ProjectRow & { scenes: number; thumbKeyAny: string | null })[]>`
      SELECT p.*, (SELECT count(*)::int FROM studio_scenes s WHERE s.project_id = p.id) AS scenes,
        COALESCE(p.thumb_key, (SELECT t.thumb_key FROM studio_takes t WHERE t.project_id = p.id AND t.status = 'READY' ORDER BY t.created_at DESC LIMIT 1)) AS thumb_key_any
      FROM studio_projects p WHERE p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL AND p.kind <> 'COMMERCIAL'
      ORDER BY p.updated_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    // Commercials live on their company's page, not in the studio list.
    sql<{ total: number }[]>`SELECT count(*)::int AS total FROM studio_projects WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND kind <> 'COMMERCIAL'`,
  ]);
  return {
    items: await Promise.all(rows.map(async (row) => ({ ...summary(row), scenes: row.scenes, thumbUrl: row.thumbKeyAny ? await readUrl(row.thumbKeyAny) : null, hasOutput: Boolean(row.outputKey) }))),
    page,
    pageSize,
    total: count?.total ?? 0,
    totalPages: Math.max(1, Math.ceil((count?.total ?? 0) / pageSize)),
  };
}

export async function createProject(auth: AuthContext, workspaceId: string, input: CreateStudioInput) {
  await access(auth, workspaceId, true);
  const [row] = await sql<ProjectRow[]>`
    INSERT INTO studio_projects (workspace_id, created_by_id, kind, title, aspect, brief, finish, category)
    VALUES (${workspaceId}, ${auth.userId}, ${input.kind}, ${input.title}, ${input.aspect}, ${json(input.brief)}, ${json(DEFAULT_FINISH)}, ${input.category})
    RETURNING *`;
  return fullView(row!);
}

export async function getProject(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, false);
  return fullView(await loadProject(workspaceId, projectId));
}

export async function updateProject(auth: AuthContext, workspaceId: string, projectId: string, input: UpdateStudioInput) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  const brief = input.brief ? { ...project.brief, ...input.brief } : project.brief;
  const finish = input.finish ? { ...DEFAULT_FINISH, ...project.finish, ...input.finish } : project.finish;
  const [row] = await sql<ProjectRow[]>`
    UPDATE studio_projects SET title = ${input.title ?? project.title}, aspect = ${input.aspect ?? project.aspect},
      brief = ${json(brief)}, finish = ${json(finish)}, updated_at = now()
    WHERE id = ${projectId} RETURNING *`;
  return fullView(row!);
}

/**
 * Delete = move to the bin (soft delete): running work stops, the project
 * disappears for its owners, and files are kept so a super admin can restore
 * it. The daily purge removes binned projects (rows + files) after 30 days.
 */
export async function deleteProject(auth: AuthContext, workspaceId: string, projectId: string): Promise<void> {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  await cancelActive(projectId);
  if (project.assemblyReservationId) await releaseSystem(project.assemblyReservationId, workspaceId).catch(() => undefined);
  await sql`
    UPDATE studio_projects SET deleted_at = now(), deleted_by_id = ${auth.userId}, status = CASE WHEN status = 'ASSEMBLING' THEN 'DRAFT' ELSE status END,
      assembly_reservation_id = NULL, cancel_requested = true
    WHERE id = ${projectId}`;
  logger.info({ projectId, by: auth.userId }, 'studio project moved to the bin');
}

/** Removes a project for good: rows (cascade) and every stored file. */
export async function purgeProject(projectId: string): Promise<void> {
  const [project] = await sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${projectId}`;
  if (!project) return;
  await sql`DELETE FROM studio_projects WHERE id = ${projectId}`;
  await deletePrefix(`${keys.studio(project.workspaceId, projectId)}/`).catch((error: unknown) => logger.warn({ err: error, projectId }, 'studio file cleanup failed'));
}

export const BIN_DAYS = 30;

/** Scheduled: purges projects that have been in the bin for BIN_DAYS. */
export async function purgeExpiredBin(): Promise<number> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM studio_projects WHERE deleted_at < now() - make_interval(days => ${BIN_DAYS})`;
  for (const row of rows) await purgeProject(row.id);
  return rows.length;
}

/** Super admin: everything in the bin, with the owner and who deleted it. */
export async function listBin() {
  const rows = await sql<
    { id: string; title: string; kind: string; workspaceId: string; workspaceName: string | null; deletedAt: Date; ownerEmail: string | null; ownerName: string | null; deletedByEmail: string | null; createdAt: Date }[]
  >`
    SELECT p.id, p.title, p.kind, p.workspace_id, w.name AS workspace_name, p.deleted_at, p.created_at,
      owner.email AS owner_email, owner.display_name AS owner_name, deleter.email AS deleted_by_email
    FROM studio_projects p
    LEFT JOIN workspaces w ON w.id = p.workspace_id
    LEFT JOIN users owner ON owner.id = p.created_by_id
    LEFT JOIN users deleter ON deleter.id = p.deleted_by_id
    WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC LIMIT 500`;
  return rows.map((row) => ({
    ...row,
    deletedAt: row.deletedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    purgeAt: new Date(row.deletedAt.getTime() + BIN_DAYS * 86_400_000).toISOString(),
  }));
}

export async function restoreProject(projectId: string): Promise<void> {
  const updated = await sql`UPDATE studio_projects SET deleted_at = NULL, deleted_by_id = NULL, cancel_requested = false, updated_at = now() WHERE id = ${projectId} AND deleted_at IS NOT NULL RETURNING id`;
  if (updated.length === 0) throw AppError.notFound('Deleted project');
}

/** Stops queued/running takes (fal requests are cancelled by their workers on the next poll). */
async function cancelActive(projectId: string): Promise<number> {
  const rows = await sql`UPDATE studio_takes SET status = 'CANCELED', finished_at = now() WHERE project_id = ${projectId} AND status IN ${sql(ACTIVE_TAKE as TakeRow['status'][])} RETURNING id`;
  return rows.length;
}

/**
 * Stops the queued/running takes of some scenes (a "Stop" on a scene). fal.ai
 * requests are cancelled by their workers on the next poll; the worker removes
 * whatever it had already stored. Returns the canceled take ids.
 */
export async function cancelScenes(projectId: string, sceneIds: string[]): Promise<string[]> {
  if (sceneIds.length === 0) return [];
  const rows = await sql<{ id: string; reservationId: string | null; workspaceId: string }[]>`
    UPDATE studio_takes SET status = 'CANCELED', finished_at = now()
    WHERE project_id = ${projectId} AND scene_id = ANY(${sceneIds}::uuid[]) AND status IN ${sql(ACTIVE_TAKE as TakeRow['status'][])}
    RETURNING id, reservation_id, workspace_id`;
  // Batches whose takes were all queued (never picked up) are settled here: their workers never run.
  const batches = new Map(rows.flatMap((row) => (row.reservationId ? [[row.reservationId, row.workspaceId] as const] : [])));
  for (const [reservationId, workspaceId] of batches) await settleBatch(reservationId, workspaceId).catch(() => undefined);
  return rows.map((row) => row.id);
}

/** Scene numbers (1-based) of these scenes that already have a take being generated. */
async function busyScenes(db: Tx, projectId: string, sceneIds: string[]): Promise<number[]> {
  if (sceneIds.length === 0) return [];
  const rows = await db<{ position: number }[]>`
    SELECT DISTINCT s.position FROM studio_takes t JOIN studio_scenes s ON s.id = t.scene_id
    WHERE t.project_id = ${projectId} AND t.scene_id = ANY(${sceneIds}::uuid[]) AND t.status IN ${db(ACTIVE_TAKE as TakeRow['status'][])}
    ORDER BY s.position`;
  return rows.map((row) => row.position + 1);
}

const busyError = (positions: number[]): AppError =>
  AppError.conflict(
    `Scene ${positions.join(', ')} ${positions.length === 1 ? 'is' : 'are'} already generating. Wait for ${positions.length === 1 ? 'it' : 'them'} to finish, or press Stop first.`,
  );

/** Refuses to start a second generation for a scene that is already generating. */
export async function assertScenesIdle(projectId: string, sceneIds: string[]): Promise<void> {
  // Same query outside a transaction (a TransactionSql is the plain tagged template plus savepoint).
  const busy = await busyScenes(sql as unknown as Tx, projectId, sceneIds);
  if (busy.length) throw busyError(busy);
}

/**
 * Finished (not running) takes of these scenes, or of the whole project. Read
 * before their scenes are deleted: the rows cascade away, the files do not.
 * Running takes clean up after themselves when their worker sees them canceled.
 */
export async function finishedTakeIds(projectId: string, sceneIds?: string[]): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM studio_takes WHERE project_id = ${projectId} AND status NOT IN ${sql(ACTIVE_TAKE as TakeRow['status'][])}
      ${sceneIds ? sql`AND scene_id = ANY(${sceneIds}::uuid[])` : sql``}`;
  return rows.map((row) => row.id);
}

/** Removes takes' stored files (keyframe, clip, poster, audio) from the bucket. */
export async function dropTakeFiles(workspaceId: string, projectId: string, takeIds: string[]): Promise<void> {
  for (const takeId of takeIds) {
    await deletePrefix(`${keys.studio(workspaceId, projectId)}/takes/${takeId}/`).catch((error: unknown) => logger.warn({ err: error, takeId }, 'take files not deleted'));
  }
}

/** keep = stop the assembly but publish what's done so far as a playable preview. */
export async function cancel(auth: AuthContext, workspaceId: string, projectId: string, keep = false) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  // Everything that costs stops: takes still filming are cancelled (the engine is told to stop on its
  // next poll; only stages it already rendered are charged), and the cut stops (keep = preview what's done).
  const canceled = await cancelActive(projectId);
  if (project.status === 'ASSEMBLING') {
    await sql`UPDATE studio_projects SET cancel_requested = true, cancel_keep = ${keep} WHERE id = ${projectId}`;
    // No live worker on this cut (lost to a restart / crash): nobody would answer the flag, so it is paused here.
    if (!(await assemblyRunning(projectId))) {
      await pauseInterruptedAssembly({ id: projectId, workspaceId, outputKey: project.outputKey, assemblyReservationId: project.assemblyReservationId });
    }
  }
  // Batches whose remaining takes were all canceled are settled now (the workers may never pick them up again).
  const batches = await sql<{ reservationId: string }[]>`SELECT DISTINCT reservation_id FROM studio_takes WHERE project_id = ${projectId} AND reservation_id IS NOT NULL AND settled = false`;
  for (const batch of batches) await settleBatch(batch.reservationId, workspaceId).catch(() => undefined);
  logger.info({ projectId, canceled }, 'studio work canceled');
  return fullView(await loadProject(workspaceId, projectId));
}

/* ------------------------------------------------------------------ assets */

export async function createAsset(auth: AuthContext, workspaceId: string, projectId: string, input: CreateAssetInput) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  if (input.role === 'VIDEO') {
    const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_assets WHERE project_id = ${projectId} AND role = 'VIDEO'`;
    if (count >= 40) throw AppError.badRequest('A project can hold up to 40 reference videos. Remove some first.');
  }
  if (input.role === 'PHOTO') {
    const { limits } = await getStudioSettings();
    const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_assets WHERE project_id = ${projectId} AND role = 'PHOTO'`;
    if (count >= limits.maxPhotos) throw AppError.badRequest(`A project can hold up to ${limits.maxPhotos} photos. Remove some first.`);
  }
  await assertStorage(auth, input.size, 'this upload');
  const meta = { ...input.meta, ...(input.role === 'PHOTO' && input.meta.subject === undefined ? { subject: true } : {}) };
  const [asset] = await sql<AssetRow[]>`
    INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta)
    VALUES (${projectId}, ${workspaceId}, ${input.role}, '', ${input.fileName}, ${input.contentType}, ${input.size}, ${json(meta)})
    RETURNING *`;
  const key = keys.studioAsset(workspaceId, projectId, asset!.id, input.fileName);
  await sql`UPDATE studio_assets SET key = ${key} WHERE id = ${asset!.id}`;
  return { asset: await assetView({ ...asset!, key }), uploadUrl: await presignPut(key, input.contentType) };
}

export async function completeAsset(auth: AuthContext, workspaceId: string, projectId: string, assetId: string) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  const [asset] = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${assetId} AND project_id = ${projectId}`;
  if (!asset) throw AppError.notFound('File');
  const head = await headObject(asset.key);
  if (!head) throw AppError.badRequest('The file has not finished uploading.');
  if (head.size !== Number(asset.size)) throw AppError.badRequest('The uploaded file size does not match. Upload it again.');
  // Counted against the project's creator; the database refuses it when their storage is full.
  await trackUpload(asset.key, head.size, () => removeAsset(projectId, assetId));
  await sql`UPDATE studio_assets SET status = 'READY' WHERE id = ${assetId}`;
  if (asset.role === 'MUSIC') {
    // One soundtrack per project: the new upload replaces the old one.
    const previous = project.musicAssetId && project.musicAssetId !== assetId ? project.musicAssetId : null;
    await sql`UPDATE studio_projects SET music_asset_id = ${assetId}, updated_at = now() WHERE id = ${projectId}`;
    if (previous) await removeAsset(projectId, previous);
  }
  return fullView(await loadProject(workspaceId, projectId));
}

export async function updateAsset(auth: AuthContext, workspaceId: string, projectId: string, assetId: string, patch: { subject?: boolean | undefined; caption?: string | undefined }) {
  await access(auth, workspaceId, true);
  await loadProject(workspaceId, projectId);
  const [asset] = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${assetId} AND project_id = ${projectId}`;
  if (!asset) throw AppError.notFound('File');
  const meta = { ...asset.meta, ...(patch.subject !== undefined ? { subject: patch.subject } : {}), ...(patch.caption !== undefined ? { caption: patch.caption } : {}) };
  await sql`UPDATE studio_assets SET meta = ${json(meta)} WHERE id = ${assetId}`;
  return fullView(await loadProject(workspaceId, projectId));
}

async function removeAsset(projectId: string, assetId: string): Promise<void> {
  const [asset] = await sql<AssetRow[]>`DELETE FROM studio_assets WHERE id = ${assetId} AND project_id = ${projectId} RETURNING *`;
  if (!asset) return;
  await sql`UPDATE studio_scenes SET photo_asset_ids = array_remove(photo_asset_ids, ${assetId}::uuid) WHERE project_id = ${projectId}`;
  // Music video characters reference photos / videos too.
  await sql`UPDATE mv_characters SET media_asset_ids = array_remove(media_asset_ids, ${assetId}::uuid) WHERE project_id = ${projectId} AND ${assetId}::uuid = ANY(media_asset_ids)`;
  await sql`UPDATE studio_projects SET music_asset_id = NULL WHERE id = ${projectId} AND music_asset_id = ${assetId}`;
  if (asset.key) await deleteObject(asset.key);
}

export async function deleteAsset(auth: AuthContext, workspaceId: string, projectId: string, assetId: string) {
  await access(auth, workspaceId, true);
  assertEditable(await loadProject(workspaceId, projectId));
  await removeAsset(projectId, assetId);
  return fullView(await loadProject(workspaceId, projectId));
}

/* ------------------------------------------------------------------ identity */

async function subjectPhotos(projectId: string): Promise<AssetRow[]> {
  const photos = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE project_id = ${projectId} AND role = 'PHOTO' AND status = 'READY' ORDER BY created_at`;
  return photos.filter((photo) => photo.meta.subject !== false);
}

export async function analyzeIdentity(auth: AuthContext, workspaceId: string, projectId: string, ip: string | null) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  const photos = await subjectPhotos(projectId);
  if (photos.length === 0) throw AppError.badRequest('Upload at least one photo of yourself (marked "This is me") first.');
  const { costs } = await getStudioSettings();
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_IDENTITY', costs.identity, { projectId, photos: photos.length });
  try {
    const result = await runIdentity(photos.map((photo) => photo.key));
    const chosen = result.bestPhotos.length ? result.bestPhotos.map((index) => photos[index]!.id) : photos.slice(0, 4).map((photo) => photo.id);
    const identity: Identity = { profile: result.profile, photoAssetIds: chosen, notes: result.notes, samePerson: result.samePerson, analyzedAt: new Date().toISOString(), engine: result.engine };
    await settleSystem(reservation.id, workspaceId, costs.identity, `AI video · ${project.title.slice(0, 60)}: identity profile`);
    await sql`
      UPDATE studio_projects SET identity = ${json(identity)}, consent_at = now(), consent_ip = ${ip}, tokens_charged = tokens_charged + ${reservation.unmetered ? 0 : costs.identity}, updated_at = now()
      WHERE id = ${projectId}`;
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  return fullView(await loadProject(workspaceId, projectId));
}

/** Creator edits to the written profile (e.g. "I'm 1.88 m, athletic"). */
export async function updateIdentityProfile(auth: AuthContext, workspaceId: string, projectId: string, profile: string) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  if (!project.identity) throw AppError.badRequest('Analyse your photos first.');
  await sql`UPDATE studio_projects SET identity = ${json({ ...project.identity, profile })}, updated_at = now() WHERE id = ${projectId}`;
  return fullView(await loadProject(workspaceId, projectId));
}

/* ------------------------------------------------------------------ scenes */

/** Writes the shot list; returns the finished takes of removed scenes (their files go after commit). */
async function writeScenes(tx: Tx, projectId: string, scenes: SceneInput[], validPhotos: Set<string>): Promise<string[]> {
  const keep = scenes.flatMap((scene) => (scene.id ? [scene.id] : []));
  const dropped = await tx<{ id: string }[]>`
    SELECT id FROM studio_takes WHERE project_id = ${projectId} AND status NOT IN ${tx(ACTIVE_TAKE as TakeRow['status'][])} AND NOT (scene_id = ANY(${keep}::uuid[]))`;
  // Removed scenes go (with their takes); running takes on them are canceled first.
  await tx`UPDATE studio_takes SET status = 'CANCELED', finished_at = now()
    WHERE project_id = ${projectId} AND status IN ${tx(ACTIVE_TAKE as TakeRow['status'][])} AND NOT (scene_id = ANY(${keep}::uuid[]))`;
  await tx`DELETE FROM studio_scenes WHERE project_id = ${projectId} AND NOT (id = ANY(${keep}::uuid[]))`;
  for (const [position, scene] of scenes.entries()) {
    const photos = scene.photoAssetIds.filter((id) => validPhotos.has(id));
    const values = {
      description: scene.description,
      prompt: scene.prompt ?? null,
      shot: scene.shot,
      transition: scene.transition,
      durationSec: scene.durationSec,
      featuresSubject: scene.featuresSubject,
      lipSync: scene.lipSync && scene.featuresSubject,
    };
    const updated = scene.id
      ? await tx`UPDATE studio_scenes SET ${tx(values)}, position = ${position}, photo_asset_ids = ${photos}::uuid[], updated_at = now() WHERE id = ${scene.id} AND project_id = ${projectId} RETURNING id`
      : [];
    if (updated.length === 0) {
      await tx`
        INSERT INTO studio_scenes (project_id, position, description, prompt, shot, transition, duration_sec, features_subject, lip_sync, photo_asset_ids)
        VALUES (${projectId}, ${position}, ${values.description}, ${values.prompt}, ${values.shot}, ${values.transition}, ${values.durationSec},
          ${values.featuresSubject}, ${values.lipSync}, ${photos}::uuid[])`;
    }
  }
  return dropped.map((row) => row.id);
}

export async function saveScenes(auth: AuthContext, workspaceId: string, projectId: string, scenes: SceneInput[]) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  const { limits } = await getStudioSettings();
  if (scenes.length > limits.maxScenes) throw AppError.badRequest(`A project can have up to ${limits.maxScenes} scenes.`);
  const photos = await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE project_id = ${projectId} AND role = 'PHOTO'`;
  const dropped = await sql.begin((tx) => writeScenes(tx, projectId, scenes, new Set(photos.map((photo) => photo.id))));
  await dropTakeFiles(workspaceId, projectId, dropped);
  await sql`UPDATE studio_projects SET updated_at = now() WHERE id = ${projectId}`;
  return fullView(await loadProject(workspaceId, projectId));
}

export async function direct(auth: AuthContext, workspaceId: string, projectId: string, mode: 'plan' | 'refine', sceneCount?: number) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  const [existing, photos, music, settings] = await Promise.all([
    sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE project_id = ${projectId} ORDER BY position`,
    sql<AssetRow[]>`SELECT * FROM studio_assets WHERE project_id = ${projectId} AND role = 'PHOTO' AND status = 'READY' ORDER BY created_at`,
    project.musicAssetId ? sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${project.musicAssetId}` : Promise.resolve([] as AssetRow[]),
    getStudioSettings(),
  ]);
  if (mode === 'plan' && project.kind === 'AI_VIDEO' && !project.brief.script?.trim()) throw AppError.badRequest('Write the script first.');
  if (mode === 'refine' && existing.length === 0) throw AppError.badRequest('Add at least one scene description first.');
  if (mode === 'plan' && project.kind === 'MUSIC_VIDEO' && !project.brief.style?.trim() && existing.length === 0) throw AppError.badRequest('Describe the video (story, places, mood) first.');

  const scenePhotos = photos.filter((photo) => photo.meta.subject === false);
  const songSeconds = music[0]?.meta.durationSec ? music[0].meta.durationSec - (project.brief.songStart ?? 0) : undefined;
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_DIRECTOR', settings.costs.director, { projectId, mode });
  try {
    const plan = await planScenes({
      // Commercials plan through their own director (commercials/adDirector.ts); here they read like an AI video.
      kind: project.kind === 'COMMERCIAL' ? 'AI_VIDEO' : project.kind,
      aspect: project.aspect,
      style: project.brief.style,
      identity: project.identity?.profile ?? (await meContext(project.createdById ?? auth.userId))?.description,
      script: project.kind === 'AI_VIDEO' ? project.brief.script : project.brief.style,
      ...(mode === 'refine' ? { scenes: existing.map((scene) => ({ description: scene.description, shot: scene.shot, transition: scene.transition, durationSec: scene.durationSec })) } : {}),
      targetSeconds: songSeconds,
      sceneCount: mode === 'refine' ? existing.length : sceneCount,
      photoCaptions: scenePhotos.map((photo) => photo.meta.caption || photo.name),
    });
    const next: SceneInput[] = plan.scenes.slice(0, settings.limits.maxScenes).map((scene, index) => {
      const keepId = mode === 'refine' ? existing[index]?.id : undefined;
      const photo = scene.photoIndex >= 0 ? scenePhotos[scene.photoIndex] : undefined;
      return {
        ...(keepId ? { id: keepId } : {}),
        description: scene.description.slice(0, 1000),
        prompt: scene.prompt.slice(0, 2000),
        shot: scene.shot,
        transition: scene.transition,
        durationSec: scene.durationSec,
        featuresSubject: scene.featuresSubject,
        lipSync: project.kind === 'MUSIC_VIDEO' && scene.lipSync && scene.featuresSubject,
        photoAssetIds: mode === 'refine' ? (existing[index]?.photoAssetIds ?? []) : photo ? [photo.id] : [],
      };
    });
    const dropped = await sql.begin((tx) => writeScenes(tx, projectId, next, new Set(photos.map((photo) => photo.id))));
    await dropTakeFiles(workspaceId, projectId, dropped);
    await settleSystem(reservation.id, workspaceId, settings.costs.director, `AI video · ${project.title.slice(0, 60)}: shot list (${next.length} scenes)`);
    await sql`
      UPDATE studio_projects SET tokens_charged = tokens_charged + ${reservation.unmetered ? 0 : settings.costs.director},
        engine_log = engine_log || ${json([{ at: new Date().toISOString(), stage: 'DIRECTOR', engine: plan.engine, ms: 0, detail: `${mode}: ${next.length} scene(s)` }])}, updated_at = now()
      WHERE id = ${projectId}`;
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  return fullView(await loadProject(workspaceId, projectId));
}

/* ------------------------------------------------------------------ takes */

export async function generate(auth: AuthContext, workspaceId: string, projectId: string, sceneIds: string[], takesPerScene: number, dryRun: boolean) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  const settings = await getStudioSettings();
  if (takesPerScene > settings.limits.maxTakesPerRequest) throw AppError.badRequest(`Up to ${settings.limits.maxTakesPerRequest} takes per scene at a time.`);
  const all = await sql<SceneRow[]>`SELECT * FROM studio_scenes WHERE project_id = ${projectId} ORDER BY position`;
  const wanted = all.filter((scene) => sceneIds.includes(scene.id));
  if (wanted.length === 0) throw AppError.badRequest('Choose at least one scene.');

  const assets = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE project_id = ${projectId} AND status = 'READY'`;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const projectIdentityKeys = (project.identity?.photoAssetIds ?? []).flatMap((id) => (byId.get(id) ? [byId.get(id)!.key] : []));
  // @me: the creator's saved likeness stands in when the project has no identity of its own
  // (and is what any scene written with "@me" is about).
  const me = await meContext(project.createdById ?? auth.userId);
  const identityKeys = projectIdentityKeys.length ? projectIdentityKeys : (me?.referenceKeys ?? []);
  const identityProfile = project.identity?.profile ?? me?.description;
  const music = project.musicAssetId ? byId.get(project.musicAssetId) : undefined;
  const starts = sceneStarts(all);

  // Music video director: each scene's cast (characters + costume) drives identity.
  const casts = project.kind === 'MUSIC_VIDEO' ? await sceneCasts(projectId, wanted) : new Map<string, SceneCast>();
  // The song's analysis (tempo, sections, energy) so each shot moves with its part of the song.
  const analysis = project.kind === 'MUSIC_VIDEO' && project.musicAssetId ? await songAnalysis(projectId, project.musicAssetId) : null;
  const [mvOptions] =
    project.kind === 'MUSIC_VIDEO' ? await sql<{ creativeMode: boolean }[]>`SELECT creative_mode FROM mv_projects WHERE project_id = ${projectId}` : [];
  // Lyrics moved onto the edited mix's timeline (the transcript is timed on the original song;
  // after DAW cuts the words under a shot are different).
  const mixLines = project.kind === 'MUSIC_VIDEO' ? (await songContext(projectId, { analyse: false })).lines : [];
  /** The lyric lines sung inside [start, start + seconds) of the mix, timed from the shot start. */
  const sungIn = (start: number, seconds: number): { text: string; vocals: { start: number; end: number }[] } | null => {
    const lines = mixLines.filter((line) => line.text.trim() && line.end > start && line.start < start + seconds);
    if (!mixLines.length) return null;
    return {
      text: lines.map((line) => line.text.trim()).join(' / '),
      vocals: lines.map((line) => ({ start: Math.max(0, line.start - start), end: Math.min(seconds, line.end - start) })),
    };
  };

  const specs = wanted.map((scene) => {
    const cast = casts.get(scene.id);
    if (cast) {
      const sceneKey = scene.photoAssetIds.map((id) => byId.get(id)?.key).find(Boolean);
      if (scene.lipSync && !music) throw AppError.badRequest(`Scene ${scene.position + 1} is lip-synced: upload the song first.`);
      const sceneStart = (project.brief.songStart ?? 0) + (starts[all.indexOf(scene)] ?? 0);
      // Lip-sync audio covers the whole clip the model renders (it can run past the scene; trimmed at assembly).
      const sung = scene.lipSync ? sungIn(sceneStart, Math.max(10, scene.durationSec)) : null;
      // The words heard under the scene itself (not the rendered tail): what the shot answers to.
      const heard = sungIn(sceneStart, scene.durationSec);
      const spec: TakeSpec = {
        kind: project.kind,
        aspect: project.aspect,
        rhythm: rhythmAt(analysis, sceneStart, scene.durationSec),
        creative: mvOptions?.creativeMode ?? false,
        musicVideo: true,
        description: scene.description,
        // The characters' moves, woven in as human performance direction.
        prompt: withMoves(scene.prompt ?? scene.description, scene.moves),
        shot: scene.shot,
        durationSec: scene.durationSec,
        featuresSubject: cast.referenceKeys.length > 0,
        lipSync: scene.lipSync && cast.referenceKeys.length > 0,
        style: cast.style ?? project.brief.style,
        identityProfile: cast.profile || undefined,
        identityKeys: cast.referenceKeys,
        identityElements: cast.elements.length ? cast.elements : undefined,
        sceneKey,
        music: scene.lipSync && music ? { key: music.key, start: sceneStart, ...(sung ? { vocals: sung.vocals } : {}) } : undefined,
        lyric: (heard?.text || scene.lyric || '').slice(0, 400) || undefined,
        performance: scene.lipSync ? { emotion: scene.emotion ?? null, intensity: scene.intensity ?? 2 } : undefined,
      };
      return { scene, spec, cost: takeCost(settings, spec) };
    }
    const sceneKey = scene.photoAssetIds.map((id) => byId.get(id)?.key).find(Boolean);
    const featuresSubject = scene.featuresSubject || mentionsMe(scene.description) || mentionsMe(scene.prompt);
    const needsIdentity = featuresSubject && !sceneKey;
    if (needsIdentity && identityKeys.length === 0) {
      throw AppError.badRequest(`Scene ${scene.position + 1} features you: build your likeness on the My likeness page (or upload photos here and run "Analyse my look"), or attach a scene photo.`);
    }
    if (scene.lipSync && !music) throw AppError.badRequest(`Scene ${scene.position + 1} is lip-synced: upload the song first.`);
    const useLora = needsIdentity && !projectIdentityKeys.length && me?.lora ? me.lora : null;
    const spec: TakeSpec = {
      kind: project.kind,
      aspect: project.aspect,
      description: replaceMe(scene.description),
      prompt: withMoves(replaceMe(scene.prompt ?? scene.description), scene.moves),
      shot: scene.shot,
      durationSec: scene.durationSec,
      featuresSubject,
      lipSync: scene.lipSync,
      style: project.brief.style,
      identityProfile: featuresSubject ? identityProfile : undefined,
      identityKeys: featuresSubject ? identityKeys : [],
      sceneKey,
      music: scene.lipSync && music ? { key: music.key, start: (project.brief.songStart ?? 0) + (starts[all.indexOf(scene)] ?? 0) } : undefined,
      ...(useLora ? { likeness: { loraKey: useLora.key, triggerWord: useLora.triggerWord } } : {}),
    };
    return { scene, spec, cost: takeCost(settings, spec) };
  });

  const total = specs.reduce((sum, item) => sum + item.cost * takesPerScene, 0);
  const bytes = specs.reduce((sum, item) => sum + (SIZE_ESTIMATE.keyframe + item.spec.durationSec * SIZE_ESTIMATE.videoPerSecond) * takesPerScene, 0);
  const estimate = { takes: specs.length * takesPerScene, tokens: total, bytes: Math.round(bytes), perScene: specs.map((item) => ({ sceneId: item.scene.id, tokensPerTake: item.cost })) };
  if (dryRun) return { estimate, project: null };
  if (!fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', `Video generation is not switched on yet (the ${ENGINE_NAME} is not connected). Ask the platform operator.`);
  // One generation per scene at a time: a double click must not pay for two videos.
  await assertScenesIdle(projectId, specs.map((item) => item.scene.id));
  await assertStorage(auth, bytes, 'these takes');

  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_TAKES', total, { projectId, scenes: specs.length, takesPerScene });
  const ids: string[] = [];
  try {
    await sql.begin(async (tx) => {
      // Checked again under a per-project lock: two requests arriving together are serialised,
      // the second sees the first one's takes and is refused (its reservation is released below).
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`studio-takes:${projectId}`}))`;
      const busy = await busyScenes(tx, projectId, specs.map((item) => item.scene.id));
      if (busy.length) throw busyError(busy);
      for (const item of specs) {
        for (let index = 0; index < takesPerScene; index += 1) {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO studio_takes (scene_id, project_id, workspace_id, spec, cost, reservation_id)
            VALUES (${item.scene.id}, ${projectId}, ${workspaceId}, ${json(item.spec)}, ${item.cost}, ${reservation.id}) RETURNING id`;
          ids.push(row!.id);
        }
      }
    });
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  await sql`UPDATE studio_projects SET updated_at = now(), status = CASE WHEN status = 'FAILED' THEN 'DRAFT' ELSE status END WHERE id = ${projectId}`;
  for (const id of ids) await enqueueTake(id);
  return { estimate, project: await fullView(await loadProject(workspaceId, projectId)) };
}

/**
 * Resumes a failed take from its saved fal.ai results: finished stages are
 * reused (fal.ai is not charged again), only what's left runs. Tokens are
 * reserved again and charged only if the take finishes.
 */
export async function resumeTake(auth: AuthContext, workspaceId: string, projectId: string, takeId: string) {
  await access(auth, workspaceId, true);
  await loadProject(workspaceId, projectId);
  const [take] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId} AND project_id = ${projectId}`;
  if (!take) throw AppError.notFound('Take');
  if (take.status !== 'FAILED') throw AppError.badRequest('Only failed takes can be resumed.');
  await assertScenesIdle(projectId, [take.sceneId]);
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_TAKES', take.cost, { projectId, resume: takeId });
  // Only the first of two quick clicks flips FAILED → QUEUED; the other is released.
  const resumed = await sql`
    UPDATE studio_takes SET status = 'QUEUED', error = NULL, finished_at = NULL, settled = false, reservation_id = ${reservation.id}
    WHERE id = ${takeId} AND status = 'FAILED' RETURNING id`;
  if (resumed.length === 0) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw AppError.conflict('This take is already being resumed.');
  }
  await enqueueTake(takeId);
  return fullView(await loadProject(workspaceId, projectId));
}

export async function selectTake(auth: AuthContext, workspaceId: string, projectId: string, takeId: string) {
  await access(auth, workspaceId, true);
  assertEditable(await loadProject(workspaceId, projectId));
  const [take] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId} AND project_id = ${projectId}`;
  if (!take) throw AppError.notFound('Take');
  if (take.status !== 'READY') throw AppError.badRequest('Only finished takes can be picked.');
  // Picking the selected take again un-picks it.
  await sql`UPDATE studio_scenes SET selected_take_id = CASE WHEN selected_take_id = ${takeId}::uuid THEN NULL ELSE ${takeId}::uuid END, updated_at = now() WHERE id = ${take.sceneId}`;
  return fullView(await loadProject(workspaceId, projectId));
}

export async function deleteTake(auth: AuthContext, workspaceId: string, projectId: string, takeId: string) {
  await access(auth, workspaceId, true);
  assertEditable(await loadProject(workspaceId, projectId));
  const [take] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId} AND project_id = ${projectId}`;
  if (!take) throw AppError.notFound('Take');
  if (ACTIVE_TAKE.includes(take.status)) {
    // Running: cancel (the worker stops the fal request and settles the batch).
    await sql`UPDATE studio_takes SET status = 'CANCELED', finished_at = now() WHERE id = ${takeId}`;
  } else {
    await sql`UPDATE studio_scenes SET selected_take_id = NULL WHERE selected_take_id = ${takeId}`;
    // Keep billed rows for the ledger trail; hide them as CANCELED and drop the files.
    await sql`UPDATE studio_takes SET status = 'CANCELED' WHERE id = ${takeId}`;
    await deletePrefix(`${keys.studio(workspaceId, projectId)}/takes/${takeId}/`).catch(() => undefined);
  }
  return fullView(await loadProject(workspaceId, projectId));
}

/* ------------------------------------------------------------------ clip edits (CapCut-style) */

/** Saves one scene's clip edits (speed, trim-in, look, adjust, zoom, text). Free: rendered at assembly. */
export async function setClipEdits(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, edits: ClipEdits) {
  await access(auth, workspaceId, true);
  assertEditable(await loadProject(workspaceId, projectId));
  const updated = await sql`UPDATE studio_scenes SET edits = ${json(edits)}, updated_at = now() WHERE id = ${sceneId} AND project_id = ${projectId} RETURNING id`;
  if (updated.length === 0) throw AppError.notFound('Scene');
  await sql`UPDATE studio_projects SET updated_at = now() WHERE id = ${projectId}`;
  return fullView(await loadProject(workspaceId, projectId));
}

/* ------------------------------------------------------------------ post-processing */

export type EditKind = 'remove-text' | 'likeness' | 'fix-artifacts' | 'custom';

/** What every edit keeps, so a targeted fix never turns into a different shot. */
const KEEP = 'Keep everything else exactly as it is: the same people, faces, bodies, wardrobe, motion, timing, camera move, framing, light and background. Real-life look, no added glow or retouching.';

function editInstruction(kind: EditKind, note: string | undefined, references: number, who: string | undefined): string {
  const extra = note?.trim() ? ` ${note.trim()}` : '';
  switch (kind) {
    case 'remove-text':
      return `Remove every subtitle, caption, watermark, logo and any other on-screen text or graphic. Fill those areas with the natural background so nothing looks retouched.${extra} ${KEEP}`;
    case 'likeness': {
      const refs = Array.from({ length: references }, (_, index) => `@Image${index + 1}`).join(', ');
      return `Make ${who ? `${who} (the person in the video)` : 'the person in the video'} look exactly like the person in ${refs}: the same face shape, eyes, nose, lips, jawline, skin tone and skin texture with its real imperfections, hairline and hair, body frame and proportions. Do not beautify.${extra} ${KEEP}`;
    }
    case 'fix-artifacts':
      return `Fix every visual glitch: faces that smear or warp when the head turns, distorted or extra fingers, flickering or blurry teeth and mouth, morphing objects or clothing, sliding feet. The face must stay solid and identical from every angle.${extra} ${KEEP}`;
    default:
      return `${note?.trim() ?? ''} Keep everything not mentioned exactly as it is: same people, motion, timing, camera and light. Real-life look.`.trim();
  }
}

/**
 * Post-processes a finished take into a NEW take (the original stays, so the
 * artist can compare and pick): removes on-screen text, makes a character
 * match their photos, fixes glitches, or follows a free instruction. Lip sync
 * is re-run on the edited clip when the take was lip-synced (the edit can
 * soften mouth shapes). Token-gated like any take; charged only if it lands.
 */
export async function postProcessTake(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  takeId: string,
  input: { kind: EditKind; note?: string | undefined; characterId?: string | undefined; relipSync?: boolean | undefined; dryRun?: boolean | undefined },
) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  const [source] = await sql<TakeRow[]>`SELECT * FROM studio_takes WHERE id = ${takeId} AND project_id = ${projectId}`;
  if (!source) throw AppError.notFound('Take');
  if (source.status !== 'READY' || !source.videoKey) throw AppError.badRequest('Only a finished take can be post-processed.');
  const seconds = source.durationSec ?? source.spec.durationSec;
  if (seconds < 3 || seconds > 10.5) throw AppError.badRequest('Post-processing works on clips of 3 to 10 seconds.');
  if (input.kind === 'custom' && (input.note?.trim().length ?? 0) < 5) throw AppError.badRequest('Describe the change you want (at least a few words).');

  // "Look more like": the character's own reference photos (music video) or the creator's.
  let referenceKeys: string[] = [];
  let who: string | undefined;
  if (input.kind === 'likeness') {
    if (input.characterId) {
      const [character] = await sql<{ name: string; referenceKeys: string[] }[]>`SELECT name, reference_keys FROM mv_characters WHERE id = ${input.characterId} AND project_id = ${projectId}`;
      if (!character) throw AppError.notFound('Character');
      referenceKeys = character.referenceKeys;
      who = character.name;
    } else {
      referenceKeys = source.spec.identityKeys;
    }
    if (referenceKeys.length === 0) throw AppError.badRequest('That character has no reference photos yet: add photos and build the casting sheet first.');
  }

  const settings = await getStudioSettings();
  if (!settings.models.videoEdit.enabled) throw AppError.badRequest('Video post-processing is switched off in the console.');
  const relipSync = (input.relipSync ?? true) && source.spec.lipSync && Boolean(source.spec.music);
  const spec: TakeSpec = {
    ...source.spec,
    lipSync: relipSync,
    edit: {
      sourceTakeId: source.id,
      sourceVideoKey: source.videoKey,
      seconds,
      kind: input.kind,
      instruction: clampText(editInstruction(input.kind, input.note, Math.min(4, referenceKeys.length), who), 2400),
      referenceKeys: referenceKeys.slice(0, 4),
    },
  };
  const cost = takeCost(settings, spec);
  if (input.dryRun) return { estimate: { tokens: cost }, project: null };
  if (!fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', `Video generation is not switched on yet (the ${ENGINE_NAME} is not connected). Ask the platform operator.`);
  await assertStorage(auth, Math.round(seconds * SIZE_ESTIMATE.videoPerSecond), 'this edit');
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_TAKES', cost, { projectId, edit: input.kind, sourceTakeId: takeId });
  let id: string;
  try {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO studio_takes (scene_id, project_id, workspace_id, spec, cost, reservation_id)
      VALUES (${source.sceneId}, ${projectId}, ${workspaceId}, ${json(spec)}, ${cost}, ${reservation.id}) RETURNING id`;
    id = row!.id;
  } catch (error) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  }
  await enqueueTake(id);
  return { estimate: { tokens: cost }, project: await fullView(await loadProject(workspaceId, projectId)) };
}

/* ------------------------------------------------------------------ assembly */

export async function assemble(auth: AuthContext, workspaceId: string, projectId: string, finishPatch: Partial<Finish> | undefined, dryRun: boolean) {
  await access(auth, workspaceId, true);
  const project = await loadProject(workspaceId, projectId);
  assertEditable(project);
  // The AI-master report is the server's own (never taken from the request).
  const finish: Finish = { ...DEFAULT_FINISH, ...project.finish, ...finishPatch, aiReport: project.finish?.aiReport };
  if (!(finish.look in LOOKS)) finish.look = DEFAULT_FINISH.look;
  const scenes = await sql<(SceneRow & { takeDuration: number | null; takeStatus: string | null })[]>`
    SELECT s.*, t.duration_sec AS take_duration, t.status AS take_status FROM studio_scenes s
    LEFT JOIN studio_takes t ON t.id = s.selected_take_id
    WHERE s.project_id = ${projectId} AND (${project.kind} <> 'MUSIC_VIDEO' OR s.shot_approved_at IS NOT NULL)
    ORDER BY s.position`;
  if (scenes.length === 0) throw AppError.badRequest('Add scenes and generate takes first.');
  const missing = scenes.filter((scene) => scene.takeStatus !== 'READY').map((scene) => scene.position + 1);
  if (missing.length) throw AppError.badRequest(`Pick a take for every scene first (missing: scene ${missing.join(', ')}). Delete scenes you don't want in the film.`);
  if (project.kind === 'MUSIC_VIDEO' && !project.musicAssetId) throw AppError.badRequest('Upload the song first.');

  const settings = await getStudioSettings();
  // Start / end markers: only the shots inside the range are cut, enhanced and charged.
  if (project.kind === 'MUSIC_VIDEO' && finish.range) {
    const [song] = await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${project.musicAssetId}`;
    const plan = await syncPlan(projectId, song?.key ?? null, Math.max(0, project.brief.songStart ?? 0)).catch(() => null);
    const froms = plan && plan.shots.length === scenes.length ? plan.shots.map((shot) => shot.songFrom) : sceneStarts(scenes);
    const cuts = cutToRange(scenes.map((scene) => scene.durationSec), froms, finish.range);
    if (cuts.length === 0) throw AppError.badRequest('No locked shot falls inside the start / end markers. Widen the range.');
    const kept = cuts.map((cut) => ({ ...scenes[cut.index]!, durationSec: cut.length }));
    scenes.splice(0, scenes.length, ...kept);
  }
  const total = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const upscaleSeconds = finish.enhance && settings.models.upscale.enabled ? scenes.reduce((sum, scene) => sum + Math.ceil(scene.takeDuration ?? scene.durationSec), 0) : 0;
  // Music video foley: AI action sounds per shot, mixed under the song.
  const [mvOptions] = project.kind === 'MUSIC_VIDEO' ? await sql<{ foley: boolean }[]>`SELECT foley FROM mv_projects WHERE project_id = ${projectId}` : [];
  const foleySeconds = mvOptions?.foley && settings.models.foley.enabled ? scenes.reduce((sum, scene) => sum + Math.ceil(scene.durationSec), 0) : 0;
  const tokens = Math.ceil(total / 60) * settings.costs.assemblyPerMinute + upscaleSeconds * settings.costs.upscalePerSecond + foleySeconds * settings.costs.foleyPerSecond;
  // Master + upscaled intermediates are stored with the film.
  const bytes = Math.round(total * (finish.resolution === '2160p' ? SIZE_ESTIMATE.assembly4kPerSecond : SIZE_ESTIMATE.assemblyPerSecond) + upscaleSeconds * SIZE_ESTIMATE.videoPerSecond);
  const estimate = { seconds: total, scenes: scenes.length, upscaleSeconds, foleySeconds, tokens, bytes };
  if (dryRun) return { estimate, project: null };

  await assertStorage(auth, bytes, 'the finished film');
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_ASSEMBLY', tokens, { projectId, seconds: total, upscaleSeconds });
  const updated = await sql`
    UPDATE studio_projects SET status = 'ASSEMBLING', stage = 'QUEUED', progress = 0, error = NULL, cancel_requested = false, cancel_keep = false,
      finish = ${json(finish)}, assembly_reservation_id = ${reservation.id}, updated_at = now()
    WHERE id = ${projectId} AND status <> 'ASSEMBLING' RETURNING id`;
  if (updated.length === 0) {
    await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw AppError.conflict('This film is already being assembled.');
  }
  await enqueueAssembly(projectId);
  return { estimate, project: await fullView(await loadProject(workspaceId, projectId)) };
}
