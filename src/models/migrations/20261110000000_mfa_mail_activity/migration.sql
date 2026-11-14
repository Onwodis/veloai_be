-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';

-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_ENROLLED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_FAILED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_RECOVERY_USED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_RESET_REQUESTED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_RESET';
ALTER TYPE "SecurityEventType" ADD VALUE 'RECOVERY_CODES_REGENERATED';
ALTER TYPE "SecurityEventType" ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "SecurityEventType" ADD VALUE 'PASSWORD_RESET';

-- AlterEnum
ALTER TYPE "UsageMetric" ADD VALUE 'AI_TOKENS';
ALTER TYPE "UsageMetric" ADD VALUE 'TRANSCRIPTION_SECONDS';

-- CreateEnum
CREATE TYPE "AuthTokenPurpose" AS ENUM ('PASSWORD_RESET', 'MFA_RESET');

-- CreateEnum
CREATE TYPE "SmtpSource" AS ENUM ('ENV', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('CREATE', 'READ', 'UPDATE', 'DELETE');

-- AlterTable
ALTER TABLE "users"
    ADD COLUMN "totp_secret_enc" VARCHAR(255),
    ADD COLUMN "totp_enabled_at" TIMESTAMPTZ(3),
    ADD COLUMN "totp_last_step" BIGINT;

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smtp_credentials" (
    "id" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "source" "SmtpSource" NOT NULL DEFAULT 'DASHBOARD',
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "username" VARCHAR(255) NOT NULL,
    "password_enc" TEXT NOT NULL,
    "from_address" VARCHAR(254) NOT NULL,
    "from_name" VARCHAR(80),
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_verified_at" TIMESTAMPTZ(3),
    "last_verify_ok" BOOLEAN,
    "last_verify_error" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "smtp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_logs" (
    "id" BIGSERIAL NOT NULL,
    "credential_id" UUID,
    "to" VARCHAR(254) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "template" VARCHAR(64) NOT NULL,
    "status" "MailStatus" NOT NULL,
    "error" VARCHAR(500),
    "message_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID,
    "action" "ActivityAction" NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "path" VARCHAR(512) NOT NULL,
    "route" VARCHAR(255),
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_visits" (
    "id" BIGSERIAL NOT NULL,
    "visitor_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "first_visit" BOOLEAN NOT NULL DEFAULT false,
    "user_id" UUID,
    "path" VARCHAR(512) NOT NULL,
    "referrer" VARCHAR(512),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "page_views" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_code_hash_key" ON "recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "mail_logs_created_at_idx" ON "mail_logs"("created_at");

-- CreateIndex
CREATE INDEX "activity_logs_created_at_idx" ON "activity_logs"("created_at");

-- CreateIndex
CREATE INDEX "activity_logs_user_id_created_at_idx" ON "activity_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_logs_action_created_at_idx" ON "activity_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "site_visits_day_idx" ON "site_visits"("day");

-- CreateIndex
CREATE UNIQUE INDEX "site_visits_visitor_id_day_key" ON "site_visits"("visitor_id", "day");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_logs" ADD CONSTRAINT "mail_logs_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "smtp_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
