-- Sign-up email codes (services/emailVerification.service.ts): a 6-digit code is emailed before the
-- account is created; only its hash is kept, it expires in 10 minutes and allows 5 tries.
CREATE TABLE IF NOT EXISTS signup_codes (
  email varchar(320) PRIMARY KEY,
  code_hash varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- First and last name, asked for at sign-up (display_name stays "First Last").
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name varchar(60);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name varchar(60);
