/**
 * Ring buffer of the most recent warn/error/fatal log lines, so the super
 * admin console can show what the API has been complaining about without
 * shell access to the server. In-memory and per-process: it resets on
 * restart, and each worker process keeps its own.
 */

export interface BufferedLog {
  id: number;
  time: string;
  level: 'warn' | 'error' | 'fatal';
  msg: string;
  /** Short context (error message, ids), never the full object. */
  context: string | null;
}

const CAPACITY = 300;
const entries: BufferedLog[] = [];
let sequence = 0;

const LEVEL: Record<number, BufferedLog['level']> = { 40: 'warn', 50: 'error', 60: 'fatal' };

function summarise(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const err = record['err'];
  if (err instanceof Error) parts.push(`${err.name}: ${err.message}`);
  else if (err && typeof err === 'object' && 'message' in err) parts.push(String((err as { message: unknown }).message));
  for (const [key, item] of Object.entries(record)) {
    if (key === 'err' || item === undefined || item === null) continue;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') parts.push(`${key}=${String(item)}`);
  }
  return parts.length ? parts.join(' · ').slice(0, 600) : null;
}

/** Called from the pino logMethod hook with the raw call arguments. */
export function captureLog(level: number, args: unknown[]): void {
  const name = LEVEL[level];
  if (!name) return;
  const [first, second] = args;
  const msg = typeof first === 'string' ? first : typeof second === 'string' ? second : first instanceof Error ? first.message : 'log';
  const context = typeof first === 'string' ? null : first instanceof Error ? `${first.name}: ${first.message}` : summarise(first);
  sequence += 1;
  entries.push({ id: sequence, time: new Date().toISOString(), level: name, msg: msg.slice(0, 300), context });
  if (entries.length > CAPACITY) entries.shift();
}

export function recentLogs(limit = 100, level?: BufferedLog['level']): BufferedLog[] {
  const filtered = level ? entries.filter((entry) => entry.level === level || (level === 'error' && entry.level === 'fatal')) : entries;
  return filtered.slice(-limit).reverse();
}

export function logCounts(): Record<BufferedLog['level'], number> {
  const counts = { warn: 0, error: 0, fatal: 0 };
  for (const entry of entries) counts[entry.level] += 1;
  return counts;
}
