-- "Continue with my balance": after the low-balance warning, the user may go ahead for a short
-- window; tasks then hold whatever is available instead of being refused (owner decision 2026-11-23).
ALTER TABLE token_wallets ADD COLUMN IF NOT EXISTS proceed_until timestamptz;
