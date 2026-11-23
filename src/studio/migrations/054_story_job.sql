-- Writing the scenes runs in the background with progress (and waits for the lyrics when the song
-- was never transcribed): its state lives here, like lyrics_job.
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS story_job jsonb;
