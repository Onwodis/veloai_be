-- CreateEnum
CREATE TYPE "TokenEntryType" AS ENUM ('PURCHASE', 'GRANT', 'ADJUSTMENT', 'USAGE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'ABANDONED');

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "token_wallets" (
    "workspace_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "lifetime_purchased" INTEGER NOT NULL DEFAULT 0,
    "lifetime_used" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "token_wallets_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "token_ledger" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" "TokenEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "task_type" VARCHAR(48),
    "reference" VARCHAR(128),
    "note" VARCHAR(255),
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_type" VARCHAR(48) NOT NULL,
    "estimated" INTEGER NOT NULL,
    "actual" INTEGER,
    "unmetered" BOOLEAN NOT NULL DEFAULT false,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "input" JSONB,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "token_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(24) NOT NULL DEFAULT 'paystack',
    "mode" "PaymentMode" NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "package_id" VARCHAR(48) NOT NULL,
    "tokens" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider_transaction_id" VARCHAR(64),
    "channel" VARCHAR(32),
    "failure_reason" VARCHAR(255),
    "credited_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "token_ledger_workspace_id_created_at_idx" ON "token_ledger"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "token_ledger_type_created_at_idx" ON "token_ledger"("type", "created_at");

-- CreateIndex
CREATE INDEX "token_reservations_workspace_id_status_idx" ON "token_reservations"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "token_reservations_status_expires_at_idx" ON "token_reservations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_reference_key" ON "payments"("reference");

-- CreateIndex
CREATE INDEX "payments_workspace_id_created_at_idx" ON "payments"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- AddForeignKey
ALTER TABLE "token_wallets" ADD CONSTRAINT "token_wallets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_reservations" ADD CONSTRAINT "token_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
