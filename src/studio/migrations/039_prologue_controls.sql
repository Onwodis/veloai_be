-- Cold open filming you can follow and steer: per-shot status, Pause / Stop
-- (the running job checks `control` every few seconds), and the token hold
-- kept on the row so a stop or a crash settles only what was really made.
ALTER TABLE mv_prologues ADD COLUMN IF NOT EXISTS control varchar(8) NOT NULL DEFAULT 'RUN';
ALTER TABLE mv_prologues ADD COLUMN IF NOT EXISTS reservation_id uuid;
ALTER TABLE mv_prologues ADD COLUMN IF NOT EXISTS spent integer NOT NULL DEFAULT 0;
-- { [shotId]: { clip: 'kept' | 'waiting' | 'frame' | 'animating' | 'done' | 'failed', voice: …, at } }
ALTER TABLE mv_prologues ADD COLUMN IF NOT EXISTS shot_status jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE mv_prologues ADD COLUMN IF NOT EXISTS started_at timestamptz;

ALTER TABLE mv_prologues DROP CONSTRAINT IF EXISTS mv_prologues_status_check;
ALTER TABLE mv_prologues ADD CONSTRAINT mv_prologues_status_check CHECK (status IN ('DRAFT', 'FILMING', 'PAUSED', 'STOPPED', 'READY', 'FAILED'));
ALTER TABLE mv_prologues DROP CONSTRAINT IF EXISTS mv_prologues_control_check;
ALTER TABLE mv_prologues ADD CONSTRAINT mv_prologues_control_check CHECK (control IN ('RUN', 'PAUSE', 'STOP'));
