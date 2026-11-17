-- Professional portraits: once a profile photo has been on the platform for a
-- while (12 h by default), a background job makes up to 6 photoreal portraits
-- of the user in different professions. The dashboard shows watermarked
-- previews in a carousel; the full-resolution file is a paid download (from
-- the token balance, or after buying tokens). Every download is a
-- token_ledger row (PORTRAIT_DOWNLOAD) and a portrait_downloads row.
CREATE TABLE IF NOT EXISTS profile_portraits (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The avatar the portraits are (or will be) made from; a new avatar restarts the clock.
  source_key     varchar(600) NOT NULL,
  seen_at        timestamptz NOT NULL DEFAULT now(),
  status         varchar(12) NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'GENERATING', 'READY', 'FAILED')),
  -- [{ id, field, title, previewKey, fullKey }]
  items          jsonb NOT NULL DEFAULT '[]'::jsonb,
  error          varchar(600),
  generated_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profile_portraits_due_idx ON profile_portraits (seen_at) WHERE status = 'WAITING';

CREATE TABLE IF NOT EXISTS portrait_downloads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id        varchar(40) NOT NULL,
  field          varchar(60) NOT NULL,
  source_key     varchar(600) NOT NULL,
  tokens         integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_id, source_key)
);
CREATE INDEX IF NOT EXISTS portrait_downloads_user_idx ON portrait_downloads (user_id, created_at DESC);
