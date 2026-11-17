-- Cold open: a short narrated film VeloBot directs to play BEFORE the song
-- (a story set-up, not the scenes acted out): 2-5 shots with a voice-over
-- (text to speech), on-screen text and film effects, rendered into one clip
-- the master puts in front of the music video.
CREATE TABLE IF NOT EXISTS mv_prologues (
  project_id    uuid PRIMARY KEY REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- { logline, narrator, bed, shots: [{ id, seconds, narration, prompt, shot, characterIds, effect, text }] }
  plan          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Played before the song in the master.
  enabled       boolean NOT NULL DEFAULT true,
  status        varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FILMING', 'READY', 'FAILED')),
  step          varchar(80) NOT NULL DEFAULT '',
  progress      real NOT NULL DEFAULT 0,
  error         varchar(600),
  output_key    varchar(600),
  thumb_key     varchar(600),
  duration_sec  real,
  tokens        integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
