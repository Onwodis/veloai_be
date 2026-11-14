-- How a character performs, studied from the videos the artist uploads
-- (photos = who they are; videos = how they sing and express themselves):
--   performance       written performance sheet: mouth opening and lip shapes
--                     on stressed words, brows / forehead / eye creases, eyes
--                     closing on long notes, head and shoulder movement,
--                     signature expressions, intensity range
--   expression_keys   stills from those videos showing peak expressions (kept
--                     apart from reference_keys, which stay identity photos)
-- See be/src/musicvideo/director.ts (castCharacter) and cast.ts.
ALTER TABLE mv_characters ADD COLUMN IF NOT EXISTS performance text;
ALTER TABLE mv_characters ADD COLUMN IF NOT EXISTS expression_keys text[] NOT NULL DEFAULT '{}';
