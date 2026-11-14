-- Per-scene switch for burned-in lyric subtitles (additive).
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS subtitles boolean NOT NULL DEFAULT true;
