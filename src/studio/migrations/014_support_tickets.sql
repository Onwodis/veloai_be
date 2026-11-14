-- Support tickets: users open a ticket, staff reply and resolve it; the
-- conversation and the resolution are kept for the user's profile (super admin).
CREATE TABLE IF NOT EXISTS support_tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        serial UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  subject       varchar(160) NOT NULL,
  category      varchar(24) NOT NULL DEFAULT 'GENERAL' CHECK (category IN ('GENERAL', 'BILLING', 'GENERATION', 'ACCOUNT', 'BUG', 'FEATURE')),
  priority      varchar(8) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status        varchar(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED')),
  resolution    text,
  resolved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  -- Tokens credited back to the user as part of the resolution (refunds / goodwill).
  credited      integer NOT NULL DEFAULT 0,
  last_reply_by varchar(5) NOT NULL DEFAULT 'USER' CHECK (last_reply_by IN ('USER', 'STAFF')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  is_staff    boolean NOT NULL DEFAULT false,
  -- Staff-only notes are never shown to the user.
  internal    boolean NOT NULL DEFAULT false,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages (ticket_id, created_at);

-- Account suspension (super admin), separate from the login lockout.
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason varchar(300);
