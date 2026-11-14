-- Paid fal.ai results are kept on the take as soon as they arrive:
--   { KEYFRAME: <fal result>, ANIMATING: <fal result>, LIPSYNC: <fal result> }
-- If anything after that fails (e.g. downloading the file over a slow network),
-- Resume continues from these results instead of paying fal.ai again.
ALTER TABLE studio_takes ADD COLUMN IF NOT EXISTS outputs jsonb NOT NULL DEFAULT '{}'::jsonb;
