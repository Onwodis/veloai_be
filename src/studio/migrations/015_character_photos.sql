-- Character photo shoots: high-quality stills of a cast member in a scripted
-- scene (or a free brief), made from their reference photos. A still can be
-- promoted to a scene's first frame (studio_assets PHOTO + scene photo_asset_ids).
CREATE TABLE IF NOT EXISTS mv_character_photos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  character_id    uuid NOT NULL REFERENCES mv_characters(id) ON DELETE CASCADE,
  scene_id        uuid REFERENCES studio_scenes(id) ON DELETE SET NULL,
  brief           text NOT NULL,
  aspect          varchar(8) NOT NULL DEFAULT '9:16',
  status          varchar(10) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED')),
  image_key       varchar(600),
  cost            integer NOT NULL DEFAULT 0,
  reservation_id  uuid,
  fal_result      jsonb,
  error           text,
  created_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS mv_character_photos_character_idx ON mv_character_photos (character_id, created_at DESC);
