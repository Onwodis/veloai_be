-- 1. Page layouts each user arranges (section order, width, height, hidden),
--    saved so the page always opens the way they left it.
CREATE TABLE IF NOT EXISTS user_layouts (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_key    varchar(80) NOT NULL,
  layout      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_key)
);

-- 2. Industry focus of every project (filters on the projects pages).
--    Projects made before this land in OTHERS; ANONYMOUS is a chosen category.
ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS category varchar(24) NOT NULL DEFAULT 'OTHERS';
ALTER TABLE studio_projects DROP CONSTRAINT IF EXISTS studio_projects_category_check;
ALTER TABLE studio_projects ADD CONSTRAINT studio_projects_category_check CHECK (category IN (
  'ENTERTAINMENT', 'MUSIC', 'RELIGION', 'EDUCATION', 'MEDICINE', 'HEALTH', 'FITNESS', 'SPORTS', 'TECHNOLOGY', 'REAL_ESTATE',
  'BUSINESS', 'FINANCE', 'ECOMMERCE', 'ADVERTISEMENT', 'COMEDY', 'HACKATHON', 'FASHION', 'BEAUTY', 'FOOD', 'TRAVEL',
  'AUTOMOTIVE', 'GAMING', 'POLITICS', 'NEWS', 'NONPROFIT', 'FAMILY', 'KIDS', 'EVENTS', 'AGRICULTURE', 'ENERGY',
  'LEGAL', 'GOVERNMENT', 'ART', 'FILM', 'PODCAST', 'LIFESTYLE', 'ANONYMOUS', 'OTHERS'
));
CREATE INDEX IF NOT EXISTS studio_projects_category_idx ON studio_projects (workspace_id, category) WHERE deleted_at IS NULL;
