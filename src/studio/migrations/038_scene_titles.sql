-- Scene names: a short title and a subtitle the artist can rename at any
-- time (VeloBot suggests them when it plans). Labels only, for finding and
-- arranging scenes: every scene (intro and outro included) can be moved,
-- copied, duplicated and deleted like any other.
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS title varchar(80) NOT NULL DEFAULT '';
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS subtitle varchar(120) NOT NULL DEFAULT '';
