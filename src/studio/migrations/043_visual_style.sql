-- The look of a music video, chosen when it starts (studio/cinema.ts VISUAL_STYLES): real people
-- (live action) or an animated style (3D animated, anime, comic book, clay animation).
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS visual_style varchar(16) NOT NULL DEFAULT 'human';
