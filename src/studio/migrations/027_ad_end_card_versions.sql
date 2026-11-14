-- Commercials: the end card (logo + call to action over the last seconds of the ad)
-- and the platform versions made from one master (9:16, 1:1, 4:5, 16:9).
--   end_card  null = the default (on, 3 s, the brief's call to action, the company website,
--             the company logo, tinted with the first brand colour)
--   versions  [{ aspect, fit, status, masterKey, key, sizeBytes, error, at }]
ALTER TABLE ad_projects ADD COLUMN IF NOT EXISTS end_card jsonb;
ALTER TABLE ad_projects ADD COLUMN IF NOT EXISTS versions jsonb NOT NULL DEFAULT '[]'::jsonb;
