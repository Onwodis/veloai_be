/**
 * Watermark removal, per project: the owner pays a share of what the video
 * cost in tokens (super admin setting: `removalPercent` of the tokens spent on
 * its takes and masters, at least `minimumTokens`). Paid from the token
 * balance (buy tokens first when short); recorded in token_ledger
 * (WATERMARK_REMOVAL) and watermark_removals. Renders after that are clean;
 * the existing master is re-mastered by the owner (its normal price, shown
 * before it starts).
 *
 * The super admin can also switch watermarking off platform-wide.
 */
import { z } from 'zod';
import { prisma } from '../config/database.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { applyEntry, getWallet, isUnmetered } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

export const watermarkSettingsSchema = z.strictObject({
  /** Off = no render is watermarked (platform-wide). */
  enabled: z.boolean(),
  removalPercent: z.number().int().min(0).max(1000),
  minimumTokens: z.number().int().min(0).max(1_000_000),
});
export type WatermarkSettings = z.infer<typeof watermarkSettingsSchema>;
export const DEFAULT_WATERMARK: WatermarkSettings = { enabled: true, removalPercent: 100, minimumTokens: 20 };

let cache: { value: WatermarkSettings; at: number } | null = null;

export async function getWatermarkSettings(): Promise<WatermarkSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'watermark'`.catch(() => []);
  const parsed = watermarkSettingsSchema.safeParse(row?.value);
  const value = parsed.success ? parsed.data : DEFAULT_WATERMARK;
  cache = { value, at: Date.now() };
  return value;
}

export async function saveWatermarkSettings(input: WatermarkSettings, actorId: string): Promise<WatermarkSettings> {
  const value = watermarkSettingsSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('watermark', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  cache = { value, at: Date.now() };
  logger.info({ actorId, ...value }, 'watermark settings changed');
  return value;
}

interface ProjectInfo {
  id: string;
  title: string;
  kind: string;
  tokensCharged: number;
  watermarkRemovedAt: Date | null;
  outputKey: string | null;
}

async function loadProject(auth: AuthContext, workspaceId: string, projectId: string, write: boolean): Promise<ProjectInfo> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, write ? ['OWNER'] : undefined);
  const [project] = await sql<ProjectInfo[]>`
    SELECT id, title, kind, tokens_charged, watermark_removed_at, output_key FROM studio_projects
    WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!project) throw AppError.notFound('Project');
  return project;
}

/** The video's token cost: its masters plus every generated take, quick clips included. */
async function videoTokens(project: ProjectInfo): Promise<number> {
  const [takes] = await sql<{ total: string | null }[]>`SELECT sum(cost)::text AS total FROM studio_takes WHERE project_id = ${project.id} AND status = 'READY'`;
  const [clips] = await sql<{ total: string | null }[]>`SELECT sum(tokens_charged)::text AS total FROM mv_clips WHERE project_id = ${project.id}`.catch(() => [{ total: null }]);
  return project.tokensCharged + Number(takes?.total ?? 0) + Number(clips?.total ?? 0);
}

export async function watermarkQuote(auth: AuthContext, workspaceId: string, projectId: string) {
  const project = await loadProject(auth, workspaceId, projectId, false);
  const settings = await getWatermarkSettings();
  const spent = await videoTokens(project);
  const fee = Math.max(settings.minimumTokens, Math.ceil((spent * settings.removalPercent) / 100));
  const wallet = await getWallet(workspaceId);
  return {
    watermarked: settings.enabled && !project.watermarkRemovedAt,
    removedAt: project.watermarkRemovedAt?.toISOString() ?? null,
    platformEnabled: settings.enabled,
    videoTokens: spent,
    fee,
    available: wallet.available,
    shortfall: Math.max(0, fee - wallet.available),
    hasMaster: Boolean(project.outputKey),
  };
}

/** Pays the fee from the balance and clears the watermark for this project's future renders. */
export async function removeWatermark(auth: AuthContext, workspaceId: string, projectId: string, expectedFee: number) {
  const project = await loadProject(auth, workspaceId, projectId, true);
  if (project.watermarkRemovedAt) throw AppError.conflict('The watermark is already removed for this project.');
  const quote = await watermarkQuote(auth, workspaceId, projectId);
  // The price shown is the price paid: if it moved since the dialog opened, ask again.
  if (quote.fee !== expectedFee) throw AppError.conflict(`The price changed to ${quote.fee} tokens. Check it and confirm again.`);
  const free = await isUnmetered(auth);
  if (!free && quote.fee > quote.available) {
    throw new AppError(402, 'INSUFFICIENT_TOKENS', `Removing the watermark costs ${quote.fee} tokens; the workspace has ${quote.available} available. Buy tokens to continue.`, {
      required: quote.fee,
      available: quote.available,
      shortfall: quote.fee - quote.available,
    });
  }
  const charged = free ? 0 : quote.fee;
  await prisma.$transaction(async (tx) => {
    if (charged > 0) {
      await applyEntry(tx, {
        workspaceId,
        type: 'USAGE',
        amount: -charged,
        taskType: 'WATERMARK_REMOVAL',
        reference: `watermark:${projectId}`,
        note: `Watermark removed · ${project.title.slice(0, 60)} (${quote.videoTokens} tokens of work × ${(await getWatermarkSettings()).removalPercent}%)`,
        actorId: auth.userId,
      });
    }
    // Marked in the same transaction as the charge: never paid without effect, never removed without payment.
    await tx.$executeRaw`UPDATE studio_projects SET watermark_removed_at = now(), watermark_removed_by_id = ${auth.userId}::uuid WHERE id = ${projectId}::uuid AND watermark_removed_at IS NULL`;
    await tx.$executeRaw`INSERT INTO watermark_removals (project_id, workspace_id, user_id, tokens, video_tokens) VALUES (${projectId}::uuid, ${workspaceId}::uuid, ${auth.userId}::uuid, ${charged}, ${quote.videoTokens})`;
  });
  logger.info({ userId: auth.userId, workspaceId, projectId, tokens: charged }, 'watermark removed');
  return { quote: await watermarkQuote(auth, workspaceId, projectId), wallet: await getWallet(workspaceId) };
}
