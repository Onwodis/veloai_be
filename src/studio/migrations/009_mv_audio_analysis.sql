-- Server-side music analysis cache for the storyboard editor:
--   { [assetId]: AudioAnalysis }  (waveform, tempo + beats, key, loudness, sections)
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS audio_analysis jsonb NOT NULL DEFAULT '{}'::jsonb;
