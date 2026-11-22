/**
 * Benchmark & bottlenecks (super admin): how the platform compares with the products people
 * weigh it against, what is holding it back right now (measured live: failures, wait and render
 * times, concurrency, storage, pricing, configuration), and what to improve, in priority order.
 *
 * The competitor scorecard is a dated snapshot of public product capabilities (late 2026); the
 * bottlenecks and their severity are computed on every request.
 */
import { env } from '../config/env.js';
import { pricingAudit } from '../billing/pricingAudit.js';
import { getTokenSettings } from '../services/settings.service.js';
import { studioQueueCounts } from '../studio/queue.js';
import { getStudioSettings } from '../studio/settings.js';
import { sql } from '../studio/sql.js';
import * as fal from '../studio/fal.js';
import { youtubeConfigured } from '../youtube/channels.js';
import { secret } from '../vault/secrets.js';

type Mark = 'yes' | 'partial' | 'no';

export const COMPETITORS = [
  { id: 'runway', name: 'Runway', kind: 'AI video generator' },
  { id: 'kling', name: 'Kling', kind: 'AI video generator' },
  { id: 'higgsfield', name: 'Higgsfield', kind: 'AI video + camera presets' },
  { id: 'neuralframes', name: 'Neural Frames', kind: 'AI music videos' },
  { id: 'opus', name: 'OpusClip', kind: 'Reel clipper' },
  { id: 'heygen', name: 'HeyGen', kind: 'Avatars & presenters' },
  { id: 'creatify', name: 'Creatify', kind: 'AI ads' },
  { id: 'capcut', name: 'CapCut', kind: 'Editor with AI tools' },
] as const;
type CompetitorId = (typeof COMPETITORS)[number]['id'];

interface Row {
  area: string;
  capability: string;
  us: Mark;
  note: string;
  them: Record<CompetitorId, Mark>;
}

const all = (mark: Mark): Record<CompetitorId, Mark> => Object.fromEntries(COMPETITORS.map((c) => [c.id, mark])) as Record<CompetitorId, Mark>;
const set = (base: Mark, overrides: Partial<Record<CompetitorId, Mark>>): Record<CompetitorId, Mark> => ({ ...all(base), ...overrides });

/** The scorecard (public capabilities as of late 2026; edit when competitors ship). */
const SCORECARD: Row[] = [
  { area: 'Generation', capability: 'Photoreal text/image-to-video', us: 'yes', note: 'Same frontier models (Kling, Seedance) through fal.ai, switchable by the super admin.', them: set('no', { runway: 'yes', kling: 'yes', higgsfield: 'yes', neuralframes: 'partial', heygen: 'partial', creatify: 'partial', capcut: 'partial' }) },
  { area: 'Generation', capability: 'Longest single shot', us: 'partial', note: '5–10 s per shot (model limit); longer pieces are cut from many shots.', them: set('no', { runway: 'partial', kling: 'partial', higgsfield: 'partial', neuralframes: 'partial' }) },
  { area: 'Generation', capability: '4K / upscaled masters', us: 'partial', note: 'HD masters with an upscale pass; no native 4K generation.', them: set('no', { runway: 'yes', kling: 'partial', higgsfield: 'partial', capcut: 'yes', heygen: 'yes' }) },
  { area: 'Generation', capability: 'Cinematic camera control', us: 'yes', note: 'Camera energy (natural/bold/wild), 30+ named moves, kinetic model routing.', them: set('no', { runway: 'yes', kling: 'partial', higgsfield: 'yes', neuralframes: 'partial' }) },
  { area: 'People', capability: 'Same character across shots', us: 'yes', note: 'Casting sheets, reference-conditioned video, AI continuity review.', them: set('no', { runway: 'partial', kling: 'partial', higgsfield: 'partial', heygen: 'yes', creatify: 'partial' }) },
  { area: 'People', capability: 'Lip sync to a song', us: 'yes', note: 'Isolated vocal, per-line delivery, face-safe camera, re-check per shot.', them: set('no', { heygen: 'partial', neuralframes: 'partial', kling: 'partial', higgsfield: 'partial' }) },
  { area: 'People', capability: 'You on screen (personal likeness)', us: 'yes', note: '@me likeness training from your photos.', them: set('no', { heygen: 'yes', higgsfield: 'partial', capcut: 'partial' }) },
  { area: 'Productions', capability: 'Full music-video workflow', us: 'yes', note: 'Song → cast → storyboard → shoot → review → master, with an Auto Director.', them: set('no', { neuralframes: 'partial' }) },
  { area: 'Productions', capability: 'Ads from product photos, every format', us: 'yes', note: 'Brief, script, voices, end card, 9:16/1:1/4:5/16:9 versions.', them: set('no', { creatify: 'yes', heygen: 'partial', capcut: 'partial' }) },
  { area: 'Productions', capability: 'Reels from long videos', us: 'yes', note: 'Hook detection, reframing, word-by-word captions.', them: set('no', { opus: 'yes', capcut: 'yes' }) },
  { area: 'Productions', capability: 'Scheduled YouTube channel (written, made, published)', us: 'yes', note: 'Shows, scripts, films, thumbnails, publishing on a schedule.', them: all('no') },
  { area: 'Finishing', capability: 'Timeline editing & text animation', us: 'partial', note: 'Per-scene edits, text anywhere, transitions; not a full NLE.', them: set('no', { capcut: 'yes', runway: 'partial', opus: 'partial', creatify: 'partial' }) },
  { area: 'Finishing', capability: 'Mastering / audio mix', us: 'yes', note: 'Mastering desk + AI master, foley, mix.', them: set('no', { capcut: 'partial' }) },
  { area: 'Team & trust', capability: 'History, undo/redo, team pushes', us: 'yes', note: 'Checkpoints, side-by-side, restore, undo/redo.', them: set('no', { runway: 'partial', capcut: 'partial' }) },
  { area: 'Team & trust', capability: 'Price shown before every paid step', us: 'yes', note: 'Held, then charged only for finished work.', them: set('partial', { capcut: 'yes' }) },
  { area: 'Team & trust', capability: 'Local payments (naira)', us: 'yes', note: 'Paystack.', them: all('no') },
  { area: 'Reach', capability: 'Mobile app', us: 'no', note: 'Web only (responsive).', them: set('yes', { neuralframes: 'no', creatify: 'no', opus: 'partial' }) },
  { area: 'Reach', capability: 'Public API / integrations', us: 'no', note: 'No public API yet.', them: set('partial', { runway: 'yes', kling: 'yes', heygen: 'yes', capcut: 'no', neuralframes: 'no' }) },
  { area: 'Speed', capability: 'Many jobs in parallel', us: 'partial', note: 'One worker process; see bottlenecks.', them: all('yes') },
];

export interface Bottleneck {
  id: string;
  area: 'Capacity' | 'Reliability' | 'Speed' | 'Delivery' | 'Money' | 'Setup' | 'Product';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
  fix: string;
  effort: 'S' | 'M' | 'L';
}

const pct = (part: number, whole: number): number => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export async function benchmark() {
  const [studio, tokens, audit, queue] = await Promise.all([getStudioSettings(), getTokenSettings(), pricingAudit(), Promise.race([studioQueueCounts(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]).catch(() => null)]);
  const [takes] = await sql<{ total: number; failed: number; avgSeconds: number | null; p90Seconds: number | null; waiting: number }[]>`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
      avg(EXTRACT(EPOCH FROM finished_at - created_at)) FILTER (WHERE status = 'READY' AND finished_at IS NOT NULL)::float AS avg_seconds,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM finished_at - created_at)) FILTER (WHERE status = 'READY' AND finished_at IS NOT NULL)::float AS p90_seconds,
      count(*) FILTER (WHERE status = 'QUEUED')::int AS waiting
    FROM studio_takes WHERE created_at > now() - interval '7 days'`;
  const [errors] = await sql<{ top: string | null; n: number }[]>`
    SELECT left(error, 160) AS top, count(*)::int AS n FROM studio_takes
    WHERE status = 'FAILED' AND created_at > now() - interval '7 days' AND error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`;
  const maxShot = Math.max(...['imageToVideo', 'textToVideo', 'referenceVideo'].flatMap((job) => studio.models[job as 'imageToVideo'].durations.map(Number)).filter(Number.isFinite), 0);
  const t = takes ?? { total: 0, failed: 0, avgSeconds: null, p90Seconds: null, waiting: 0 };
  const failureRate = pct(t.failed, t.total);

  const found: Bottleneck[] = [];
  const add = (item: Bottleneck): void => {
    found.push(item);
  };

  // Capacity
  add({
    id: 'single-worker',
    area: 'Capacity',
    severity: (queue?.['waiting'] ?? 0) > studio.limits.concurrency * 3 ? 'critical' : 'high',
    title: `Only ${studio.limits.concurrency} video job${studio.limits.concurrency === 1 ? '' : 's'} at a time, inside the API process`,
    evidence: `${queue ? '' : 'The job queue (Redis) did not answer within 3 s. '}The studio worker runs ${env.MEDIA_WORKER_INLINE ? 'inside the API server' : 'as a worker'} with concurrency ${studio.limits.concurrency}${queue ? `; right now ${queue['waiting'] ?? 0} waiting, ${queue['active'] ?? 0} running` : ''}. YouTube films make 2 at a time. A restart pauses every job.`,
    fix: 'Run the studio worker as its own service (same image, MEDIA_WORKER_INLINE=false on the API), scale it horizontally, and raise concurrency to match the fal.ai account limit.',
    effort: 'M',
  });
  if (t.waiting > studio.limits.concurrency * 2) {
    add({ id: 'backlog', area: 'Capacity', severity: 'high', title: `${t.waiting} takes queued`, evidence: 'More takes are waiting than the worker can start.', fix: 'Scale the worker (above) or raise concurrency.', effort: 'S' });
  }

  // Reliability
  if (t.total >= 5) {
    add({
      id: 'failures',
      area: 'Reliability',
      severity: failureRate > 15 ? 'critical' : failureRate > 7 ? 'high' : failureRate > 3 ? 'medium' : 'low',
      title: `${failureRate}% of takes failed in the last 7 days`,
      evidence: `${t.failed} of ${t.total} takes failed${errors?.top ? `; most common: "${errors.top}" (${errors.n}×)` : ''}. Industry tools aim for under 3%.`,
      fix: 'Retry provider errors automatically once (timeouts, 5xx, rate limits) before failing; route to a fallback model when the primary is down.',
      effort: 'M',
    });
  }

  // Speed
  if (t.avgSeconds) {
    const avg = Math.round(t.avgSeconds);
    add({
      id: 'render-time',
      area: 'Speed',
      severity: avg > 600 ? 'high' : avg > 300 ? 'medium' : 'low',
      title: `A take takes ${Math.round(avg / 60)} min on average (90% within ${Math.round((t.p90Seconds ?? avg) / 60)} min)`,
      evidence: 'From queued to ready, last 7 days. Runway/Kling deliver a 5 s clip in about 1–3 minutes on paid tiers.',
      fix: 'Use the provider’s faster tier for previews (draft takes), keep the best model for the final; start keyframes and video for all scenes in parallel.',
      effort: 'M',
    });
  }
  add({
    id: 'shot-length',
    area: 'Product',
    severity: 'medium',
    title: `Longest single shot: ${maxShot || 10} s`,
    evidence: 'Set by the video models in use. Competitors now offer 10–20 s single generations and shot extension.',
    fix: 'Add "extend shot" (continue from the last frame) and enable longer durations on models that support them.',
    effort: 'M',
  });

  // Delivery
  const publicUrl = env.CF_R2_PUBLIC_URL ?? '';
  if (/r2\.dev/i.test(publicUrl)) {
    add({ id: 'r2dev', area: 'Delivery', severity: 'high', title: 'Videos are served from the r2.dev test address', evidence: 'r2.dev is rate-limited and not cached by Cloudflare: playback stutters and can be throttled under load.', fix: 'Connect a custom domain to the bucket (e.g. media.yourdomain) and set CF_R2_PUBLIC_URL to it; turn on caching.', effort: 'S' });
  } else if (!publicUrl) {
    add({ id: 'no-cdn', area: 'Delivery', severity: 'medium', title: 'No public media domain', evidence: 'Every preview is a signed bucket URL: uncached, slower to start.', fix: 'Connect a custom domain to the bucket and set CF_R2_PUBLIC_URL (personal files stay on signed links).', effort: 'S' });
  }

  // Money
  const losing = audit.steps.filter((step) => step.zone === 'loss').length;
  if (losing) add({ id: 'below-cost', area: 'Money', severity: 'critical', title: `${losing} of ${audit.steps.length} AI steps are sold below cost`, evidence: 'Every use of them loses money; growth makes it worse.', fix: 'Apply the recommended prices on Pricing & profit (fair 55% margin).', effort: 'S' });
  if (audit.youtube.zone === 'loss') add({ id: 'youtube-price', area: 'Money', severity: 'high', title: 'YouTube films lose money', evidence: `₦${audit.youtube.per30.toLocaleString('en')} per 30 s brings ~₦${audit.youtube.revenuePer30.toLocaleString('en')} against ~₦${audit.youtube.costPer30.toLocaleString('en')} cost.`, fix: `Raise to ~₦${audit.youtube.recommendedPer30.toLocaleString('en')} per 30 s or use a cheaper video model for films.`, effort: 'S' });
  if (tokens.paystackMode === 'TEST') add({ id: 'test-payments', area: 'Money', severity: 'critical', title: 'Payments are in TEST mode', evidence: 'No real money is collected.', fix: 'Add the live Paystack key and switch to LIVE.', effort: 'S' });

  // Setup
  if (!fal.falConfigured()) add({ id: 'no-fal', area: 'Setup', severity: 'critical', title: 'The video engine is not connected', evidence: 'No fal.ai key.', fix: 'Add the fal.ai key in Credentials.', effort: 'S' });
  if (!secret('ANTHROPIC_API_KEY')) add({ id: 'no-claude', area: 'Setup', severity: 'medium', title: 'No Anthropic key in Credentials', evidence: 'The AI director relies on the AI models page or this key.', fix: 'Confirm a Claude engine is set on AI models (or add the key).', effort: 'S' });
  if (!youtubeConfigured()) add({ id: 'no-youtube', area: 'Setup', severity: 'medium', title: 'YouTube publishing is off', evidence: 'No Google OAuth client: shows can make films but not publish them.', fix: 'Create the OAuth client and add it in Credentials (see YouTube films settings).', effort: 'S' });

  // Product gaps vs the scorecard
  add({ id: 'no-api', area: 'Product', severity: 'low', title: 'No public API', evidence: 'Agencies and power users integrate Runway, Kling and HeyGen through their APIs.', fix: 'Expose a token-billed API for ads and reels (API keys per workspace).', effort: 'L' });
  add({ id: 'no-mobile', area: 'Product', severity: 'low', title: 'No mobile app', evidence: 'Creators work from phones; CapCut, Runway and HeyGen have apps.', fix: 'Ship a PWA first (install prompt, push notifications), then a store app for reels.', effort: 'L' });

  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  found.sort((a, b) => rank[a.severity] - rank[b.severity] || a.effort.localeCompare(b.effort));

  // The improvement plan: fixes ordered by severity, quick wins first within a severity.
  const plan = found.map((item, index) => ({ order: index + 1, title: item.fix, why: item.title, severity: item.severity, effort: item.effort, area: item.area }));

  return {
    asOf: 'Late 2026 (public product pages and release notes)',
    competitors: COMPETITORS,
    scorecard: SCORECARD,
    summary: {
      us: SCORECARD.reduce((sum, row) => sum + (row.us === 'yes' ? 1 : row.us === 'partial' ? 0.5 : 0), 0),
      them: Object.fromEntries(COMPETITORS.map((c) => [c.id, SCORECARD.reduce((sum, row) => sum + (row.them[c.id] === 'yes' ? 1 : row.them[c.id] === 'partial' ? 0.5 : 0), 0)])),
      rows: SCORECARD.length,
    },
    metrics: { takes7d: t.total, failureRate, avgTakeSeconds: t.avgSeconds ? Math.round(t.avgSeconds) : null, p90TakeSeconds: t.p90Seconds ? Math.round(t.p90Seconds) : null, queue, concurrency: studio.limits.concurrency, maxShotSeconds: maxShot || null },
    bottlenecks: found,
    plan,
  };
}
