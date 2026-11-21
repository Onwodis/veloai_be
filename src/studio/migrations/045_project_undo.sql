-- Undo / redo for every studio project (music videos, ads, AI Studio): contributions/undo.ts.
-- Each user has their own stack per project: a snapshot after every change. Undo restores the
-- one before and marks the newer one undone; redo brings it back; a new change drops what was undone.
CREATE TABLE IF NOT EXISTS project_undo (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  label text NOT NULL DEFAULT '',
  undone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_undo_stack ON project_undo (project_id, user_id, id);
