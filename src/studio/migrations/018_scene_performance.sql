-- Music video performance direction per scene (lip-synced shots):
--   emotion     how the artist delivers the line (joyful, longing, defiant…);
--               drives the facial expression in the base video and the
--               expressive lip-sync model's emotion
--   intensity   1 = subtle, 2 = natural (default), 3 = full out; drives how
--               much the face and mouth move (lip-sync temperature)
-- See be/src/studio/cinema.ts (PERFORMANCE_EMOTIONS) and lipsync.ts.
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS emotion text;
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS intensity smallint;
ALTER TABLE studio_scenes DROP CONSTRAINT IF EXISTS studio_scenes_intensity_check;
ALTER TABLE studio_scenes ADD CONSTRAINT studio_scenes_intensity_check CHECK (intensity IS NULL OR intensity BETWEEN 1 AND 3);
