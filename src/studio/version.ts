/**
 * A project's change fingerprint: a hash, computed in the database, of
 * everything the project views show (the project row, the director / ad row,
 * scenes, takes with their stage and review, cast, messages, uploads).
 *
 * Pages that poll while the engine works ask for this (about 50 bytes) and
 * reload the full view (about 100 KB) only when it changes. On a slow link that
 * is the difference between seconds per poll and almost nothing.
 *
 * The heavy song analysis (mv_projects.audio_analysis) is left out of the hash:
 * the views never show it.
 */
import { sql } from './sql.js';

export async function projectVersion(workspaceId: string, projectId: string): Promise<string | null> {
  const [row] = await sql<{ version: string | null }[]>`
    SELECT md5(concat_ws('|',
      (SELECT to_jsonb(p)::text FROM studio_projects p WHERE p.id = ${projectId} AND p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL),
      (SELECT (to_jsonb(m) - 'audio_analysis')::text FROM mv_projects m WHERE m.project_id = ${projectId}),
      (SELECT to_jsonb(a)::text FROM ad_projects a WHERE a.project_id = ${projectId}),
      (SELECT string_agg(to_jsonb(s)::text, ',' ORDER BY s.position, s.id) FROM studio_scenes s WHERE s.project_id = ${projectId}),
      (SELECT string_agg(concat_ws(':', t.id, t.status, t.video_key, t.thumb_key, t.error, t.review::text, t.finished_at), ',' ORDER BY t.created_at, t.id)
         FROM studio_takes t WHERE t.project_id = ${projectId}),
      (SELECT string_agg(to_jsonb(c)::text, ',' ORDER BY c.position, c.id) FROM mv_characters c WHERE c.project_id = ${projectId}),
      (SELECT concat(count(*), ':', max(created_at)) FROM mv_messages WHERE project_id = ${projectId}),
      (SELECT concat(count(*), ':', max(created_at)) FROM ad_messages WHERE project_id = ${projectId}),
      (SELECT string_agg(concat_ws(':', id, status), ',' ORDER BY created_at, id) FROM studio_assets WHERE project_id = ${projectId})
    )) AS version
    WHERE EXISTS (SELECT 1 FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL)`;
  return row?.version ?? null;
}
