-- "Stop & play what's done": when the creator stops a running assembly with
-- keep = true, the worker joins the shots it already prepared (fast encode,
-- each shot on its own slice of the song) and publishes that as a preview
-- instead of throwing the work away. See be/src/studio/assemble.ts.
ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS cancel_keep boolean NOT NULL DEFAULT false;
