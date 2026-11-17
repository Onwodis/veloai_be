/**
 * Super-admin intelligence: traffic, where people are, security findings,
 * live load, and an overall system rating with strengths and weaknesses.
 *
 *   traffic      API requests per hour (24 h), weekday × hour heat map, the
 *                busiest minute, error rates, latency (p50 / p95), slow and
 *                busy routes (activity_logs)
 *   visitors     devices, first visits, page views, referrers, countries and
 *                cities (site_visits + offline GeoIP; IPs never leave the server)
 *   security     failed / successful logins, lockouts, token replays, MFA
 *                failures; brute force (8+ failures from one IP in an hour),
 *                impossible travel (two sign-ins too far apart for the time
 *                between them), new device in a new country
 *   load         what is running right now (takes by stage, masters, requests
 *                in the last 5 minutes, people active in the last 15)
 *   rating       0-100 per area (reliability, speed, security, production)
 *                → an overall grade, with plain strengths and weaknesses
 */
import { sql } from '../studio/sql.js';
import { countryName, deviceOf, distanceKm, placeOf, type Place } from './geo.js';

const BRUTE_FORCE_PER_HOUR = 8;
const MAX_TRAVEL_KMH = 900;

interface SecurityRow {
  userId: string | null;
  type: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export async function insights(rangeDays: number) {
  const from = new Date(Date.now() - rangeDays * 86_400_000);
  const [
    perHour,
    heat,
    [peak],
    [totals],
    slowRoutes,
    busyRoutes,
    [visits],
    referrers,
    visitIps,
    [loginCounts],
    bruteRows,
    successes,
    recentEvents,
    [load],
    [people],
    [production],
  ] = await Promise.all([
    sql<{ hour: string; requests: number; users: number }[]>`
      SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24') AS hour, count(*)::int AS requests, count(DISTINCT user_id)::int AS users
      FROM activity_logs WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
    sql<{ dow: number; hour: number; requests: number }[]>`
      SELECT extract(isodow FROM created_at)::int AS dow, extract(hour FROM created_at)::int AS hour, count(*)::int AS requests
      FROM activity_logs WHERE created_at >= ${from} GROUP BY 1, 2`,
    sql<{ minute: Date | null; requests: number }[]>`
      SELECT date_trunc('minute', created_at) AS minute, count(*)::int AS requests
      FROM activity_logs WHERE created_at >= ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
    sql<{ requests: number; errors5xx: number; errors4xx: number; p50: number | null; p95: number | null; readP95: number | null }[]>`
      SELECT count(*)::int AS requests,
        count(*) FILTER (WHERE status_code >= 500)::int AS errors5xx,
        count(*) FILTER (WHERE status_code BETWEEN 400 AND 499)::int AS errors4xx,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float AS p95,
        -- Reads only: AI calls and uploads are long by nature and would hide how fast pages feel.
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE method = 'GET')::float AS read_p95
      FROM activity_logs WHERE created_at >= ${from}`,
    sql<{ route: string; requests: number; p95: number; errors: number }[]>`
      SELECT regexp_replace(COALESCE(route, path), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ':id', 'g') AS route, count(*)::int AS requests,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float AS p95,
        count(*) FILTER (WHERE status_code >= 500)::int AS errors
      FROM activity_logs WHERE created_at >= ${from} GROUP BY 1 HAVING count(*) >= 5 ORDER BY p95 DESC LIMIT 8`,
    sql<{ route: string; requests: number }[]>`
      SELECT regexp_replace(COALESCE(route, path), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ':id', 'g') AS route, count(*)::int AS requests FROM activity_logs WHERE created_at >= ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    sql<{ devices: number; firstVisits: number; pageViews: number; signedIn: number }[]>`
      SELECT count(DISTINCT visitor_id)::int AS devices, count(*) FILTER (WHERE first_visit)::int AS first_visits,
        COALESCE(sum(page_views), 0)::int AS page_views, count(DISTINCT user_id)::int AS signed_in
      FROM site_visits WHERE day >= ${from.toISOString().slice(0, 10)}::date`,
    sql<{ referrer: string; visits: number }[]>`
      SELECT regexp_replace(referrer, '^https?://([^/]+).*$', '\\1') AS referrer, count(*)::int AS visits
      FROM site_visits WHERE day >= ${from.toISOString().slice(0, 10)}::date AND referrer IS NOT NULL AND referrer <> ''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    sql<{ ipAddress: string; devices: number }[]>`
      SELECT ip_address, count(DISTINCT visitor_id)::int AS devices FROM site_visits
      WHERE day >= ${from.toISOString().slice(0, 10)}::date AND ip_address IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5000`,
    sql<{ failed: number; succeeded: number; locked: number; reuse: number; mfaFailed: number; resets: number }[]>`
      SELECT count(*) FILTER (WHERE type = 'LOGIN_FAILED')::int AS failed,
        count(*) FILTER (WHERE type = 'LOGIN_SUCCEEDED')::int AS succeeded,
        count(*) FILTER (WHERE type = 'ACCOUNT_LOCKED')::int AS locked,
        count(*) FILTER (WHERE type = 'TOKEN_REUSE_DETECTED')::int AS reuse,
        count(*) FILTER (WHERE type = 'MFA_FAILED')::int AS mfa_failed,
        count(*) FILTER (WHERE type = 'PASSWORD_RESET')::int AS resets
      FROM security_events WHERE created_at >= ${from}`,
    sql<{ ipAddress: string; hour: Date; failures: number; accounts: number }[]>`
      SELECT ip_address, date_trunc('hour', created_at) AS hour, count(*)::int AS failures,
        count(DISTINCT COALESCE(user_id::text, metadata->>'email'))::int AS accounts
      FROM security_events WHERE type = 'LOGIN_FAILED' AND created_at >= ${from} AND ip_address IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) >= ${BRUTE_FORCE_PER_HOUR} ORDER BY 3 DESC LIMIT 20`,
    sql<(SecurityRow & { email: string | null; displayName: string | null })[]>`
      SELECT e.user_id, e.type, e.ip_address, e.user_agent, e.metadata, e.created_at, u.email, u.display_name
      FROM security_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.type = 'LOGIN_SUCCEEDED' AND e.user_id IS NOT NULL AND e.created_at >= ${new Date(from.getTime() - 30 * 86_400_000)}
      ORDER BY e.user_id, e.created_at LIMIT 20000`,
    sql<(SecurityRow & { email: string | null })[]>`
      SELECT e.user_id, e.type::text, e.ip_address, e.user_agent, e.metadata, e.created_at, u.email
      FROM security_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.type IN ('LOGIN_FAILED', 'ACCOUNT_LOCKED', 'TOKEN_REUSE_DETECTED', 'MFA_FAILED', 'ROLE_CHANGED', 'PASSWORD_RESET', 'MFA_RESET', 'ALL_SESSIONS_REVOKED')
      ORDER BY e.created_at DESC LIMIT 25`,
    sql<{ queued: number; rendering: number; lipsync: number; storing: number; masters: number; requests5m: number; active15m: number }[]>`
      SELECT (SELECT count(*)::int FROM studio_takes WHERE status = 'QUEUED') AS queued,
        (SELECT count(*)::int FROM studio_takes WHERE status IN ('KEYFRAME', 'ANIMATING')) AS rendering,
        (SELECT count(*)::int FROM studio_takes WHERE status = 'LIPSYNC') AS lipsync,
        (SELECT count(*)::int FROM studio_takes WHERE status = 'STORING') AS storing,
        (SELECT count(*)::int FROM studio_projects WHERE status = 'ASSEMBLING') AS masters,
        (SELECT count(*)::int FROM activity_logs WHERE created_at > now() - interval '5 minutes') AS requests5m,
        (SELECT count(DISTINCT user_id)::int FROM activity_logs WHERE created_at > now() - interval '15 minutes' AND user_id IS NOT NULL) AS active15m`,
    sql<{ users: number; twoFactor: number }[]>`SELECT count(*)::int AS users, count(*) FILTER (WHERE totp_enabled_at IS NOT NULL)::int AS two_factor FROM users`,
    sql<{ ready: number; failed: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'READY')::int AS ready, count(*) FILTER (WHERE status = 'FAILED')::int AS failed FROM studio_takes WHERE created_at >= ${from}`,
  ]);

  /* ---- where people are ---- */
  const countries = new Map<string, number>();
  const cities = new Map<string, { city: string; country: string; devices: number }>();
  for (const row of visitIps) {
    const place = await placeOf(row.ipAddress);
    countries.set(place.country, (countries.get(place.country) ?? 0) + row.devices);
    if (place.city) {
      const key = `${place.city}|${place.country}`;
      const current = cities.get(key) ?? { city: place.city, country: place.country, devices: 0 };
      current.devices += row.devices;
      cities.set(key, current);
    }
  }

  /* ---- suspicious sign-ins ---- */
  const travel: { userId: string; email: string | null; from: string; to: string; km: number; hours: number; at: string }[] = [];
  const newDevice: { userId: string; email: string | null; device: string; place: string; ip: string | null; at: string }[] = [];
  const seen = new Map<string, { countries: Set<string>; pairs: Set<string>; last: { place: Place; at: Date } | null }>();
  for (const event of successes) {
    if (!event.userId) continue;
    const place = await placeOf(event.ipAddress);
    const device = deviceOf(event.userAgent);
    const memory = seen.get(event.userId) ?? { countries: new Set<string>(), pairs: new Set<string>(), last: null };
    const inRange = event.createdAt >= from;
    if (inRange && memory.last) {
      const km = distanceKm(memory.last.place, place);
      const hours = Math.max(0.05, (event.createdAt.getTime() - memory.last.at.getTime()) / 3_600_000);
      if (km !== null && km > 500 && km / hours > MAX_TRAVEL_KMH) {
        travel.push({ userId: event.userId, email: event.email, from: countryName(memory.last.place.country), to: countryName(place.country), km: Math.round(km), hours: Math.round(hours * 10) / 10, at: event.createdAt.toISOString() });
      }
    }
    const known = place.country === '??' || place.country === 'LOCAL';
    if (inRange && memory.countries.size > 0 && !known && !memory.countries.has(place.country) && !memory.pairs.has(`${device}|${place.country}`)) {
      newDevice.push({ userId: event.userId, email: event.email, device, place: [place.city, countryName(place.country)].filter(Boolean).join(', '), ip: event.ipAddress, at: event.createdAt.toISOString() });
    }
    if (!known) memory.countries.add(place.country);
    memory.pairs.add(`${device}|${place.country}`);
    memory.last = { place, at: event.createdAt };
    seen.set(event.userId, memory);
  }
  const bruteForce = await Promise.all(
    bruteRows.map(async (row) => {
      const place = await placeOf(row.ipAddress);
      return { ip: row.ipAddress, hour: row.hour.toISOString(), failures: row.failures, accounts: row.accounts, place: [place.city, countryName(place.country)].filter(Boolean).join(', ') };
    }),
  );

  /* ---- rating ---- */
  const t = totals!;
  const errorRate = t.requests ? (t.errors5xx / t.requests) * 100 : 0;
  const takeFailure = production!.ready + production!.failed ? (production!.failed / (production!.ready + production!.failed)) * 100 : 0;
  const twoFactorShare = people!.users ? (people!.twoFactor / people!.users) * 100 : 0;
  const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));
  const areas = [
    { key: 'reliability', label: 'Reliability', score: clamp(100 - errorRate * 20), note: `${errorRate.toFixed(2)}% of requests failed on the server (5xx)` },
    { key: 'speed', label: 'Speed', score: clamp(t.readP95 === null ? 100 : 100 - Math.max(0, t.readP95 - 300) / 25), note: `95% of page reads answer within ${Math.round(t.readP95 ?? 0)} ms (all requests incl. AI and uploads: ${Math.round(t.p95 ?? 0)} ms)` },
    {
      key: 'security',
      label: 'Security',
      score: clamp(55 + twoFactorShare * 0.45 - bruteForce.length * 8 - (loginCounts!.reuse > 0 ? 15 : 0) - travel.length * 5),
      note: `${Math.round(twoFactorShare)}% of accounts use 2FA · ${bruteForce.length} brute-force burst(s) · ${loginCounts!.reuse} token replay(s)`,
    },
    { key: 'production', label: 'Production', score: clamp(100 - takeFailure * 1.5), note: `${takeFailure.toFixed(1)}% of video takes failed` },
  ];
  const overall = Math.round(areas.reduce((sum, area) => sum + area.score, 0) / areas.length);
  const grade = overall >= 90 ? 'A' : overall >= 80 ? 'B' : overall >= 70 ? 'C' : overall >= 60 ? 'D' : 'E';
  const strengths = [
    ...areas.filter((area) => area.score >= 85).map((area) => `${area.label}: ${area.note}.`),
    'Every paid step is priced up front, held atomically and settled once (no double charges on retries).',
    'Sign-in: hashed passwords, rotating refresh tokens with replay detection, TOTP 2FA, an append-only security log.',
    'Media lives in object storage behind signed URLs; public links are encrypted, expiring and revocable.',
  ];
  const weaknesses = [
    ...areas.filter((area) => area.score < 70).map((area) => `${area.label}: ${area.note}.`),
    ...(twoFactorShare < 50 ? [`Only ${Math.round(twoFactorShare)}% of accounts have 2FA: consider requiring it for everyone with paid work.`] : []),
    ...(bruteForce.length ? ['Brute-force bursts seen: rate-limit sign-in per IP more tightly or add a challenge after failures.'] : []),
    ...(slowRoutes[0] && slowRoutes[0].p95 > 3000 ? [`Slowest route ${slowRoutes[0].route} takes ${Math.round(slowRoutes[0].p95)} ms at p95: profile or move it to a background job.`] : []),
    'A single API host and one worker: no failover yet (a second instance behind the proxy removes the single point of failure).',
  ];

  return {
    rangeDays,
    traffic: {
      perHour,
      heat,
      peak: peak?.minute ? { at: peak.minute.toISOString(), requests: peak.requests } : null,
      totals: { requests: t.requests, errors5xx: t.errors5xx, errors4xx: t.errors4xx, p50: Math.round(t.p50 ?? 0), p95: Math.round(t.p95 ?? 0), readP95: Math.round(t.readP95 ?? 0), errorRate: Math.round(errorRate * 100) / 100 },
      slowRoutes: slowRoutes.map((row) => ({ ...row, p95: Math.round(row.p95) })),
      busyRoutes,
    },
    visitors: {
      ...visits!,
      referrers,
      countries: [...countries.entries()].map(([code, devices]) => ({ code, name: countryName(code), devices })).sort((a, b) => b.devices - a.devices).slice(0, 15),
      cities: [...cities.values()].map((row) => ({ ...row, country: countryName(row.country) })).sort((a, b) => b.devices - a.devices).slice(0, 10),
    },
    security: {
      counts: loginCounts!,
      bruteForce,
      impossibleTravel: travel.slice(-20).reverse(),
      newDeviceNewCountry: newDevice.slice(-20).reverse(),
      recent: await Promise.all(
        recentEvents.map(async (event) => {
          const place = await placeOf(event.ipAddress);
          return { type: event.type, userId: event.userId, email: event.email ?? (typeof event.metadata?.['email'] === 'string' ? (event.metadata['email'] as string) : null), ip: event.ipAddress, place: [place.city, countryName(place.country)].filter(Boolean).join(', '), device: deviceOf(event.userAgent), at: event.createdAt.toISOString() };
        }),
      ),
    },
    load: load!,
    rating: { overall, grade, areas, strengths, weaknesses },
  };
}
