/**
 * Global LLM token wallet (migration 003).
 *
 * The super admin buys LLM credit outside the platform and records how many
 * tokens it bought. `recordLlmUsage()` is called after every LLM response
 * and deducts input + output tokens atomically in the database
 * (llm_wallet_charge). When usage crosses the alarm line (default 50% of
 * what was funded) the database reports it exactly once and an email goes to
 * the alarm recipients (or every super admin when none are set).
 *
 * Setting or topping up the wallet recalibrates the alarm by default: the new
 * balance becomes the baseline and the alarm re-arms.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { env } from '../config/env.js';
import { sendMail } from '../services/mail/mail.service.js';
import { llmAlarmMail } from '../services/mail/templates.js';
import { withUser } from '../storage/rls.js';
import { sql, type Tx } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

export type UsageSource = 'hooks' | 'director' | 'likeness' | 'direction' | 'handshake' | 'music-video' | 'commercial' | 'other';

export interface LlmUsage {
  source: UsageSource;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const GUARD_URL = (): string => `${env.WEB_APP_URL}/dashboard/admin/launch`;
const n = (value: unknown): number => Number(value ?? 0);

async function alarmRecipients(configured: string[]): Promise<string[]> {
  if (configured.length) return configured;
  const rows = await sql<{ email: string }[]>`SELECT email FROM users WHERE role = 'SUPER_ADMIN'`;
  return rows.map((row) => row.email);
}

async function sendAlarm(state: { balance: number; funded: number; alarmPercent: number; emails: string[] }, test = false): Promise<string[]> {
  const to = await alarmRecipients(state.emails);
  const usedPercent = state.funded > 0 ? Math.round(((state.funded - state.balance) / state.funded) * 100) : 0;
  const mail = llmAlarmMail({ usedPercent, alarmPercent: state.alarmPercent, balance: state.balance, funded: state.funded, url: GUARD_URL(), test });
  const sent: string[] = [];
  for (const address of to) {
    try {
      await sendMail(address, mail);
      sent.push(address);
    } catch (error) {
      logger.error({ err: error, to: address }, 'LLM wallet alarm email failed');
    }
  }
  return sent;
}

/**
 * Deducts one LLM call from the wallet. Never throws: usage accounting must
 * not fail the job that made the call.
 */
export async function recordLlmUsage(usage: LlmUsage): Promise<void> {
  if (usage.inputTokens + usage.outputTokens <= 0) return;
  try {
    const [row] = await sql<{ balance: string; funded: string; alarmPercent: number; alarmEmails: string[]; justFired: boolean }[]>`
      SELECT * FROM llm_wallet_charge(${usage.source}, ${usage.provider}, ${usage.model}, ${Math.round(usage.inputTokens)}, ${Math.round(usage.outputTokens)})`;
    if (row?.justFired) {
      const state = { balance: n(row.balance), funded: n(row.funded), alarmPercent: row.alarmPercent, emails: row.alarmEmails };
      logger.warn(state, 'LLM token wallet alarm fired');
      void sendAlarm(state);
    }
  } catch (error) {
    logger.warn({ err: error, source: usage.source }, 'LLM usage not recorded (is migration 003 applied?)');
  }
}

/* ------------------------------------------------------------------ console */

export interface WalletView {
  balance: number;
  funded: number;
  used: number;
  usedPercent: number;
  alarmPercent: number;
  alarmEmails: string[];
  alarmFiredAt: string | null;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  providerNote: string;
  configuredAt: string | null;
  updatedAt: string;
}

interface WalletRow {
  balanceTokens: string;
  fundedTokens: string;
  alarmPercent: number;
  alarmEmails: string[];
  alarmFiredAt: Date | null;
  inputUsdPerMtok: string;
  outputUsdPerMtok: string;
  providerNote: string;
  configuredAt: Date | null;
  updatedAt: Date;
}

function view(row: WalletRow): WalletView {
  const balance = n(row.balanceTokens);
  const funded = n(row.fundedTokens);
  const used = Math.max(0, funded - balance);
  return {
    balance,
    funded,
    used,
    usedPercent: funded > 0 ? Math.round((used / funded) * 1000) / 10 : 0,
    alarmPercent: row.alarmPercent,
    alarmEmails: row.alarmEmails,
    alarmFiredAt: row.alarmFiredAt?.toISOString() ?? null,
    inputUsdPerMtok: n(row.inputUsdPerMtok),
    outputUsdPerMtok: n(row.outputUsdPerMtok),
    providerNote: row.providerNote,
    configuredAt: row.configuredAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const lockWallet = async (tx: Tx): Promise<WalletRow> => {
  const [row] = await tx<WalletRow[]>`SELECT * FROM llm_wallet WHERE id = 1 FOR UPDATE`;
  if (!row) throw new AppError(503, 'INTERNAL_ERROR', 'The LLM wallet table is missing: run pnpm studio:migrate.');
  return row;
};

/** Re-arms the alarm when usage is back under the line (else keeps it fired). */
const ALARM_REARM = `alarm_fired_at = CASE WHEN funded_tokens = 0 OR (funded_tokens - balance_tokens) * 100 < funded_tokens * alarm_percent THEN NULL ELSE alarm_fired_at END`;

export async function getWallet(auth: AuthContext): Promise<WalletView> {
  return withUser(auth, async (tx) => {
    const [row] = await tx<WalletRow[]>`SELECT * FROM llm_wallet WHERE id = 1`;
    if (!row) throw new AppError(503, 'INTERNAL_ERROR', 'The LLM wallet table is missing: run pnpm studio:migrate.');
    return view(row);
  });
}

export interface FundInput {
  /** set = the wallet now holds exactly `tokens`; topup = add; adjust = add/subtract a correction. */
  mode: 'set' | 'topup' | 'adjust';
  tokens: number;
  /** Default true: the new balance becomes the alarm baseline and the alarm re-arms. */
  recalibrate: boolean;
  note: string;
}

export async function fundWallet(auth: AuthContext, input: FundInput): Promise<WalletView> {
  if (input.mode === 'set' && input.tokens < 0) throw AppError.badRequest('The wallet balance cannot be set below zero.');
  if (input.mode === 'topup' && input.tokens <= 0) throw AppError.badRequest('A top-up must add tokens.');
  return withUser(auth, async (tx) => {
    const current = await lockWallet(tx);
    const before = n(current.balanceTokens);
    const after = input.mode === 'set' ? input.tokens : before + input.tokens;
    const funded = input.recalibrate ? Math.max(0, after) : n(current.fundedTokens);
    await tx.unsafe(
      `UPDATE llm_wallet SET balance_tokens = $1, funded_tokens = $2, configured_at = COALESCE(configured_at, now()), updated_by_id = $3, updated_at = now() WHERE id = 1`,
      [after, funded, auth.userId],
    );
    await tx.unsafe(`UPDATE llm_wallet SET ${input.recalibrate ? 'alarm_fired_at = NULL' : ALARM_REARM} WHERE id = 1`);
    await tx`
      INSERT INTO llm_wallet_events (kind, delta_tokens, balance_after, actor_id, note)
      VALUES (${input.mode.toUpperCase()}, ${after - before}, ${after}, ${auth.userId}, ${(input.note || (input.recalibrate ? 'Alarm recalibrated' : '')).slice(0, 300)})`;
    const [row] = await tx<WalletRow[]>`SELECT * FROM llm_wallet WHERE id = 1`;
    logger.info({ actorId: auth.userId, mode: input.mode, tokens: input.tokens, recalibrate: input.recalibrate }, 'LLM wallet funded');
    return view(row!);
  });
}

export interface AlarmInput {
  alarmPercent?: number | undefined;
  alarmEmails?: string[] | undefined;
  inputUsdPerMtok?: number | undefined;
  outputUsdPerMtok?: number | undefined;
  providerNote?: string | undefined;
}

export async function updateAlarm(auth: AuthContext, input: AlarmInput): Promise<WalletView> {
  return withUser(auth, async (tx) => {
    const current = await lockWallet(tx);
    const emails = input.alarmEmails ? [...new Set(input.alarmEmails.map((email) => email.trim().toLowerCase()).filter(Boolean))] : current.alarmEmails;
    await tx`
      UPDATE llm_wallet SET
        alarm_percent = ${input.alarmPercent ?? current.alarmPercent},
        alarm_emails = ${emails},
        input_usd_per_mtok = ${input.inputUsdPerMtok ?? n(current.inputUsdPerMtok)},
        output_usd_per_mtok = ${input.outputUsdPerMtok ?? n(current.outputUsdPerMtok)},
        provider_note = ${input.providerNote ?? current.providerNote},
        updated_by_id = ${auth.userId}, updated_at = now()
      WHERE id = 1`;
    // A higher threshold than current usage re-arms the alarm.
    await tx.unsafe(`UPDATE llm_wallet SET ${ALARM_REARM} WHERE id = 1`);
    await tx`
      INSERT INTO llm_wallet_events (kind, balance_after, actor_id, note)
      VALUES ('SETTINGS', ${n(current.balanceTokens)}, ${auth.userId}, ${`Alarm at ${input.alarmPercent ?? current.alarmPercent}%`})`;
    const [row] = await tx<WalletRow[]>`SELECT * FROM llm_wallet WHERE id = 1`;
    return view(row!);
  });
}

export async function testAlarm(auth: AuthContext): Promise<{ sentTo: string[] }> {
  const wallet = await getWallet(auth);
  const sentTo = await sendAlarm({ balance: wallet.balance, funded: wallet.funded, alarmPercent: wallet.alarmPercent, emails: wallet.alarmEmails }, true);
  if (!sentTo.length) throw new AppError(502, 'MAIL_UNAVAILABLE', 'The alarm email could not be sent. Check the Mail page (an active, verified SMTP account is needed).');
  return { sentTo };
}

/* ------------------------------------------------------------------ usage report */

export interface UsageReport {
  days: { day: string; input: number; output: number }[];
  byModel: { model: string; provider: string; calls: number; tokens: number }[];
  bySource: { source: string; calls: number; tokens: number; avgPerCall: number }[];
  /** Average tokens per day over the last 7 days. */
  burnPerDay: number;
  /** Days until the balance reaches zero at that rate (null = no usage / not funded). */
  daysLeft: number | null;
  recent: { id: string; kind: string; delta: number; balanceAfter: number; source: string; model: string; note: string; createdAt: string }[];
}

export async function usageReport(auth: AuthContext, range: number): Promise<UsageReport> {
  return withUser(auth, async (tx) => {
    const since = new Date(Date.now() - range * 86_400_000);
    const [days, byModel, bySource, burn, recent, wallet] = await Promise.all([
      tx<{ day: string; input: string; output: string }[]>`
        SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(SUM(e.input_tokens), 0) AS input, COALESCE(SUM(e.output_tokens), 0) AS output
        FROM generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', now()), interval '1 day') AS d
        LEFT JOIN llm_wallet_events e ON e.kind = 'USAGE' AND date_trunc('day', e.created_at) = d
        GROUP BY d ORDER BY d`,
      tx<{ model: string; provider: string; calls: string; tokens: string }[]>`
        SELECT model, provider, COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens
        FROM llm_wallet_events WHERE kind = 'USAGE' AND created_at >= ${since}
        GROUP BY model, provider ORDER BY tokens DESC LIMIT 12`,
      tx<{ source: string; calls: string; tokens: string }[]>`
        SELECT source, COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens
        FROM llm_wallet_events WHERE kind = 'USAGE' AND created_at >= ${since}
        GROUP BY source ORDER BY tokens DESC`,
      tx<{ tokens: string }[]>`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM llm_wallet_events WHERE kind = 'USAGE' AND created_at >= now() - interval '7 days'`,
      tx<{ id: string; kind: string; deltaTokens: string; balanceAfter: string; source: string; model: string; note: string; createdAt: Date }[]>`
        SELECT id, kind, delta_tokens, balance_after, source, model, note, created_at FROM llm_wallet_events ORDER BY id DESC LIMIT 40`,
      tx<{ balanceTokens: string; fundedTokens: string }[]>`SELECT balance_tokens, funded_tokens FROM llm_wallet WHERE id = 1`,
    ]);
    const burnPerDay = Math.round(n(burn[0]?.tokens) / 7);
    const balance = n(wallet[0]?.balanceTokens);
    return {
      days: days.map((row) => ({ day: row.day, input: n(row.input), output: n(row.output) })),
      byModel: byModel.map((row) => ({ model: row.model || 'unknown', provider: row.provider, calls: n(row.calls), tokens: n(row.tokens) })),
      bySource: bySource.map((row) => ({ source: row.source, calls: n(row.calls), tokens: n(row.tokens), avgPerCall: n(row.calls) ? Math.round(n(row.tokens) / n(row.calls)) : 0 })),
      burnPerDay,
      daysLeft: burnPerDay > 0 && n(wallet[0]?.fundedTokens) > 0 ? Math.max(0, Math.floor(balance / burnPerDay)) : null,
      recent: recent.map((row) => ({
        id: String(row.id),
        kind: row.kind,
        delta: n(row.deltaTokens),
        balanceAfter: n(row.balanceAfter),
        source: row.source,
        model: row.model,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });
}
