-- 1. Soft delete for studio / music video projects.
--    Deleting moves a project to the bin: deleted_at + who deleted it. The owner
--    stays linked through created_by_id → users(id). Projects left in the bin
--    for 30 days are purged (rows + files) by the scheduled job; the super admin
--    can list, restore or purge them earlier.
ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE studio_projects ADD COLUMN IF NOT EXISTS deleted_by_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS studio_projects_deleted_idx ON studio_projects (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_projects_owner_idx ON studio_projects (created_by_id);

-- 2. Lyrics transcription runs in the background with live progress:
--    { status: RUNNING|DONE|FAILED, progress 0-1, lines: [{start,end,text}] so far, error, startedAt }
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS lyrics_job jsonb;
