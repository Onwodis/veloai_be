-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('UPLOADING', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('PROBE', 'AUDIO', 'TRANSCRIBE', 'HOOKS', 'RENDER', 'FINALIZE');

-- CreateEnum
CREATE TYPE "ReelStatus" AS ENUM ('RENDERING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "media_projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'UPLOADING',
    "stage" "PipelineStage",
    "progress" INTEGER NOT NULL DEFAULT 0,
    "source_key" VARCHAR(512) NOT NULL,
    "source_name" VARCHAR(255) NOT NULL,
    "source_size" BIGINT NOT NULL,
    "source_type" VARCHAR(100) NOT NULL,
    "upload_id" VARCHAR(512),
    "duration_sec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "requested_reels" INTEGER NOT NULL,
    "options" JSONB NOT NULL,
    "reservation_id" UUID,
    "tokens_charged" INTEGER,
    "language" VARCHAR(16),
    "transcript" JSONB,
    "engine_log" JSONB,
    "error" VARCHAR(1000),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "media_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reels" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "hook" VARCHAR(500) NOT NULL,
    "hook_score" INTEGER NOT NULL,
    "start_sec" DOUBLE PRECISION NOT NULL,
    "end_sec" DOUBLE PRECISION NOT NULL,
    "caption" VARCHAR(1000) NOT NULL,
    "hashtags" TEXT[],
    "status" "ReelStatus" NOT NULL DEFAULT 'RENDERING',
    "video_key" VARCHAR(512),
    "thumb_key" VARCHAR(512),
    "size_bytes" BIGINT,
    "error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_projects_workspace_id_created_at_idx" ON "media_projects"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "media_projects_status_idx" ON "media_projects"("status");

-- CreateIndex
CREATE INDEX "reels_workspace_id_created_at_idx" ON "reels"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "reels_project_id_index_idx" ON "reels"("project_id", "index");

-- AddForeignKey
ALTER TABLE "media_projects" ADD CONSTRAINT "media_projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "media_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
