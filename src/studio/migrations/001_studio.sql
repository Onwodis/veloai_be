-- AI video studio: script/photo videos and music videos.
--
--   studio_projects  one video being made (kind AI_VIDEO or MUSIC_VIDEO)
--   studio_assets    uploaded photos / music, and generated audio segments
--   studio_scenes    the shot list, in order, with camera + transition
--   studio_takes     generated candidates per scene; the creator picks one
--
-- Written for direct SQL (postgres.js), not Prisma.

CREATE TABLE IF NOT EXISTS studio_projects (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  kind                    varchar(16) NOT NULL CHECK (kind IN ('AI_VIDEO', 'MUSIC_VIDEO')),
  title                   varchar(120) NOT NULL,
  -- DRAFT → (takes generate per scene) → ASSEMBLING → READY | FAILED
  status                  varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ASSEMBLING', 'READY', 'FAILED')),
  aspect                  varchar(8) NOT NULL DEFAULT '16:9' CHECK (aspect IN ('16:9', '9:16', '1:1')),
  -- { script, style, mood, songStart }
  brief                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- { profile, photoAssetIds[], analyzedAt, engine }
  identity                jsonb,
  consent_at              timestamptz,
  consent_ip              varchar(64),
  music_asset_id          uuid,
  -- { look, grain, letterbox, enhance, musicVolume, fadeOut }
  finish                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress                integer NOT NULL DEFAULT 0,
  stage                   varchar(32),
  output_key              varchar(512),
  thumb_key               varchar(512),
  output_duration         real,
  output_size             bigint,
  assembly_reservation_id uuid,
  tokens_charged          integer NOT NULL DEFAULT 0,
  cancel_requested        boolean NOT NULL DEFAULT false,
  error                   varchar(1000),
  engine_log              jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz
);
CREATE INDEX IF NOT EXISTS studio_projects_workspace_idx ON studio_projects (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_projects_status_idx ON studio_projects (status);

CREATE TABLE IF NOT EXISTS studio_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- PHOTO: picture of the creator or for a scene; MUSIC: the song / soundtrack
  role          varchar(12) NOT NULL CHECK (role IN ('PHOTO', 'MUSIC')),
  key           varchar(512) NOT NULL,
  name          varchar(255) NOT NULL,
  content_type  varchar(100) NOT NULL,
  size          bigint NOT NULL,
  -- { width, height, durationSec, subject: true when it shows the creator }
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        varchar(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'READY')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_assets_project_idx ON studio_assets (project_id, role);

CREATE TABLE IF NOT EXISTS studio_scenes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  -- What the creator wrote.
  description       text NOT NULL,
  -- Cinematic prompt the director expanded it into (editable).
  prompt            text,
  shot              varchar(24) NOT NULL DEFAULT 'medium',
  transition        varchar(16) NOT NULL DEFAULT 'crossfade',
  duration_sec      real NOT NULL DEFAULT 5,
  features_subject  boolean NOT NULL DEFAULT true,
  lip_sync          boolean NOT NULL DEFAULT false,
  photo_asset_ids   uuid[] NOT NULL DEFAULT '{}',
  selected_take_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_scenes_project_idx ON studio_scenes (project_id, position);

CREATE TABLE IF NOT EXISTS studio_takes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id        uuid NOT NULL REFERENCES studio_scenes(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status          varchar(12) NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING', 'READY', 'FAILED', 'CANCELED')),
  -- Scene settings frozen at request time, so later edits don't change a running take.
  spec            jsonb NOT NULL,
  -- In-flight fal.ai request { stage, requestId, statusUrl, responseUrl } (resumed after a restart).
  fal_request     jsonb,
  keyframe_key    varchar(512),
  video_key       varchar(512),
  thumb_key       varchar(512),
  duration_sec    real,
  -- Tokens this take costs when it succeeds; billed per reservation batch.
  cost            integer NOT NULL DEFAULT 0,
  reservation_id  uuid,
  settled         boolean NOT NULL DEFAULT false,
  engine          varchar(300),
  error           varchar(1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS studio_takes_scene_idx ON studio_takes (scene_id, created_at);
CREATE INDEX IF NOT EXISTS studio_takes_status_idx ON studio_takes (status);
CREATE INDEX IF NOT EXISTS studio_takes_reservation_idx ON studio_takes (reservation_id);
