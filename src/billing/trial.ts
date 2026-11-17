/**
 * Trial tokens: every user can claim one trial, once: `tokens` tokens in
 * their own workspace for `days` days (super admin settings; default 20
 * tokens, 7 days, on). Trial work is watermarked like everything else.
 *
 * When the trial ends, whatever is left of the grant is taken back. Trial
 * tokens are spent first: remaining = grant − usage since the grant, capped by
 * what is free in the wallet, so tokens the user bought are never removed.
 * Both movements are token_ledger rows (task types TRIAL and TRIAL_EXPIRY),
 * so they show on the billing page and in the super admin's views.
 */
import { z } from 'zod';
import { prisma } from '../config/database.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { applyEntry, getWallet } from '../services/token.service.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

export const trialSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  tokens: z.number().int().min(1).max(100_000),
  days: z.number().int().min(1).max(365),
});
export type TrialSettings = z.infer<typeof trialSettingsSchema>;
export const DEFAULT_TRIAL: TrialSettings = { enabled: true, tokens: 20, days: 7 };

export async function getTrialSettings(): Promise<TrialSettings> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'trial'`.catch(() => []);
  const parsed = trialSettingsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_TRIAL;
}

export async function saveTrialSettings(input: TrialSettings, actorId: string): Promise<TrialSettings> {
  const value = trialSettingsSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('trial', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  logger.info({ actorId, ...value }, 'trial settings changed');
  return value;
}

interface GrantRow {
  userId: string;
  workspaceId: string;
  tokens: number;
  grantedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  reclaimed: number;
}

/** Trial tokens not yet spent: the grant minus everything used in the workspace since. */
async function remainingOf(grant: GrantRow): Promise<number> {
  const [row] = await sql<{ used: string | null }[]>`
    SELECT sum(-amount)::text AS used FROM token_ledger
    WHERE workspace_id = ${grant.workspaceId} AND type = 'USAGE' AND created_at >= ${grant.grantedAt}`;
  return Math.max(0, grant.tokens - Number(row?.used ?? 0));
}

export async function trialStatus(userId: string) {
  const [settings, [grant]] = await Promise.all([getTrialSettings(), sql<GrantRow[]>`SELECT * FROM trial_grants WHERE user_id = ${userId}`]);
  const active = grant && !grant.endedAt && grant.expiresAt.getTime() > Date.now();
  return {
    settings,
    eligible: settings.enabled && !grant,
    grant: grant
      ? {
          workspaceId: grant.workspaceId,
          tokens: grant.tokens,
          grantedAt: grant.grantedAt.toISOString(),
          expiresAt: grant.expiresAt.toISOString(),
          endedAt: grant.endedAt?.toISOString() ?? null,
          active: Boolean(active),
          remaining: active ? await remainingOf(grant) : 0,
          reclaimed: grant.reclaimed,
        }
      : null,
  };
}

/** Claims the trial into a workspace the user owns. Once per user, ever. */
export async function claimTrial(auth: AuthContext, workspaceId: string) {
  const settings = await getTrialSettings();
  if (!settings.enabled) throw AppError.forbidden('Trials are switched off right now.');
  const [member] = await sql<{ role: string }[]>`SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${auth.userId}`;
  if (member?.role !== 'OWNER') throw AppError.forbidden('Claim the trial in a workspace you own.');
  const expiresAt = new Date(Date.now() + settings.days * 86_400_000);
  // The row is the once-per-user lock: a second claim conflicts before any token moves.
  const [inserted] = await sql<GrantRow[]>`
    INSERT INTO trial_grants (user_id, workspace_id, tokens, expires_at) VALUES (${auth.userId}, ${workspaceId}, ${settings.tokens}, ${expiresAt})
    ON CONFLICT (user_id) DO NOTHING RETURNING *`;
  if (!inserted) throw AppError.conflict('You have already used your trial.');
  try {
    await prisma.$transaction((tx) =>
      applyEntry(tx, {
        workspaceId,
        type: 'GRANT',
        amount: settings.tokens,
        taskType: 'TRIAL',
        reference: `trial:${auth.userId}`,
        note: `Free trial: ${settings.tokens} tokens for ${settings.days} day${settings.days === 1 ? '' : 's'} (ends ${expiresAt.toISOString().slice(0, 10)})`,
        actorId: auth.userId,
      }),
    );
  } catch (error) {
    await sql`DELETE FROM trial_grants WHERE user_id = ${auth.userId}`.catch(() => undefined);
    throw error;
  }
  logger.info({ userId: auth.userId, workspaceId, tokens: settings.tokens, days: settings.days }, 'trial claimed');
  return { status: await trialStatus(auth.userId), wallet: await getWallet(workspaceId) };
}

/** Scheduled: ends trials whose time is up and takes back the unspent part of each grant. */
export async function expireTrials(): Promise<string> {
  const due = await sql<GrantRow[]>`SELECT * FROM trial_grants WHERE ended_at IS NULL AND expires_at <= now() LIMIT 200`;
  let reclaimedTotal = 0;
  for (const grant of due) {
    try {
      const remaining = await remainingOf(grant);
      const wallet = await getWallet(grant.workspaceId);
      const reclaim = Math.max(0, Math.min(remaining, wallet.balance - wallet.held));
      if (reclaim > 0) {
        await prisma.$transaction((tx) =>
          applyEntry(tx, {
            workspaceId: grant.workspaceId,
            type: 'ADJUSTMENT',
            amount: -reclaim,
            taskType: 'TRIAL_EXPIRY',
            reference: `trial:${grant.userId}`,
            note: `Free trial ended: ${reclaim} unused trial token${reclaim === 1 ? '' : 's'} returned`,
          }),
        );
      }
      await sql`UPDATE trial_grants SET ended_at = now(), reclaimed = ${reclaim} WHERE user_id = ${grant.userId}`;
      reclaimedTotal += reclaim;
    } catch (error) {
      logger.warn({ err: error, userId: grant.userId }, 'trial expiry failed; retried next run');
    }
  }
  return `${due.length} trial(s) ended, ${reclaimedTotal} token(s) returned`;
}
