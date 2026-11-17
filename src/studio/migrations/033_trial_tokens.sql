-- Trial tokens: a one-time grant per user (amount and length set by the super
-- admin; default 20 tokens for 7 days). What is left of the grant when it ends
-- is taken back (purchased tokens are never touched). Every movement is also a
-- token_ledger row (task types TRIAL / TRIAL_EXPIRY).
CREATE TABLE IF NOT EXISTS trial_grants (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tokens         integer NOT NULL CHECK (tokens >= 0),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  reclaimed      integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trial_grants_due_idx ON trial_grants (expires_at) WHERE ended_at IS NULL;

-- Watermark removals: what was paid for which project (also in token_ledger).
CREATE TABLE IF NOT EXISTS watermark_removals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  tokens          integer NOT NULL,
  video_tokens    integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watermark_removals_workspace_idx ON watermark_removals (workspace_id, created_at DESC);
