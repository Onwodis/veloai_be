-- YouTube shows publish at up to three times a day (publish_times); films a week = days × times.
-- Fixes databases that took the first draft of 046 (one publish_time and a stored per_week).
ALTER TABLE yt_shows ADD COLUMN IF NOT EXISTS publish_times jsonb NOT NULL DEFAULT '["17:00"]'::jsonb;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'yt_shows' AND column_name = 'publish_time') THEN
    UPDATE yt_shows SET publish_times = jsonb_build_array(publish_time);
    ALTER TABLE yt_shows DROP COLUMN publish_time;
  END IF;
END $$;
ALTER TABLE yt_shows DROP COLUMN IF EXISTS per_week;
