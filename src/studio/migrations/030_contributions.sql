-- Contributions (be/src/contributions): checkpoints of a project's editable state.
--   PUSH     someone saved their work as a checkpoint (auto-written summary)
--   AUTO     pushed automatically (the author's "push for me" setting)
--   REVERT   the state before an earlier push was brought back
--   RESTORE  an earlier checkpoint was brought back
-- A push by anyone other than the project's creator waits in the creator's
-- inbox (status OPEN) until it is accepted (pulled) or reverted.
CREATE TABLE IF NOT EXISTS project_pushes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES project_pushes(id) ON DELETE SET NULL,
  kind            varchar(8) NOT NULL CHECK (kind IN ('PUSH', 'AUTO', 'REVERT', 'RESTORE')),
  message         varchar(300) NOT NULL DEFAULT '',
  summary         varchar(600) NOT NULL,
  changes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot        jsonb NOT NULL,
  status          varchar(9) NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('OPEN', 'ACCEPTED', 'REVERTED')),
  reviewed_by_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_pushes_project_idx ON project_pushes (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_pushes_inbox_idx ON project_pushes (project_id) WHERE status = 'OPEN';

-- Each user's "push for me" setting (when leaving a stage, and after 4 minutes of editing).
CREATE TABLE IF NOT EXISTS push_prefs (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_push   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
