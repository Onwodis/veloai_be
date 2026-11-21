/**
 * YouTube films: the super admin's settings (platform_settings "youtube") and the price.
 *
 * Price: `nairaPer30s` (default ₦10,000) for every 30 seconds, worked out per second for any
 * length (45 s = ₦15,000). It is charged from the token wallet at `nairaPerToken` (default ₦5, the
 * Starter package's rate), so a 60 s film is ₦20,000 = 4,000 tokens. Both are adjustable.
 */
import { z } from 'zod';
import { json, sql } from '../studio/sql.js';
import { logger } from '../utils/logger.js';

const endpoint = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)+$/i, { error: 'Use a fal.ai endpoint id' });

export const youtubeSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** ₦ for 30 seconds of finished film. */
  nairaPer30s: z.number().int().min(100).max(10_000_000),
  /** What one token is worth in ₦ (to charge the price from the token wallet). */
  nairaPerToken: z.number().min(0.01).max(100_000),
  minSeconds: z.number().int().min(10).max(600),
  maxSeconds: z.number().int().min(15).max(1800),
  /** Films are made this many hours before they are due to publish. */
  leadHours: z.number().int().min(1).max(72),
  /** Most films a show may publish in a week. */
  maxPerWeek: z.number().int().min(1).max(21),
  /** The soundtrack generator (fal.ai) and its fixed inputs; prompt + duration are added. */
  soundtrack: z.strictObject({ endpoint, extra: z.record(z.string(), z.unknown()) }),
});
export type YoutubeSettings = z.infer<typeof youtubeSettingsSchema>;

export const DEFAULT_YOUTUBE: YoutubeSettings = {
  enabled: true,
  nairaPer30s: 10_000,
  nairaPerToken: 5,
  minSeconds: 30,
  maxSeconds: 600,
  leadHours: 12,
  maxPerWeek: 14,
  soundtrack: { endpoint: 'CassetteAI/music-generator', extra: {} },
};

export async function getYoutubeSettings(): Promise<YoutubeSettings> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'youtube'`.catch(() => []);
  const parsed = youtubeSettingsSchema.safeParse({ ...DEFAULT_YOUTUBE, ...(row?.value as object | undefined) });
  return parsed.success ? parsed.data : DEFAULT_YOUTUBE;
}

export async function saveYoutubeSettings(input: YoutubeSettings, actorId: string): Promise<YoutubeSettings> {
  const value = youtubeSettingsSchema.parse(input);
  if (value.minSeconds > value.maxSeconds) value.minSeconds = value.maxSeconds;
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('youtube', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  logger.info({ actorId, nairaPer30s: value.nairaPer30s, nairaPerToken: value.nairaPerToken }, 'youtube settings changed');
  return value;
}

export interface FilmPrice {
  seconds: number;
  naira: number;
  tokens: number;
}

/** The price of one film of `seconds`, per second from the 30-second rate. */
export function filmPrice(settings: YoutubeSettings, seconds: number): FilmPrice {
  const naira = Math.round((settings.nairaPer30s * seconds) / 30);
  return { seconds, naira, tokens: Math.max(1, Math.ceil(naira / settings.nairaPerToken)) };
}

/* ------------------------------------------------------------------ schedule */

/** Minutes the zone is ahead of UTC at `at` (e.g. Africa/Lagos = 60). */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']), Number(parts['minute']), Number(parts['second']));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The publish times from `from` over the next `days` days: every chosen weekday
 * (0 = Sunday) at HH:MM in the show's time zone, as UTC instants, soonest first.
 */
export function upcomingSlots(input: { days: number[]; time: string; timeZone: string }, from: Date, days = 14): Date[] {
  const [hour, minute] = input.time.split(':').map(Number) as [number, number];
  const slots: Date[] = [];
  const offsetNow = zoneOffsetMinutes(from, input.timeZone);
  const local = new Date(from.getTime() + offsetNow * 60_000);
  for (let day = 0; day <= days; day += 1) {
    const date = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour, minute));
    if (!input.days.includes(date.getUTCDay())) continue;
    // The wall-clock time in the zone -> UTC (offset taken at that moment, so DST is respected).
    const guess = new Date(date.getTime() - offsetNow * 60_000);
    const utc = new Date(date.getTime() - zoneOffsetMinutes(guess, input.timeZone) * 60_000);
    if (utc > from) slots.push(utc);
  }
  return slots;
}
