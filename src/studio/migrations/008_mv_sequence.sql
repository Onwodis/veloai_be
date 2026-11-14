-- "Generate all, one after another": the storyboard films its scenes in order,
-- one at a time, so corrections made along the way shape every later scene
-- (and no tokens are spent on scenes that would have to be redone).
--   { active, queue: [sceneId…], current: sceneId|null, by: { userId, role }, startedAt, error }
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS sequence jsonb;
