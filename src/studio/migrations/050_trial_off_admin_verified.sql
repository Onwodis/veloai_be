-- The free trial is off until the super admin turns it on (an explicit owner decision, 2026-11-23).
UPDATE platform_settings SET value = jsonb_set(value, '{enabled}', 'false'::jsonb), updated_at = now()
WHERE key = 'trial' AND (value ->> 'enabled')::boolean IS TRUE;

-- Super admins don't confirm their email through the banner: they count as verified.
INSERT INTO email_verifications (user_id, verified_at, bonus_granted_at)
SELECT id, now(), now() FROM users WHERE role = 'SUPER_ADMIN'
ON CONFLICT (user_id) DO UPDATE SET verified_at = coalesce(email_verifications.verified_at, now());
