-- Global LLM token wallet + usage alarm (super admin).
--
-- The super admin buys LLM credit outside the platform (e.g. Anthropic
-- console) and records here how many tokens that bought. Every LLM call the
-- platform makes (hook picking, the AI director, likeness analysis, prompt
-- direction, launch handshakes) deducts its input + output tokens from this
-- one wallet.
--
--   funded_tokens   the baseline the alarm measures against: set to the new
--                   balance whenever the super admin sets or tops up the
--                   wallet with "recalibrate" on (the default)
--   alarm_percent   email when this % of funded_tokens has been used
--                   (default 50: half the wallet gone)
--   alarm_fired_at  set once the alarm has emailed; cleared by recalibration
--
-- Calls are never blocked by an empty wallet (a render mid-way must finish);
-- the balance can go negative and the launch guard flags it.

CREATE TABLE IF NOT EXISTS llm_wallet (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance_tokens   bigint NOT NULL DEFAULT 0,
  funded_tokens    bigint NOT NULL DEFAULT 0 CHECK (funded_tokens >= 0),
  alarm_percent    smallint NOT NULL DEFAULT 50 CHECK (alarm_percent BETWEEN 1 AND 100),
  alarm_emails     text[] NOT NULL DEFAULT '{}',
  alarm_fired_at   timestamptz,
  -- Optional, for the cost calculator: what the provider charges (USD per 1M tokens).
  input_usd_per_mtok  numeric(10, 4) NOT NULL DEFAULT 0 CHECK (input_usd_per_mtok >= 0),
  output_usd_per_mtok numeric(10, 4) NOT NULL DEFAULT 0 CHECK (output_usd_per_mtok >= 0),
  provider_note    varchar(200) NOT NULL DEFAULT '',
  configured_at    timestamptz,
  updated_by_id    uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO llm_wallet (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS llm_wallet_events (
  id             bigserial PRIMARY KEY,
  kind           varchar(16) NOT NULL CHECK (kind IN ('USAGE', 'SET', 'TOPUP', 'ADJUST', 'ALARM', 'SETTINGS')),
  delta_tokens   bigint NOT NULL DEFAULT 0,
  balance_after  bigint NOT NULL,
  source         varchar(40) NOT NULL DEFAULT '',
  provider       varchar(40) NOT NULL DEFAULT '',
  model          varchar(120) NOT NULL DEFAULT '',
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  actor_id       uuid,
  note           varchar(300) NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_wallet_events_created_idx ON llm_wallet_events (created_at DESC);
CREATE INDEX IF NOT EXISTS llm_wallet_events_kind_idx ON llm_wallet_events (kind, created_at DESC);

-- Atomically deducts one LLM call and reports whether this call crossed the
-- alarm line (true exactly once per calibration, so only one email goes out).
CREATE OR REPLACE FUNCTION llm_wallet_charge(p_source text, p_provider text, p_model text, p_input integer, p_output integer)
RETURNS TABLE (balance bigint, funded bigint, alarm_percent smallint, alarm_emails text[], just_fired boolean)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w llm_wallet%ROWTYPE;
  used bigint := GREATEST(p_input, 0)::bigint + GREATEST(p_output, 0)::bigint;
  fired boolean := false;
BEGIN
  SELECT * INTO w FROM llm_wallet WHERE id = 1 FOR UPDATE;
  w.balance_tokens := w.balance_tokens - used;
  IF w.alarm_fired_at IS NULL AND w.funded_tokens > 0
     AND (w.funded_tokens - w.balance_tokens) * 100 >= w.funded_tokens * w.alarm_percent THEN
    w.alarm_fired_at := now();
    fired := true;
  END IF;
  UPDATE llm_wallet SET balance_tokens = w.balance_tokens, alarm_fired_at = w.alarm_fired_at WHERE id = 1;
  INSERT INTO llm_wallet_events (kind, delta_tokens, balance_after, source, provider, model, input_tokens, output_tokens)
  VALUES ('USAGE', -used, w.balance_tokens, left(p_source, 40), left(p_provider, 40), left(p_model, 120), GREATEST(p_input, 0), GREATEST(p_output, 0));
  IF fired THEN
    INSERT INTO llm_wallet_events (kind, balance_after, note)
    VALUES ('ALARM', w.balance_tokens, format('%s%% of %s tokens used', w.alarm_percent, w.funded_tokens));
  END IF;
  RETURN QUERY SELECT w.balance_tokens, w.funded_tokens, w.alarm_percent, w.alarm_emails, fired;
END $$;

ALTER TABLE llm_wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_wallet_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_only ON llm_wallet;
CREATE POLICY admin_only ON llm_wallet USING (app_is_admin()) WITH CHECK (app_is_admin());
DROP POLICY IF EXISTS admin_only ON llm_wallet_events;
CREATE POLICY admin_only ON llm_wallet_events USING (app_is_admin()) WITH CHECK (app_is_admin());
GRANT SELECT, UPDATE ON llm_wallet TO app_rls;
GRANT SELECT, INSERT ON llm_wallet_events TO app_rls;
GRANT USAGE ON SEQUENCE llm_wallet_events_id_seq TO app_rls;
