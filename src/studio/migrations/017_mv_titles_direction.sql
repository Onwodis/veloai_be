-- Music video: opening titles (production credit, record label, artist, song
-- title, story text cards before the song, end credit) and the artist's
-- direction settings (performance vs story share, cutting pace, how literally
-- the pictures follow the lyrics). See be/src/musicvideo/titles.ts and
-- be/src/musicvideo/songmap.ts.
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS titles jsonb;
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS direction jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Director's-room proposal for the titles, applied with one click.
ALTER TABLE mv_messages ADD COLUMN IF NOT EXISTS titles jsonb;
-- How a scene relates to the song: PERFORMANCE (lip-synced), NARRATIVE
-- (acts out the lyric), BROLL (atmosphere / instrumental).
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS mode text;
