-- Commercials studio (docs/PROGRAMME-2026-11.md, Phase 2): ads and promos
-- for businesses. A company owns products; a product owns its ad projects.
-- Every row records the user who created it (KYC / audit trail).
--
--   companies          the business account (brand kit, tone) inside a workspace
--   company_members    who may work on its ads (OWNER / EDITOR / VIEWER)
--   products           what is advertised: details, USPs, audience, price
--   product_assets     photos / logos / packshots / videos of the product
--   ad_projects        one commercial = a studio project (kind COMMERCIAL) +
--                      its objective, platform, length (≤ 60 s) and the general
--                      rules every scene inherits (setting, cast, language,
--                      accent, wardrobe…), plus the stage it is at.

ALTER TABLE studio_projects DROP CONSTRAINT IF EXISTS studio_projects_kind_check;
ALTER TABLE studio_projects ADD CONSTRAINT studio_projects_kind_check CHECK (kind IN ('AI_VIDEO', 'MUSIC_VIDEO', 'COMMERCIAL'));

CREATE TABLE IF NOT EXISTS companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            varchar(120) NOT NULL,
  legal_name      varchar(200),
  registration_no varchar(60),
  country         varchar(2),
  industry        varchar(80),
  website         varchar(300),
  description     text NOT NULL DEFAULT '',
  tone            varchar(300) NOT NULL DEFAULT '',
  brand_colours   text[] NOT NULL DEFAULT '{}',
  logo_key        varchar(600),
  created_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS companies_workspace_idx ON companies (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS company_members (
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            varchar(8) NOT NULL DEFAULT 'EDITOR' CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER')),
  invited_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            varchar(120) NOT NULL,
  category        varchar(80) NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  price           varchar(60),
  usps            text[] NOT NULL DEFAULT '{}',
  audience        jsonb NOT NULL DEFAULT '{}',
  created_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS products_company_idx ON products (company_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS product_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind            varchar(12) NOT NULL CHECK (kind IN ('PHOTO', 'LOGO', 'PACKSHOT', 'VIDEO')),
  key             varchar(600) NOT NULL DEFAULT '',
  name            varchar(200) NOT NULL,
  content_type    varchar(100) NOT NULL,
  size            bigint NOT NULL DEFAULT 0,
  status          varchar(8) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'READY')),
  created_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_assets_product_idx ON product_assets (product_id);

CREATE TABLE IF NOT EXISTS ad_projects (
  project_id      uuid PRIMARY KEY REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  stage           varchar(12) NOT NULL DEFAULT 'BRIEF'
                  CHECK (stage IN ('BRIEF', 'CHARACTERS', 'DIRECTOR', 'SCRIPT', 'SHOOT', 'MASTER')),
  objective       varchar(16) NOT NULL DEFAULT 'AWARENESS'
                  CHECK (objective IN ('AWARENESS', 'LAUNCH', 'SALES', 'APP_INSTALL', 'EVENT', 'RECRUITMENT')),
  platform        varchar(12) NOT NULL DEFAULT 'INSTAGRAM'
                  CHECK (platform IN ('INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK', 'LINKEDIN', 'TV', 'WEB')),
  length_sec      smallint NOT NULL DEFAULT 30 CHECK (length_sec BETWEEN 6 AND 60),
  goal            text NOT NULL DEFAULT '',
  call_to_action  varchar(160) NOT NULL DEFAULT '',
  rules           jsonb NOT NULL DEFAULT '{}',
  script          jsonb,
  approvals       jsonb NOT NULL DEFAULT '{}',
  created_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_projects_product_idx ON ad_projects (product_id);
