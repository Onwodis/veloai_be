-- Likeness (@me), creations, per-user storage accounting with DB-level RBAC,
-- paid storage, and the super admin's encrypted credential vault.
--
-- DB-level RBAC
--   Every table below has row-level security. User-facing queries run inside
--   a transaction that does `SET LOCAL ROLE app_rls` (a NOLOGIN role without
--   BYPASSRLS) and sets app.user_id / app.role, so Postgres itself only
--   returns and accepts the caller's own rows (super admins see all).
--   Background jobs run as the table owner, which bypasses RLS (system work).
--   Trigger functions are SECURITY DEFINER for the same reason.
--
-- Storage accounting
--   storage_objects is a ledger of every stored file (one row per R2 key).
--   Its owner is resolved in the database from the key path, and per-user
--   totals in storage_accounts are maintained by triggers, so no code path
--   can forget to count a file. User uploads are rejected by the database
--   when they would exceed the user's quota.

-- ------------------------------------------------------------------ role

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT app_rls TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO app_rls;

-- The caller's identity inside an RLS transaction ('' when unset).
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.role', true), '') = 'SUPER_ADMIN'
$$;

-- ------------------------------------------------------------------ storage

CREATE TABLE IF NOT EXISTS storage_accounts (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  used_bytes            bigint NOT NULL DEFAULT 0,
  files                 integer NOT NULL DEFAULT 0,
  -- Super admin override of the platform default quota (NULL = default).
  quota_override_bytes  bigint,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_objects (
  key           varchar(600) PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid,
  bytes         bigint NOT NULL CHECK (bytes >= 0),
  -- UPLOAD: the user sent it (hard quota); GENERATED: made for them (pre-checked).
  kind          varchar(12) NOT NULL DEFAULT 'GENERATED' CHECK (kind IN ('UPLOAD', 'GENERATED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storage_objects_user_idx ON storage_objects (user_id, created_at DESC);

-- Paid extra storage: each purchase adds `bytes` until `period_end`.
CREATE TABLE IF NOT EXISTS storage_purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference       varchar(80) NOT NULL UNIQUE,
  mode            varchar(8) NOT NULL CHECK (mode IN ('TEST', 'LIVE')),
  pack_id         varchar(40) NOT NULL,
  bytes           bigint NOT NULL,
  amount          integer NOT NULL,
  currency        varchar(8) NOT NULL,
  status          varchar(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'ABANDONED')),
  period_start    timestamptz,
  period_end      timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storage_purchases_user_idx ON storage_purchases (user_id, status, period_end);

-- Owner of an R2 key, from its path:
--   users/<uid>/…                          that user
--   avatars/<uid>/…                        that user
--   workspaces/<ws>/projects/<id>/…        the reel project's creator
--   workspaces/<ws>/studio/<id>/…          the studio project's creator
--   anything else under workspaces/<ws>/   the workspace owner
CREATE OR REPLACE FUNCTION storage_owner(object_key text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  parts text[] := string_to_array(object_key, '/');
  owner uuid;
BEGIN
  BEGIN
    IF parts[1] IN ('users', 'avatars') THEN
      RETURN parts[2]::uuid;
    END IF;
    IF parts[1] = 'workspaces' THEN
      IF parts[3] = 'projects' THEN
        SELECT created_by_id INTO owner FROM media_projects WHERE id = parts[4]::uuid;
      ELSIF parts[3] = 'studio' THEN
        SELECT created_by_id INTO owner FROM studio_projects WHERE id = parts[4]::uuid;
      END IF;
      IF owner IS NULL THEN
        SELECT user_id INTO owner FROM workspace_members WHERE workspace_id = parts[2]::uuid AND role = 'OWNER' ORDER BY created_at LIMIT 1;
      END IF;
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  RETURN owner;
END $$;

CREATE OR REPLACE FUNCTION storage_workspace(object_key text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parts text[] := string_to_array(object_key, '/');
BEGIN
  IF parts[1] = 'workspaces' THEN RETURN parts[2]::uuid; END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END $$;

-- Quota in bytes: override or platform default, plus paid storage still in its period.
CREATE OR REPLACE FUNCTION storage_quota(uid uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
           (SELECT quota_override_bytes FROM storage_accounts WHERE user_id = uid),
           COALESCE((SELECT (value->>'defaultQuotaMb')::bigint FROM platform_settings WHERE key = 'storage'), 250) * 1048576
         )
       -- A renewal bought early starts when the current period ends, so it never double-counts.
       + COALESCE((SELECT sum(bytes) FROM storage_purchases WHERE user_id = uid AND status = 'PAID' AND period_start <= now() AND period_end > now()), 0)::bigint
$$;

-- BEFORE INSERT/UPDATE: resolve the owner and enforce the hard quota on uploads.
CREATE OR REPLACE FUNCTION storage_objects_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  used bigint;
  previous bigint := 0;
  is_admin boolean;
BEGIN
  IF NEW.user_id IS NULL THEN NEW.user_id := storage_owner(NEW.key); END IF;
  IF NEW.workspace_id IS NULL THEN NEW.workspace_id := storage_workspace(NEW.key); END IF;
  IF NEW.user_id IS NOT NULL AND NEW.kind = 'UPLOAD' THEN
    SELECT role = 'SUPER_ADMIN' INTO is_admin FROM users WHERE id = NEW.user_id;
    IF NOT COALESCE(is_admin, false) THEN
      SELECT COALESCE(used_bytes, 0) INTO used FROM storage_accounts WHERE user_id = NEW.user_id;
      IF TG_OP = 'UPDATE' AND OLD.user_id = NEW.user_id THEN previous := OLD.bytes; END IF;
      IF COALESCE(used, 0) - previous + NEW.bytes > storage_quota(NEW.user_id) THEN
        RAISE EXCEPTION 'STORAGE_QUOTA_EXCEEDED' USING ERRCODE = 'P0001',
          DETAIL = format('used=%s needed=%s quota=%s', COALESCE(used, 0), NEW.bytes, storage_quota(NEW.user_id));
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- AFTER: keep per-user totals exact.
CREATE OR REPLACE FUNCTION storage_objects_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.user_id IS NOT NULL THEN
    UPDATE storage_accounts SET used_bytes = GREATEST(0, used_bytes - OLD.bytes), files = GREATEST(0, files - 1), updated_at = now() WHERE user_id = OLD.user_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') AND NEW.user_id IS NOT NULL THEN
    INSERT INTO storage_accounts (user_id, used_bytes, files) VALUES (NEW.user_id, NEW.bytes, 1)
    ON CONFLICT (user_id) DO UPDATE SET used_bytes = storage_accounts.used_bytes + EXCLUDED.used_bytes, files = storage_accounts.files + 1, updated_at = now();
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS storage_objects_before_trg ON storage_objects;
CREATE TRIGGER storage_objects_before_trg BEFORE INSERT OR UPDATE ON storage_objects FOR EACH ROW EXECUTE FUNCTION storage_objects_before();
DROP TRIGGER IF EXISTS storage_objects_after_trg ON storage_objects;
CREATE TRIGGER storage_objects_after_trg AFTER INSERT OR UPDATE OR DELETE ON storage_objects FOR EACH ROW EXECUTE FUNCTION storage_objects_after();

-- ------------------------------------------------------------------ likeness (@me)

CREATE TABLE IF NOT EXISTS likeness_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- EMPTY → ANALYZING → TRAINING → READY | FAILED
  status           varchar(12) NOT NULL DEFAULT 'EMPTY' CHECK (status IN ('EMPTY', 'ANALYZING', 'TRAINING', 'READY', 'FAILED')),
  consent_at       timestamptz,
  consent_ip       varchar(64),
  height_cm        integer,
  -- { summary, face, skeleton, body, proportions, posture, gait, voice, wardrobe, notes }
  profile          jsonb,
  -- Assets (and frames pulled from videos) that best show face / full body.
  reference_keys   text[] NOT NULL DEFAULT '{}',
  voice_key        varchar(600),
  -- { status, triggerWord, loraKey, requestId, endpoint, trainedAt, steps }
  lora             jsonb,
  fal_request      jsonb,
  workspace_id     uuid,
  reservation_id   uuid,
  tokens_charged   integer NOT NULL DEFAULT 0,
  engine           varchar(400),
  error            varchar(1000),
  analyzed_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS likeness_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          varchar(8) NOT NULL CHECK (kind IN ('PHOTO', 'VIDEO')),
  key           varchar(600) NOT NULL,
  name          varchar(255) NOT NULL,
  content_type  varchar(100) NOT NULL,
  size          bigint NOT NULL,
  -- { width, height, durationSec, hasAudio, note }
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        varchar(8) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'READY')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS likeness_assets_user_idx ON likeness_assets (user_id, created_at);

-- At most 10 likeness files per user, enforced by the database.
CREATE OR REPLACE FUNCTION likeness_assets_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM likeness_assets WHERE user_id = NEW.user_id) >= 10 THEN
    RAISE EXCEPTION 'LIKENESS_LIMIT' USING ERRCODE = 'P0001', DETAIL = 'A likeness can have at most 10 photos and videos';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS likeness_assets_limit_trg ON likeness_assets;
CREATE TRIGGER likeness_assets_limit_trg BEFORE INSERT ON likeness_assets FOR EACH ROW EXECUTE FUNCTION likeness_assets_limit();

-- ------------------------------------------------------------------ creations

CREATE TABLE IF NOT EXISTS creations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode            varchar(8) NOT NULL CHECK (mode IN ('IMAGE', 'VIDEO', 'ENHANCE')),
  prompt          text NOT NULL,
  -- The director's rewrite of the prompt (what the models actually got).
  direction       text,
  uses_me         boolean NOT NULL DEFAULT false,
  aspect          varchar(8) NOT NULL DEFAULT '9:16',
  duration_sec    real,
  source_key      varchar(600),
  options         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          varchar(12) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'DIRECTING', 'IMAGING', 'ANIMATING', 'ENHANCING', 'STORING', 'READY', 'FAILED', 'CANCELED')),
  fal_request     jsonb,
  output_key      varchar(600),
  thumb_key       varchar(600),
  output_size     bigint,
  cost            integer NOT NULL DEFAULT 0,
  reservation_id  uuid,
  engine          varchar(600),
  error           varchar(1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS creations_user_idx ON creations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS creations_status_idx ON creations (status);

-- ------------------------------------------------------------------ credential vault

CREATE TABLE IF NOT EXISTS platform_secrets (
  name           varchar(64) PRIMARY KEY,
  -- AES-256-GCM ciphertext (utils/encryption.ts); the plaintext never reaches the database.
  value_enc      text NOT NULL,
  last4          varchar(4) NOT NULL,
  updated_by_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ row-level security

ALTER TABLE storage_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE likeness_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE likeness_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_secrets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_rows ON storage_accounts;
CREATE POLICY own_rows ON storage_accounts USING (user_id = app_user_id() OR app_is_admin()) WITH CHECK (app_is_admin());
DROP POLICY IF EXISTS own_rows ON storage_objects;
CREATE POLICY own_rows ON storage_objects USING (user_id = app_user_id() OR app_is_admin()) WITH CHECK (user_id = app_user_id() OR app_is_admin());
DROP POLICY IF EXISTS own_rows ON storage_purchases;
CREATE POLICY own_rows ON storage_purchases USING (user_id = app_user_id() OR app_is_admin()) WITH CHECK (user_id = app_user_id() OR app_is_admin());
DROP POLICY IF EXISTS own_rows ON likeness_profiles;
CREATE POLICY own_rows ON likeness_profiles USING (user_id = app_user_id() OR app_is_admin()) WITH CHECK (user_id = app_user_id() OR app_is_admin());
DROP POLICY IF EXISTS own_rows ON likeness_assets;
CREATE POLICY own_rows ON likeness_assets USING (user_id = app_user_id() OR app_is_admin()) WITH CHECK (user_id = app_user_id() OR app_is_admin());
DROP POLICY IF EXISTS own_rows ON creations;
CREATE POLICY own_rows ON creations USING (user_id = app_user_id() OR app_is_admin()) WITH CHECK (user_id = app_user_id() OR app_is_admin());
-- Secrets: super admins only (the runtime reads them as the owner, outside RLS).
DROP POLICY IF EXISTS admin_only ON platform_secrets;
CREATE POLICY admin_only ON platform_secrets USING (app_is_admin()) WITH CHECK (app_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON storage_accounts, storage_objects, storage_purchases, likeness_profiles, likeness_assets, creations, platform_secrets TO app_rls;
-- Read-only lookups an RLS transaction may need.
GRANT SELECT ON platform_settings, workspace_members TO app_rls;
