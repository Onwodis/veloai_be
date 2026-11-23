-- Sign-up already proves the address with an emailed code, so every account counts as confirmed:
-- older accounts made before codes are marked verified (no banner), with no welcome tokens.
INSERT INTO email_verifications (user_id, verified_at, bonus_granted_at)
SELECT id, now(), now() FROM users
ON CONFLICT (user_id) DO UPDATE SET verified_at = coalesce(email_verifications.verified_at, now()),
  bonus_granted_at = coalesce(email_verifications.bonus_granted_at, now());

-- No free tokens: welcome tokens off (owner decision, 2026-11-23).
UPDATE platform_settings SET value = jsonb_set(value, '{signupBonus}', '0'::jsonb), updated_at = now()
WHERE key = 'tokens';
