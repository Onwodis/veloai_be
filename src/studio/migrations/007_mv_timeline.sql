-- Music video timeline editor + AI polish.
--   transition_mode   MANUAL = the artist's transition; AI = chosen at stitch time from
--                     the music (energy change and tempo at the cut).
--   mv_projects.polish  last polish analysis: tempo, beat grid, snapped cut points,
--                       AI transitions, flops found per scene.
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS transition_mode varchar(8) NOT NULL DEFAULT 'AI';
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS polish jsonb;
