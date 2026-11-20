-- Email verification: free tokens (the welcome bonus and the trial) only after the address is
-- proven, so one person can't farm them with throwaway accounts. One row per user; the link's
-- token is stored only as a SHA-256 hash. bonus_granted_at makes the welcome grant once-only.
CREATE TABLE IF NOT EXISTS email_verifications (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) UNIQUE,
  expires_at timestamptz,
  sent_at timestamptz,
  verified_at timestamptz,
  bonus_granted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Everyone who signed up before this already had their welcome tokens: they count as verified.
INSERT INTO email_verifications (user_id, verified_at, bonus_granted_at)
SELECT id, now(), now() FROM users
ON CONFLICT (user_id) DO NOTHING;
