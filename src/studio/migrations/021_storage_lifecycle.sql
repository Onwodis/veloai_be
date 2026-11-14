-- Paid storage lifecycle (be/src/storage/lifecycle.ts, hourly job):
--   reminded_at          a paid pack's "ends in 2 days" mail was sent
--   over_quota_since     first seen over quota (grace period starts)
--   over_quota_mailed_at the over-quota warning was sent for this episode
ALTER TABLE storage_purchases ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS over_quota_since timestamptz;
ALTER TABLE storage_accounts ADD COLUMN IF NOT EXISTS over_quota_mailed_at timestamptz;
