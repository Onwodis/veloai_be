-- Public links (be/src/sharing). Every link is VIEW (stream only, nothing downloadable
-- from the page) or DOWNLOAD; the URL carries an encrypted token (link id + mode +
-- key version), never readable ids. Rotate = key_version + 1 (old URLs stop working).
CREATE TABLE IF NOT EXISTS share_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL,
  created_by_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_kind      varchar(16) NOT NULL CHECK (asset_kind IN ('PROJECT_OUTPUT', 'TAKE', 'AD_VERSION', 'ASSET')),
  -- The take id, ad version aspect or asset id ('' for the project's film).
  asset_ref       varchar(64) NOT NULL DEFAULT '',
  mode            varchar(10) NOT NULL CHECK (mode IN ('VIEW', 'DOWNLOAD')),
  title           varchar(160) NOT NULL,
  key_version     integer NOT NULL DEFAULT 1,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  views           integer NOT NULL DEFAULT 0,
  downloads       integer NOT NULL DEFAULT 0,
  last_opened_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS share_links_owner_idx ON share_links (created_by_id, created_at DESC);

-- Each user's default lifetime for new links (days; null = never expires).
CREATE TABLE IF NOT EXISTS share_link_prefs (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_days  integer CHECK (default_days IS NULL OR default_days BETWEEN 1 AND 365),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
