-- God mode: one press runs the whole production (lyrics, casting, storyboard, director's
-- review, titles, filming every scene, the master). Its live state, step by step:
-- { status, step, steps: { [step]: 'waiting' | 'running' | 'done' | 'skipped' | 'failed' },
--   error, note, estimate, by, startedAt, finishedAt }
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS god_mode jsonb;
