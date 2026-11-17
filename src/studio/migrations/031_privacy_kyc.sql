-- Privacy (NDPR) and identity verification (KYC).
--
-- 1. consent_records: append-only. Every grant or withdrawal of consent, with the
--    purpose, the lawful basis, the policy version shown, and where it came from.
--    The current state of a purpose is its latest row.
CREATE TABLE IF NOT EXISTS consent_records (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose         varchar(24) NOT NULL CHECK (purpose IN ('TERMS', 'PRIVACY', 'AGE', 'MARKETING', 'PRODUCT_RESEARCH', 'LIKENESS')),
  lawful_basis    varchar(24) NOT NULL CHECK (lawful_basis IN ('CONTRACT', 'CONSENT', 'LEGAL_OBLIGATION', 'LEGITIMATE_INTEREST')),
  granted         boolean NOT NULL,
  policy_version  varchar(20) NOT NULL,
  source          varchar(16) NOT NULL DEFAULT 'SETTINGS' CHECK (source IN ('SIGNUP', 'SETTINGS', 'ADMIN')),
  ip_address      varchar(64),
  user_agent      varchar(512),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consent_records_user_idx ON consent_records (user_id, purpose, created_at DESC);

-- 2. kyc_profiles: one per user. Levels: 0 email only · 1 name, country, phone ·
--    2 government ID + selfie (reviewed) · 3 business (CAC) verified.
--    ID numbers are never stored: only a salted hash and the last 4 characters.
CREATE TABLE IF NOT EXISTS kyc_profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level               smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 3),
  status              varchar(10) NOT NULL DEFAULT 'NONE' CHECK (status IN ('NONE', 'PENDING', 'VERIFIED', 'REJECTED')),
  requested_level     smallint CHECK (requested_level BETWEEN 1 AND 3),
  legal_name          varchar(160),
  country             char(2),
  phone               varchar(32),
  id_type             varchar(16) CHECK (id_type IN ('NIN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'NATIONAL_ID')),
  id_number_hash      varchar(128),
  id_number_last4     varchar(4),
  business_name       varchar(200),
  business_reg_no     varchar(60),
  documents           jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at        timestamptz,
  reviewed_by_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  rejection_reason    varchar(400),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_profiles_queue_idx ON kyc_profiles (submitted_at) WHERE status = 'PENDING';

-- 3. data_requests: data-subject requests (NDPR), each with its 30-day deadline.
CREATE TABLE IF NOT EXISTS data_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            varchar(12) NOT NULL CHECK (type IN ('ACCESS', 'EXPORT', 'CORRECTION', 'DELETION', 'OBJECTION', 'RESTRICTION')),
  status          varchar(12) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'REJECTED')),
  details         text NOT NULL DEFAULT '',
  response        text,
  due_at          timestamptz NOT NULL,
  handled_by_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS data_requests_open_idx ON data_requests (due_at) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS data_requests_user_idx ON data_requests (user_id, created_at DESC);
