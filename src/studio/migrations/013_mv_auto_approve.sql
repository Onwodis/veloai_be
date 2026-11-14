-- Music video: auto-approve every scene the director writes or plans (additive).
-- Approval no longer gates the scene stages; only approved scenes are generated and stitched.
ALTER TABLE mv_projects ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT false;
