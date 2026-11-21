-- YouTube films (be/src/youtube): a separate product from the music video director.
-- A workspace connects its YouTube channels, sets up "shows" (niche, kind of film, look,
-- length, how many a week and when), and the films are written, made and published on schedule.

-- Connected YouTube channels (OAuth refresh token encrypted with utils/encryption).
CREATE TABLE IF NOT EXISTS yt_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connected_by uuid NOT NULL,
  channel_id varchar(64) NOT NULL,
  title text NOT NULL DEFAULT '',
  thumbnail_url text,
  refresh_token text NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'OK',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel_id)
);

-- A show: what to make and when to publish it.
CREATE TABLE IF NOT EXISTS yt_shows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  created_by uuid NOT NULL,
  channel_id uuid REFERENCES yt_channels(id) ON DELETE SET NULL,
  name text NOT NULL,
  niche text NOT NULL,
  film_kind varchar(24) NOT NULL,
  visual_style varchar(24) NOT NULL DEFAULT 'human',
  mood varchar(24) NOT NULL DEFAULT 'epic',
  format varchar(8) NOT NULL DEFAULT '16:9',
  length_seconds integer NOT NULL DEFAULT 60,
  language varchar(40) NOT NULL DEFAULT 'English',
  narrator varchar(40) NOT NULL DEFAULT 'Brian',
  audience text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  characters jsonb NOT NULL DEFAULT '[]'::jsonb,
  publish_days jsonb NOT NULL DEFAULT '[2, 5]'::jsonb,
  publish_times jsonb NOT NULL DEFAULT '["17:00"]'::jsonb,
  timezone varchar(64) NOT NULL DEFAULT 'Africa/Lagos',
  privacy varchar(10) NOT NULL DEFAULT 'private',
  -- AUTOPILOT: made and published on time. REVIEW: made on time, published once approved.
  mode varchar(10) NOT NULL DEFAULT 'REVIEW',
  status varchar(10) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS yt_shows_workspace ON yt_shows (workspace_id) WHERE deleted_at IS NULL;

-- One film (one upload).
CREATE TABLE IF NOT EXISTS yt_films (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id uuid NOT NULL REFERENCES yt_shows(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  -- PLANNED -> SCRIPTED -> MAKING -> READY -> PUBLISHING -> PUBLISHED; BLOCKED (no funds / no channel), FAILED.
  status varchar(12) NOT NULL DEFAULT 'PLANNED',
  publish_at timestamptz NOT NULL,
  idea text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  script jsonb,
  length_seconds integer NOT NULL,
  price_tokens integer NOT NULL DEFAULT 0,
  reservation_id uuid,
  charged_tokens integer NOT NULL DEFAULT 0,
  progress integer NOT NULL DEFAULT 0,
  stage text NOT NULL DEFAULT '',
  video_key text,
  thumbnail_key text,
  approved_at timestamptz,
  youtube_video_id varchar(32),
  published_at timestamptz,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS yt_films_show ON yt_films (show_id, publish_at);
CREATE INDEX IF NOT EXISTS yt_films_due ON yt_films (status, publish_at);
