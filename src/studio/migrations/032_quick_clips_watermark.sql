-- Quick mix & master clips (music videos) and the platform watermark.
--
-- 1. mv_clips: a teaser made from 1-3 consecutive scenes of a music video,
--    mixed and mastered by VeloBot, named by the user and downloaded. One row
--    per export; the film itself is never replaced.
CREATE TABLE IF NOT EXISTS mv_clips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  name             varchar(120) NOT NULL,
  scene_ids        uuid[] NOT NULL,
  status           varchar(12) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RENDERING', 'READY', 'FAILED')),
  stage            varchar(24),
  progress         integer NOT NULL DEFAULT 0,
  detail           varchar(300),
  output_key       varchar(600),
  thumb_key        varchar(600),
  duration_sec     numeric(8, 3),
  size_bytes       bigint,
  watermarked      boolean NOT NULL DEFAULT true,
  -- What VeloBot did and found (lighting matched, beat trims, warnings…).
  report           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reservation_id   uuid,
  tokens_charged   integer NOT NULL DEFAULT 0,
  error            varchar(1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS mv_clips_project_idx ON mv_clips (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mv_clips_active_idx ON mv_clips (status) WHERE status IN ('QUEUED', 'RENDERING');

-- 2. Watermark: every render carries the platform watermark until the owner
--    pays to remove it for that project (then re-renders are clean).
ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS watermark_removed_at timestamptz;
ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS watermark_removed_by_id uuid REFERENCES users(id) ON DELETE SET NULL;
