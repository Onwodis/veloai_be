/**
 * The studio overview's numbers for one workspace: what was made, what it
 * cost, how it performed and when the team works. One call, every query in
 * parallel (each is a single aggregate), so the dashboard costs one round trip
 * per panel group, not per number.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, type AuthContext } from '../middleware/authenticate.js';
import { validate, validParams } from '../middleware/validate.js';
import { requireMembership } from '../services/workspace.service.js';
import { getWallet } from '../services/token.service.js';
import { sql } from './sql.js';

const DAYS = 30;
const num = (value: unknown): number => Number(value ?? 0) || 0;

export async function overviewStats(auth: AuthContext, workspaceId: string) {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId);
  const since = new Date(Date.now() - DAYS * 86_400_000);

  const [projects, takes, clips, reels, creations, tokensDaily, sharing, topProjects, hours, scores, wallet] = await Promise.all([
    sql<{ kind: string; status: string; count: number; minutes: string | null; tokens: string | null }[]>`
      SELECT kind, status, count(*)::int AS count, sum(output_duration) / 60 AS minutes, sum(tokens_charged) AS tokens
      FROM studio_projects WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL GROUP BY kind, status`,
    sql<{ day: string; count: number; seconds: string | null; tokens: string | null }[]>`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS count, sum(duration_sec) AS seconds, sum(cost) AS tokens
      FROM studio_takes WHERE workspace_id = ${workspaceId} AND status = 'READY' AND created_at >= ${since} GROUP BY 1`,
    sql<{ count: number; seconds: string | null }[]>`
      SELECT count(*)::int AS count, sum(duration_sec) AS seconds FROM mv_clips WHERE workspace_id = ${workspaceId} AND status = 'READY'`.catch(() => [{ count: 0, seconds: null }]),
    sql<{ count: number; seconds: string | null; hook: string | null }[]>`
      SELECT count(*)::int AS count, sum(end_sec - start_sec) AS seconds, avg(hook_score) AS hook FROM reels WHERE workspace_id = ${workspaceId}`.catch(() => [{ count: 0, seconds: null, hook: null }]),
    sql<{ mode: string; count: number }[]>`
      SELECT mode, count(*)::int AS count FROM creations WHERE workspace_id = ${workspaceId} AND status = 'READY' GROUP BY mode`.catch(() => []),
    sql<{ day: string; used: string | null; added: string | null }[]>`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
        sum(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS used, sum(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS added
      FROM token_ledger WHERE workspace_id = ${workspaceId} AND created_at >= ${since} GROUP BY 1`,
    sql<{ links: number; views: string | null; downloads: string | null }[]>`
      SELECT count(*)::int AS links, sum(views) AS views, sum(downloads) AS downloads FROM share_links WHERE workspace_id = ${workspaceId}`.catch(() => [{ links: 0, views: null, downloads: null }]),
    sql<{ title: string; kind: string; tokens: string | null; minutes: string | null }[]>`
      SELECT p.title, p.kind, p.tokens_charged + coalesce((SELECT sum(cost) FROM studio_takes t WHERE t.project_id = p.id AND t.status = 'READY'), 0) AS tokens,
        p.output_duration / 60 AS minutes
      FROM studio_projects p WHERE p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL ORDER BY 3 DESC NULLS LAST LIMIT 6`,
    sql<{ hour: number; weekday: number; count: number }[]>`
      SELECT extract(hour FROM created_at)::int AS hour, extract(isodow FROM created_at)::int AS weekday, count(*)::int AS count
      FROM studio_takes WHERE workspace_id = ${workspaceId} AND created_at >= ${since} GROUP BY 1, 2`,
    sql<{ score: number; count: number }[]>`
      SELECT (review->>'score')::int AS score, count(*)::int AS count FROM studio_takes
      WHERE workspace_id = ${workspaceId} AND review->>'status' = 'DONE' AND review ? 'score' GROUP BY 1`.catch(() => []),
    getWallet(workspaceId),
  ]);

  // A full 30-day calendar (days with nothing are zeros, so the charts never skip).
  const calendar = Array.from({ length: DAYS }, (_, index) => new Date(Date.now() - (DAYS - 1 - index) * 86_400_000).toISOString().slice(0, 10));
  const takesBy = new Map(takes.map((row) => [row.day, row]));
  const tokensBy = new Map(tokensDaily.map((row) => [row.day, row]));
  const daily = calendar.map((day) => ({
    day,
    takes: takesBy.get(day)?.count ?? 0,
    seconds: Math.round(num(takesBy.get(day)?.seconds)),
    used: Math.round(num(tokensBy.get(day)?.used)),
    added: Math.round(num(tokensBy.get(day)?.added)),
  }));

  const kindLabel: Record<string, string> = { AI_VIDEO: 'Films', MUSIC_VIDEO: 'Music videos', COMMERCIAL: 'Ads' };
  const byKind = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let minutes = 0;
  for (const row of projects) {
    byKind.set(kindLabel[row.kind] ?? row.kind, (byKind.get(kindLabel[row.kind] ?? row.kind) ?? 0) + row.count);
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + row.count);
    minutes += num(row.minutes);
  }
  const reelRow = reels[0];
  if (reelRow?.count) byKind.set('Reels', reelRow.count);
  const creationsTotal = creations.reduce((sum, row) => sum + row.count, 0);
  if (creationsTotal) byKind.set('Creations', creationsTotal);

  const heat = Array.from({ length: 7 }, (_, weekday) => Array.from({ length: 24 }, (__, hour) => hours.find((row) => row.weekday === weekday + 1 && row.hour === hour)?.count ?? 0));
  const scoreTotal = scores.reduce((sum, row) => sum + row.count, 0);
  const share = sharing[0];

  return {
    days: DAYS,
    totals: {
      projects: projects.reduce((sum, row) => sum + row.count, 0),
      films: byKind.get('Films') ?? 0,
      musicVideos: byKind.get('Music videos') ?? 0,
      ads: byKind.get('Ads') ?? 0,
      reels: reelRow?.count ?? 0,
      creations: creationsTotal,
      clips: clips[0]?.count ?? 0,
      takes30: daily.reduce((sum, row) => sum + row.takes, 0),
      minutesProduced: +(minutes + num(reelRow?.seconds) / 60 + num(clips[0]?.seconds) / 60).toFixed(1),
      tokensUsed30: daily.reduce((sum, row) => sum + row.used, 0),
      tokensAvailable: wallet.available,
      shareLinks: share?.links ?? 0,
      shareViews: Math.round(num(share?.views)),
      shareDownloads: Math.round(num(share?.downloads)),
      avgReviewScore: scoreTotal ? +(scores.reduce((sum, row) => sum + row.score * row.count, 0) / scoreTotal).toFixed(1) : null,
      avgHookScore: reelRow?.hook ? Math.round(num(reelRow.hook)) : null,
    },
    daily,
    byKind: [...byKind].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    byStatus: [...byStatus].map(([label, value]) => ({ label, value })),
    topProjects: topProjects.map((row) => ({ label: row.title, value: Math.round(num(row.tokens)), detail: `${kindLabel[row.kind] ?? row.kind}${row.minutes ? ` · ${num(row.minutes).toFixed(1)} min` : ''}` })),
    heat,
    reviewScores: Array.from({ length: 10 }, (_, index) => ({ label: String(index + 1), value: scores.find((row) => row.score === index + 1)?.count ?? 0 })),
  };
}
export type OverviewStats = Awaited<ReturnType<typeof overviewStats>>;

/* GET /api/v1/workspaces/:workspaceId/overview-stats  (any member) */

const params = z.strictObject({ workspaceId: z.uuid() });
export const overviewStatsRouter: Router = Router({ mergeParams: true });
overviewStatsRouter.use(authenticate);
overviewStatsRouter.get('/', validate({ params }), async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json(await overviewStats(requireAuth(req), validParams(res, params).workspaceId));
});
