-- Music video options + "this character is me" (additive only).
--   creative_mode  sharp, bold AI camera work (whip pans, crash zooms, FPV / aerial bursts, speed ramps on the beat)
--   subtitles      burn the (edited) lyrics into the finished video
--   foley          AI action sounds (footsteps, claps, cloth, heartbeat…) from each shot, mixed under the song
--   mv_characters.likeness_user_id  the character is this user: their saved likeness (photos + profile) drives the shots

ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS creative_mode boolean NOT NULL DEFAULT false;
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS subtitles boolean NOT NULL DEFAULT false;
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS foley boolean NOT NULL DEFAULT false;
ALTER TABLE mv_characters ADD COLUMN IF NOT EXISTS likeness_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
