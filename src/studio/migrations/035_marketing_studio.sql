-- The super admin's marketing studio: promotional images, videos, fliers and
-- app tutorials for the platform itself, planned with VeloBot (which knows
-- the products, the app's screens and the landing page's asset slots).
CREATE TABLE IF NOT EXISTS marketing_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  role         varchar(10) NOT NULL CHECK (role IN ('ADMIN', 'BOT')),
  content      text NOT NULL,
  -- BOT replies: the assets it proposes [{ kind, title, aspect, prompt, … }].
  proposals    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_messages_created_idx ON marketing_messages (created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          varchar(10) NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO', 'FLIER', 'TUTORIAL')),
  title         varchar(200) NOT NULL,
  -- The landing-page slot it fills (asset.md), if any.
  slot_id       varchar(120),
  aspect        varchar(5) NOT NULL DEFAULT '16:9',
  prompt        text NOT NULL DEFAULT '',
  -- Images / videos are made by the Create pipeline (creations row).
  creation_id   uuid,
  -- Fliers: { headline, subline, cta }; tutorials: { steps: [{ title, narration, screen, imageKey? }] }.
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PRODUCING', 'READY', 'FAILED')),
  output_key    varchar(600),
  error         varchar(600),
  message_id    uuid REFERENCES marketing_messages(id) ON DELETE SET NULL,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_assets_slot_idx ON marketing_assets (slot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_assets_created_idx ON marketing_assets (created_at DESC);
