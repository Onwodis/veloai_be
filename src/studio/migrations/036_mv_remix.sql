-- Remix studio: a music video clip the artist uploads becomes a new short
-- clip of its main character (NEW: re-shot from the artist's script on the
-- same or an uploaded song) or the same clip with refined visuals (REFINE:
-- video-to-video edit, motion and mouth kept). The work runs on a normal
-- music video project (stage machine, takes, mixer, quick master); this row
-- tracks the remix set-up and its progress.
CREATE TABLE IF NOT EXISTS mv_remixes (
  project_id       uuid PRIMARY KEY REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  mode             varchar(8) NOT NULL CHECK (mode IN ('NEW', 'REFINE')),
  script           text NOT NULL,
  source_asset_id  uuid NOT NULL,
  -- NULL = the clip's own audio.
  audio_asset_id   uuid,
  window_start     real NOT NULL DEFAULT 0,
  window_length    real NOT NULL,
  -- { shootNow, sceneCount, genre }
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           varchar(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'READY', 'FAILED')),
  step             varchar(40) NOT NULL DEFAULT '',
  progress         real NOT NULL DEFAULT 0,
  error            varchar(600),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mv_remixes_workspace_idx ON mv_remixes (workspace_id, created_at DESC);
