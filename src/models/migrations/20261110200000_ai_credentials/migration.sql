-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GROQ', 'OPENAI_COMPATIBLE');

-- CreateTable
CREATE TABLE "ai_credentials" (
    "id" UUID NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "source" "SmtpSource" NOT NULL DEFAULT 'DASHBOARD',
    "base_url" VARCHAR(255),
    "key_enc" TEXT NOT NULL,
    "key_last4" VARCHAR(4) NOT NULL,
    "models" TEXT[],
    "last_verified_at" TIMESTAMPTZ(3),
    "last_verify_ok" BOOLEAN,
    "last_verify_error" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id")
);
