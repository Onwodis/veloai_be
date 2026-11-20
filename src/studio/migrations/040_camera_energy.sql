-- How hard the camera works on a music video (studio/cinema.ts CAMERA_ENERGY):
-- natural = restrained real-life camera, bold = a motivated move on every shot and
-- striking angles on big moments, wild = FPV dives, fast orbits, whip pans, crash zooms.
-- Bold by default; projects that had "creative mode" on start at wild.
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS camera_energy varchar(8) NOT NULL DEFAULT 'bold';
UPDATE mv_projects SET camera_energy = 'wild' WHERE creative_mode = true AND camera_energy = 'bold';
