-- Artist upload link for a music video (musicvideo/intake.ts): the creator shares a public link,
-- the artist uploads the song, photos, notes and details once; the creator is emailed and the
-- link closes until the creator reopens it (which wipes what was sent).
CREATE TABLE IF NOT EXISTS mv_intake_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE REFERENCES studio_projects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  created_by uuid NOT NULL,
  token varchar(64) NOT NULL UNIQUE,
  status varchar(12) NOT NULL DEFAULT 'OPEN',
  -- What the creator asks for, and a note to the artist.
  asks jsonb NOT NULL DEFAULT '{"song": true, "photos": true, "details": true}'::jsonb,
  message text NOT NULL DEFAULT '',
  -- What the artist sent (cleared on reopen).
  submission jsonb,
  audio jsonb,
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  upload_grants integer NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  reopened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
