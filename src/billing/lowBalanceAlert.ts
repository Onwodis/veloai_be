/**
 * The in-app low-balance nudge (super admin settings, platform_settings "low-balance-alert"):
 * on or off, when it first appears after a page load (a random moment between two times),
 * how often it comes back while the balance stays low (random, between two times), how long
 * "Later" hides it, and the balance that counts as low.
 */
import { z } from 'zod';
import { json, sql } from '../studio/sql.js';
import { logger } from '../utils/logger.js';

export const lowBalanceAlertSchema = z
  .strictObject({
    enabled: z.boolean(),
    /** First appearance after the dashboard opens: a random moment in this range (seconds). */
    firstMinSeconds: z.number().int().min(0).max(3600),
    firstMaxSeconds: z.number().int().min(0).max(3600),
    /** While still low it comes back at a random moment in this range (minutes). */
    repeatMinMinutes: z.number().int().min(1).max(24 * 60),
    repeatMaxMinutes: z.number().int().min(1).max(24 * 60),
    /** "Later" hides it this long (hours). */
    snoozeHours: z.number().min(0.25).max(24 * 7),
    /** Low = available below this many tokens; 0 = automatic (2× the start balance or two typical shots). */
    thresholdTokens: z.number().int().min(0).max(10_000_000),
  })
  .refine((value) => value.firstMaxSeconds >= value.firstMinSeconds, { path: ['firstMaxSeconds'], error: 'The latest time must be after the earliest' })
  .refine((value) => value.repeatMaxMinutes >= value.repeatMinMinutes, { path: ['repeatMaxMinutes'], error: 'The longest gap must be at least the shortest' });
export type LowBalanceAlertSettings = z.infer<typeof lowBalanceAlertSchema>;

export const DEFAULT_LOW_BALANCE_ALERT: LowBalanceAlertSettings = {
  enabled: true,
  firstMinSeconds: 8,
  firstMaxSeconds: 45,
  repeatMinMinutes: 25,
  repeatMaxMinutes: 70,
  snoozeHours: 4,
  thresholdTokens: 0,
};

export async function getLowBalanceAlert(): Promise<LowBalanceAlertSettings> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'low-balance-alert'`.catch(() => []);
  const parsed = lowBalanceAlertSchema.safeParse({ ...DEFAULT_LOW_BALANCE_ALERT, ...(row?.value as object | undefined) });
  return parsed.success ? parsed.data : DEFAULT_LOW_BALANCE_ALERT;
}

export async function saveLowBalanceAlert(input: LowBalanceAlertSettings, actorId: string): Promise<LowBalanceAlertSettings> {
  const value = lowBalanceAlertSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('low-balance-alert', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  logger.info({ actorId, enabled: value.enabled }, 'low-balance alert settings changed');
  return value;
}
