/**
 * Super-admin asset browser: every video the engine made, across all users.
 *
 *   TAKE     one generated shot of a scene (music video, ad, film)
 *   MASTER   a project's finished cut
 *
 * Filters: owner, project kind, status, VeloBot verdict, text (project title,
 * owner email or name). The detail view shows the video, what the engine was
 * asked (prompt, lyric, delivery, moves, post-processing), how it ran (stages,
 * timings, cost, the engine's error) and VeloBot's review. The operator sees
 * real engine names here (users never do).
 */
import { readUrl } from '../services/storage.service.js';
import { sql } from '../studio/sql.js';
import type { TakeReview, TakeSpec } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';

export interface AssetFilters {
  kind: 'TAKE' | 'MASTER';
  userId?: string | undefined;
  projectKind?: 'MUSIC_VIDEO' | 'COMMERCIAL' | 'AI_VIDEO' | undefined;
  status?: 'READY' | 'FAILED' | 'RUNNING' | undefined;
  review?: 'FLAG' | 'GOOD' | 'UNREVIEWED' | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

const RUNNING = ['QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING'];
const signed = (key: string | null): Promise<string | null> => (key ? readUrl(key).catch(() => null) : Promise.resolve(null));

export async function browseAssets(filters: AssetFilters) {
  const offset = (filters.page - 1) * filters.pageSize;
  const needle = filters.q?.trim() ? `%${filters.q.trim()}%` : null;
  if (filters.kind === 'MASTER') {
    const rows = await sql<
      { id: string; title: string; kind: string; status: string; aspect: string; outputKey: string; thumbKey: string | null; outputDuration: number | null; outputSize: number | null; tokensCharged: number; updatedAt: Date; ownerId: string | null; ownerEmail: string | null; ownerName: string | null; total: number }[]
    >`
      SELECT p.id, p.title, p.kind, p.status, p.aspect, p.output_key, p.thumb_key, p.output_duration, p.output_size, p.tokens_charged, p.updated_at,
        u.id AS owner_id, u.email AS owner_email, u.display_name AS owner_name, count(*) OVER ()::int AS total
      FROM studio_projects p LEFT JOIN users u ON u.id = p.created_by_id
      WHERE p.output_key IS NOT NULL AND p.deleted_at IS NULL
        ${filters.userId ? sql`AND p.created_by_id = ${filters.userId}` : sql``}
        ${filters.projectKind ? sql`AND p.kind = ${filters.projectKind}` : sql``}
        ${needle ? sql`AND (p.title ILIKE ${needle} OR u.email ILIKE ${needle} OR u.display_name ILIKE ${needle})` : sql``}
      ORDER BY p.updated_at DESC LIMIT ${filters.pageSize} OFFSET ${offset}`;
    return {
      total: rows[0]?.total ?? 0,
      items: await Promise.all(
        rows.map(async (row) => ({
          kind: 'MASTER' as const,
          id: row.id,
          status: row.status,
          title: row.title,
          project: { id: row.id, title: row.title, kind: row.kind },
          owner: row.ownerId ? { id: row.ownerId, email: row.ownerEmail, name: row.ownerName } : null,
          scene: null,
          thumbUrl: await signed(row.thumbKey),
          durationSec: row.outputDuration ? Number(row.outputDuration) : null,
          sizeBytes: row.outputSize ? Number(row.outputSize) : null,
          tokens: row.tokensCharged,
          review: null,
          error: null,
          createdAt: row.updatedAt.toISOString(),
        })),
      ),
    };
  }

  const rows = await sql<
    { id: string; status: string; thumbKey: string | null; durationSec: number | null; cost: number; error: string | null; review: TakeReview | null; createdAt: Date; editKind: string | null; lipSync: boolean | null; position: number; projectId: string; title: string; projectKind: string; ownerId: string | null; ownerEmail: string | null; ownerName: string | null; total: number }[]
  >`
    SELECT t.id, t.status, t.thumb_key, t.duration_sec, t.cost, t.error, t.review, t.created_at,
      t.spec->'edit'->>'kind' AS edit_kind, (t.spec->>'lipSync')::boolean AS lip_sync, s.position,
      p.id AS project_id, p.title, p.kind AS project_kind, u.id AS owner_id, u.email AS owner_email, u.display_name AS owner_name,
      count(*) OVER ()::int AS total
    FROM studio_takes t JOIN studio_projects p ON p.id = t.project_id JOIN studio_scenes s ON s.id = t.scene_id LEFT JOIN users u ON u.id = p.created_by_id
    WHERE p.deleted_at IS NULL
      ${filters.userId ? sql`AND p.created_by_id = ${filters.userId}` : sql``}
      ${filters.projectKind ? sql`AND p.kind = ${filters.projectKind}` : sql``}
      ${filters.status === 'RUNNING' ? sql`AND t.status = ANY(${RUNNING})` : filters.status ? sql`AND t.status = ${filters.status}` : sql``}
      ${filters.review === 'FLAG' ? sql`AND t.review->>'verdict' = 'FLAG' AND t.review->>'dismissedAt' IS NULL` : sql``}
      ${filters.review === 'GOOD' ? sql`AND t.review->>'verdict' = 'GOOD'` : sql``}
      ${filters.review === 'UNREVIEWED' ? sql`AND t.status = 'READY' AND t.review IS NULL` : sql``}
      ${needle ? sql`AND (p.title ILIKE ${needle} OR u.email ILIKE ${needle} OR u.display_name ILIKE ${needle})` : sql``}
    ORDER BY t.created_at DESC LIMIT ${filters.pageSize} OFFSET ${offset}`;
  return {
    total: rows[0]?.total ?? 0,
    items: await Promise.all(
      rows.map(async (row) => ({
        kind: 'TAKE' as const,
        id: row.id,
        status: row.status,
        title: `${row.title} · scene ${row.position + 1}`,
        project: { id: row.projectId, title: row.title, kind: row.projectKind },
        owner: row.ownerId ? { id: row.ownerId, email: row.ownerEmail, name: row.ownerName } : null,
        scene: row.position + 1,
        thumbUrl: await signed(row.thumbKey),
        durationSec: row.durationSec ? Number(row.durationSec) : null,
        sizeBytes: null,
        tokens: row.cost,
        review: row.review?.status === 'DONE' ? { verdict: row.review.verdict ?? null, score: row.review.score ?? null, summary: row.review.summary ?? null, dismissed: Boolean(row.review.dismissedAt) } : null,
        error: row.error,
        lipSync: Boolean(row.lipSync),
        editKind: row.editKind,
        createdAt: row.createdAt.toISOString(),
      })),
    ),
  };
}

/** One asset in full: playable, what was asked, how it ran, the review. */
export async function assetDetail(kind: 'TAKE' | 'MASTER', id: string) {
  if (kind === 'MASTER') {
    const [project] = await sql<{ id: string; title: string; kind: string; outputKey: string | null; thumbKey: string | null; finish: unknown; engineLog: { at: string; stage: string; engine: string; ms: number; detail?: string }[] | null; tokensCharged: number; outputDuration: number | null; outputSize: number | null; updatedAt: Date }[]>`
      SELECT id, title, kind, output_key, thumb_key, finish, engine_log, tokens_charged, output_duration, output_size, updated_at FROM studio_projects WHERE id = ${id}`;
    if (!project?.outputKey) throw AppError.notFound('Master');
    return {
      kind,
      title: project.title,
      videoUrl: await signed(project.outputKey),
      posterUrl: await signed(project.thumbKey),
      facts: [
        ['Project', `${project.title} (${project.kind.toLowerCase().replace('_', ' ')})`],
        ['Length', project.outputDuration ? `${Number(project.outputDuration).toFixed(1)} s` : '—'],
        ['Size', project.outputSize ? `${(Number(project.outputSize) / 1_048_576).toFixed(1)} MB` : '—'],
        ['Tokens charged (project)', String(project.tokensCharged)],
        ['Finished', project.updatedAt.toISOString()],
      ] as [string, string][],
      asked: { finish: project.finish },
      steps: (project.engineLog ?? []).map((step) => ({ at: step.at, stage: step.stage, engine: step.engine, ms: step.ms, detail: step.detail ?? null })),
      review: null,
    };
  }
  const [take] = await sql<{ id: string; status: string; spec: TakeSpec; falRequest: { stage: string; endpoint: string } | null; videoKey: string | null; thumbKey: string | null; durationSec: number | null; cost: number; engine: string | null; error: string | null; review: TakeReview | null; createdAt: Date; finishedAt: Date | null; title: string; position: number; moves: { characterName: string; name: string }[] | null }[]>`
    SELECT t.id, t.status, t.spec, t.fal_request, t.video_key, t.thumb_key, t.duration_sec, t.cost, t.engine, t.error, t.review, t.created_at, t.finished_at,
      p.title, s.position, s.moves
    FROM studio_takes t JOIN studio_projects p ON p.id = t.project_id JOIN studio_scenes s ON s.id = t.scene_id WHERE t.id = ${id}`;
  if (!take) throw AppError.notFound('Take');
  const spec = take.spec;
  const seconds = take.finishedAt ? Math.round((take.finishedAt.getTime() - take.createdAt.getTime()) / 1000) : null;
  return {
    kind,
    title: `${take.title} · scene ${take.position + 1}`,
    videoUrl: await signed(take.videoKey),
    posterUrl: await signed(take.thumbKey),
    facts: [
      ['Status', take.status],
      ['Engine', take.falRequest?.endpoint ?? (take.engine ? 'see the steps below' : '—')],
      ['Clip', take.durationSec ? `${Number(take.durationSec).toFixed(1)} s of ${spec.durationSec} s asked` : `${spec.durationSec} s asked`],
      ['Render time', seconds !== null ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : 'still running'],
      ['Tokens', String(take.cost)],
      ['Shot', `${spec.shot} · ${spec.aspect}`],
      ['Lip sync', spec.lipSync ? `yes${spec.performance?.emotion ? ` · ${spec.performance.emotion.toLowerCase()} delivery` : ''}${spec.performance ? ` · intensity ${spec.performance.intensity}` : ''}` : 'no'],
      ['Cast references', spec.identityElements?.length ? spec.identityElements.map((element) => element.name).join(', ') : spec.identityKeys.length ? `${spec.identityKeys.length} photo(s)` : 'none'],
      ['Song here', spec.rhythm ? `${spec.rhythm.section}, energy ${Math.round(spec.rhythm.energy * 100)}%${spec.rhythm.bpm ? `, ${spec.rhythm.bpm} BPM` : ''}` : '—'],
      ['Post-processing', spec.edit ? `${spec.edit.kind}: ${spec.edit.instruction}` : 'none'],
      ['Moves', take.moves?.length ? take.moves.map((move) => `${move.characterName}: ${move.name}`).join(' · ') : 'none'],
    ] as [string, string][],
    asked: { prompt: spec.prompt, lyric: spec.lyric ?? null, description: spec.description },
    // The take's engine trail ("keyframe: model (18 s) · animating: model (414 s) · …"), one step each.
    steps: [
      { at: take.createdAt.toISOString(), stage: 'requested', engine: '', ms: 0, detail: null as string | null },
      ...(take.engine ?? '').split(' · ').filter(Boolean).map((part) => {
        const match = /^([^:]+):\s*(.*?)(?:\s*\((\d+)\s*s\))?$/.exec(part);
        return { at: take.createdAt.toISOString(), stage: match?.[1] ?? part, engine: match?.[2] ?? '', ms: match?.[3] ? Number(match[3]) * 1000 : 0, detail: null as string | null };
      }),
      ...(take.status === 'FAILED' || take.error ? [{ at: (take.finishedAt ?? take.createdAt).toISOString(), stage: take.status.toLowerCase(), engine: '', ms: 0, detail: take.error }] : []),
    ],
    review: take.review?.status === 'DONE' ? take.review : null,
  };
}
