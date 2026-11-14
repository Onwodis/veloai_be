-- Music video director: the artist or band name is required before stage 1 can be approved.
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS artist_name varchar(120) NOT NULL DEFAULT '';
