-- CapCut-style per-clip edits (trim-in, speed, reverse, look, adjust, zoom,
-- text overlays), rendered at assembly. See be/src/studio/clipEdits.ts.
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS edits jsonb NOT NULL DEFAULT '{}'::jsonb;
