-- Music video director: a staged, approval-gated production on top of the
-- studio engine (studio_projects / assets / scenes / takes / assembly).
--
-- Stages (each must be approved before the next unlocks):
--   SONG → SOUND → CHARACTERS → SCENES → DISCUSSION → STORYBOARD → SHOOT → MASTER
--
--   mv_projects     1:1 with a MUSIC_VIDEO studio project: vision, stage, approvals,
--                   DAW edit list, lyrics, auto ("I trust your judgement") mode
--   mv_characters   lead / co-leads / second lead / vixens / supporting cast, with
--                   detailed attributes, costumes, reference media, AI casting sheet
--                   and the artist's per-character permission (consent) record
--   mv_messages     the director's room: the creator and the AI director debating
--   studio_scenes   + kind (INTRO / STORY / OUTRO), cast, costume, location, approvals

CREATE TABLE IF NOT EXISTS mv_projects (
  project_id          uuid PRIMARY KEY REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  genre               varchar(60) NOT NULL DEFAULT '',
  -- How the artist wants it to look and feel; references, era, places, colours.
  vision              text NOT NULL DEFAULT '',
  mood                varchar(200) NOT NULL DEFAULT '',
  -- SOLO / DUO / TRIO / GROUP: how many people the lead act is.
  lead_act            varchar(8) NOT NULL DEFAULT 'SOLO' CHECK (lead_act IN ('SOLO', 'DUO', 'TRIO', 'GROUP')),
  stage               varchar(12) NOT NULL DEFAULT 'SONG'
                      CHECK (stage IN ('SONG', 'SOUND', 'CHARACTERS', 'SCENES', 'DISCUSSION', 'STORYBOARD', 'SHOOT', 'MASTER')),
  -- { SONG: iso, SOUND: iso, ... } when each stage was approved.
  approvals           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The untouched upload; studio_projects.music_asset_id points at the working mix.
  original_song_id    uuid,
  -- DAW: { regions: [{ id, op: cut|gain|swap, start, end, gainDb, swapWith }], layers: [{ id, assetId, at, gainDb, fadeIn, fadeOut, trimStart, trimEnd }] }
  audio_edits         jsonb NOT NULL DEFAULT '{"regions":[],"layers":[]}'::jsonb,
  mix_rendered_at     timestamptz,
  -- Integrated loudness target for the master (LUFS); -14 = streaming standard.
  loudness_lufs       real NOT NULL DEFAULT -14 CHECK (loudness_lufs BETWEEN -30 AND -6),
  -- [{ s, e, w }] word timings of the sung lyrics + the plain text.
  lyrics              jsonb,
  -- "I trust your judgement": generate, pick and stitch everything.
  auto_mode           boolean NOT NULL DEFAULT false,
  auto_by             jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mv_characters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  position            integer NOT NULL DEFAULT 0,
  role                varchar(16) NOT NULL CHECK (role IN ('LEAD', 'CO_LEAD', 'SECOND_LEAD', 'VIXEN', 'SUPPORTING', 'DANCER', 'EXTRA')),
  name                varchar(80) NOT NULL,
  -- True for the artist(s) themselves.
  is_artist           boolean NOT NULL DEFAULT false,
  -- Detailed casting attributes (gender, age range, height, build, skin tone, hair incl. bald,
  -- facial hair, eyes, marks/tattoos, glam level, persona, signature moves, notes).
  attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{ id, name, description, palette, accessories, footwear }]
  costumes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- studio_assets (PHOTO / VIDEO) of this person.
  media_asset_ids     uuid[] NOT NULL DEFAULT '{}',
  -- R2 keys the image model receives (photos + frames pulled from videos), best first.
  reference_keys      text[] NOT NULL DEFAULT '{}',
  -- AI casting sheet (editable) and the prompt fragment used in every shot they're in.
  profile             text,
  prompt              text,
  cast_engine         varchar(200),
  consent_at          timestamptz,
  consent_by          uuid,
  consent_ip          varchar(64),
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mv_characters_project_idx ON mv_characters (project_id, position);

CREATE TABLE IF NOT EXISTS mv_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  author              varchar(10) NOT NULL CHECK (author IN ('CREATOR', 'DIRECTOR')),
  content             text NOT NULL,
  -- Director only: [{ title, artist, year, director, why }] real videos cited.
  refs                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Director only: [{ id, sceneId|null, summary, change: { description?, shot?, transition?, durationSec?, location?, costume? } , applied }]
  proposals           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mv_messages_project_idx ON mv_messages (project_id, created_at);

-- Scenes gain music-video structure.
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS kind varchar(8) NOT NULL DEFAULT 'STORY';
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS character_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS costume text;
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS time_of_day varchar(24);
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS lyric text;
-- Prompt / plan approved by the creator (SCENES and STORYBOARD stages).
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS approved_at timestamptz;
-- The generated shot approved (SHOOT stage): the next scene unlocks.
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS shot_approved_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_scenes_kind_check') THEN
    ALTER TABLE studio_scenes ADD CONSTRAINT studio_scenes_kind_check CHECK (kind IN ('INTRO', 'STORY', 'OUTRO'));
  END IF;
END $$;

-- Assets: character videos, background effect audio, the rendered DAW mix.
ALTER TABLE studio_assets DROP CONSTRAINT IF EXISTS studio_assets_role_check;
ALTER TABLE studio_assets ADD CONSTRAINT studio_assets_role_check CHECK (role IN ('PHOTO', 'MUSIC', 'VIDEO', 'SFX', 'MIX'));
