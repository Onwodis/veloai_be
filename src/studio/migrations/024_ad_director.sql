-- Commercials: the director's room. Every turn of the conversation (typed or
-- spoken) is kept, and the director maintains a running summary of what was
-- agreed, which the user approves before the script is written.
CREATE TABLE IF NOT EXISTS ad_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES ad_projects(project_id) ON DELETE CASCADE,
  author          varchar(10) NOT NULL CHECK (author IN ('CREATOR', 'DIRECTOR')),
  content         text NOT NULL,
  spoken          boolean NOT NULL DEFAULT false,
  created_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_messages_project_idx ON ad_messages (project_id, created_at);

ALTER TABLE ad_projects ADD COLUMN IF NOT EXISTS summary jsonb;
