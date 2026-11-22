-- Deleting a user (super admin) is two-step: the account is marked deleted at once (signed out,
-- sign-in blocked, scheduled work paused) and everything is purged for good by the
-- "purge-deleted-users" job once purge_after has passed (14 days later). Restorable until then.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS purge_after timestamptz;
-- What the account was before it was marked deleted (restored on undo).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pre_delete_suspension jsonb;
CREATE INDEX IF NOT EXISTS users_purge_due ON users (purge_after) WHERE purge_after IS NOT NULL;
