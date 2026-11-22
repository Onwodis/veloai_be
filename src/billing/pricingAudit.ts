/**
 * Pricing & token-gate audit for the super admin (Pricing & profit page).
 *
 *   margins     every AI step and YouTube films: what it costs the platform vs what it sells
 *               for (at the cheapest token anyone can buy), placed in a zone so prices are
 *               neither loss-making nor greedy, with a recommended price in the healthy band
 *   settings    token-economy settings that work against each other (a trial smaller than the
 *               start balance, test payments, no daily ceiling…)
 *   gates       every paid feature and how it is protected: price held before work starts and
 *               charged on success, or absorbed by the platform (and roughly what that costs)
 *
 * Zones (gross margin = (price − provider cost) ÷ price): below 0 loss · 0–35 thin (fees, retries
 * and failed jobs eat it) · 35–70 healthy · 70–80 rich · above 80 greedy (users pay 5× cost or more).
 */
import { getTokenSettings } from '../services/settings.service.js';
import { studioEconomics } from '../studio/economics.js';
import { getYoutubeSettings } from '../youtube/settings.js';
import { getTrialSettings } from './trial.js';

export const MARGIN_ZONES = { thin: 0, healthy: 35, rich: 70, greedy: 80 } as const;
export type MarginZone = 'loss' | 'thin' | 'healthy' | 'rich' | 'greedy';
/** The middle of the healthy band: what recommendations aim for. */
export const FAIR_MARGIN = 55;

export function zoneOf(margin: number | null): MarginZone {
  if (margin === null || margin < MARGIN_ZONES.thin) return 'loss';
  if (margin < MARGIN_ZONES.healthy) return 'thin';
  if (margin < MARGIN_ZONES.rich) return 'healthy';
  if (margin < MARGIN_ZONES.greedy) return 'rich';
  return 'greedy';
}

const marginOf = (sell: number, cost: number): number | null => (sell > 0 ? Math.round(((sell - cost) / sell) * 1000) / 10 : null);
const priceFor = (cost: number, margin: number): number => cost / (1 - margin / 100);

export interface Finding {
  level: 'critical' | 'warning' | 'ok';
  title: string;
  detail: string;
  fix?: string;
}

/** Every paid feature and how it is gated (checked against the code, 2026-11-22). */
const GATES: { feature: string; gate: 'held' | 'platform'; note: string }[] = [
  { feature: 'Reels from long videos', gate: 'held', note: 'Estimate held before upload processing; charged per minute and per reel on success.' },
  { feature: 'AI Studio: identity, shot list, takes, edits, master', gate: 'held', note: 'Each step holds its price first (STUDIO_*), charges only what finishes, releases on failure.' },
  { feature: 'Music video: casting, scenes, chat, storyboard, shoot, foley, mix, master', gate: 'held', note: 'Every paid action goes through the project charge gate with the price shown first.' },
  { feature: 'Ads: director chat, script, voices, takes, master, versions', gate: 'held', note: 'Held per step; format versions are free by design.' },
  { feature: 'Creations, likeness training, character photos, cold opens', gate: 'held', note: 'Held before the engine starts; settled on success.' },
  { feature: 'YouTube films', gate: 'held', note: 'The film price is held when making starts and charged only when the film is finished.' },
  { feature: 'AI shot reviews (music videos and ads)', gate: 'platform', note: 'Each finished take is reviewed by Claude with images, free to the user: about US$0.01–0.03 a take. Covered by the take price at healthy margins.' },
  { feature: 'YouTube scripts (written a day ahead)', gate: 'platform', note: 'Written for every scheduled film, free (about US$0.02–0.05 each); a film skipped after its script is written still cost that.' },
  { feature: 'Watermark-free downloads, share links, format versions', gate: 'platform', note: 'No AI cost; storage and bandwidth only.' },
  { feature: 'Platform marketing (flyers, logos, promo ads)', gate: 'platform', note: 'Super admin only; paid by the platform.' },
];

export async function pricingAudit() {
  const [economics, tokens, youtube, trial] = await Promise.all([studioEconomics(), getTokenSettings(), getYoutubeSettings(), getTrialSettings()]);
  const { model, reference } = economics;
  const minorPerUnit = 100; // kobo per naira (prices are shown in naira)

  // ---- AI steps (cost and price per unit, in minor units, at the cheapest token).
  const steps = economics.lines.map((line) => {
    const sellFloor = Math.round(line.tokens * reference.floorPerToken);
    const margin = marginOf(sellFloor, line.cost);
    const fairTokens = line.cost === 0 ? line.tokens : Math.max(1, Math.ceil(priceFor(line.cost, FAIR_MARGIN) / reference.floorPerToken));
    return { key: line.key, unit: line.unit, tokens: line.tokens, cost: line.cost, sell: sellFloor, margin, zone: zoneOf(margin), recommendedTokens: fairTokens };
  });

  // ---- YouTube films, per 30 s: ~5 scenes, each a keyframe + video, narration, a score, a thumbnail and the script.
  const usd = model.providerUsd;
  const filmUsd30 = usd.videoPerSecond * 30 + usd.keyframe * 5 + usd.ttsPerSecond * 30 + usd.image + 0.02 /* music */ + 0.05; /* script + review */
  const filmCost = Math.round(filmUsd30 * model.usdToMinor);
  const filmTokens = Math.ceil(youtube.nairaPer30s / youtube.nairaPerToken);
  // What those tokens actually brought in if bought in the cheapest-per-token pack.
  const filmRevenue = Math.round(filmTokens * reference.floorPerToken);
  const filmMargin = marginOf(filmRevenue, filmCost);
  const recommendedPer30 = Math.ceil(priceFor(filmCost, FAIR_MARGIN) / minorPerUnit / 500) * 500;
  const listPerToken = youtube.nairaPerToken * minorPerUnit;

  // ---- packages: how deep the discount goes.
  const perToken = tokens.packages.map((pkg) => ({ id: pkg.id, name: pkg.name, tokens: pkg.tokens, price: pkg.price, perToken: pkg.price / pkg.tokens }));
  const top = Math.max(...perToken.map((pkg) => pkg.perToken));
  const packages = perToken.map((pkg) => ({ ...pkg, discountPercent: Math.round((1 - pkg.perToken / top) * 100) }));

  // ---- findings.
  const findings: Finding[] = [];
  const losing = steps.filter((step) => step.zone === 'loss');
  const greedy = steps.filter((step) => step.zone === 'greedy');
  const thin = steps.filter((step) => step.zone === 'thin');
  if (losing.length) {
    findings.push({ level: 'critical', title: `${losing.length} AI step${losing.length === 1 ? ' is' : 's are'} sold below cost`, detail: `Every use loses money: ${losing.map((step) => step.unit).join(', ')}.`, fix: 'Apply the recommended token prices below (or switch to cheaper models).' });
  }
  if (thin.length) findings.push({ level: 'warning', title: `${thin.length} step${thin.length === 1 ? ' has' : 's have'} a thin margin (under ${MARGIN_ZONES.healthy}%)`, detail: `Payment fees, retries and failed jobs can turn these into losses: ${thin.map((step) => step.unit).join(', ')}.` });
  if (greedy.length) findings.push({ level: 'warning', title: `${greedy.length} step${greedy.length === 1 ? ' is' : 's are'} priced greedily (over ${MARGIN_ZONES.greedy}% margin)`, detail: `Users pay 5× the cost or more: ${greedy.map((step) => step.unit).join(', ')}. Competitors can undercut this; consider the recommended price.` });
  if (filmMargin !== null && filmMargin < MARGIN_ZONES.healthy) {
    findings.push({
      level: filmMargin < 0 ? 'critical' : 'warning',
      title: filmMargin < 0 ? 'YouTube films lose money' : 'YouTube films have a thin margin',
      detail: `30 s of film costs about ₦${Math.round(filmCost / minorPerUnit).toLocaleString('en')} to make (US$${filmUsd30.toFixed(2)}) and brings in about ₦${Math.round(filmRevenue / minorPerUnit).toLocaleString('en')} at the cheapest token (${filmMargin}% margin).`,
      fix: `Raise the price to about ₦${recommendedPer30.toLocaleString('en')} per 30 s, or move scenes to a cheaper video model.`,
    });
  }
  if (listPerToken > reference.floorPerToken * 1.05) {
    findings.push({ level: 'warning', title: 'YouTube token rate is above what tokens sell for', detail: `YouTube converts ₦${youtube.nairaPerToken} per token, but the cheapest pack sells a token for ₦${(reference.floorPerToken / minorPerUnit).toFixed(2)}. Users who bought that pack pay fewer naira than the list price suggests.`, fix: `Set "₦ per token" in YouTube films settings to ₦${(reference.floorPerToken / minorPerUnit).toFixed(2)} so the ₦ price is what you really earn.` });
  }
  if (trial.enabled && trial.tokens < tokens.minimumStartBalance) {
    findings.push({ level: 'critical', title: 'The free trial can’t start anything', detail: `The trial gives ${trial.tokens} tokens but every paid task needs at least ${tokens.minimumStartBalance} available to start.`, fix: `Lower the minimum start balance to ${trial.tokens} or less, or raise the trial to at least ${tokens.minimumStartBalance}.` });
  }
  if (tokens.signupBonus > 0 && tokens.signupBonus < tokens.minimumStartBalance) {
    findings.push({ level: 'warning', title: 'Welcome tokens are below the start balance', detail: `New accounts get ${tokens.signupBonus} tokens but need ${tokens.minimumStartBalance} to start a task.` });
  }
  if (tokens.paystackMode === 'TEST') findings.push({ level: 'critical', title: 'Payments are in TEST mode', detail: 'No real money is collected: purchases use Paystack test keys.', fix: 'Switch to LIVE in Tokens & payments once the live key is in Credentials.' });
  if (tokens.dailyEngineCap === 0) findings.push({ level: 'warning', title: 'No daily film-engine ceiling', detail: 'A loop or runaway job could drain a wallet (and your provider balance) in one day.', fix: 'Set a daily ceiling in Tokens & payments.' });
  if (tokens.superAdminMode === 'UNLIMITED') findings.push({ level: 'ok', title: 'Super admin work is unmetered', detail: 'Your own work is never charged (recorded for analytics). Switch to METERED to experience the gates as users do.' });
  if (model.targetMarginPercent > MARGIN_ZONES.rich) findings.push({ level: 'warning', title: `Target margin ${model.targetMarginPercent}% is in the greedy range`, detail: `"Suggested" prices aim for it. A target between ${MARGIN_ZONES.healthy}% and ${MARGIN_ZONES.rich}% keeps you profitable and competitive.` });
  const deepest = Math.max(...packages.map((pkg) => pkg.discountPercent));
  if (deepest > 45) findings.push({ level: 'warning', title: `The biggest pack is ${deepest}% cheaper per token`, detail: 'Margins are checked at that price; a deep bulk discount pushes every step toward a loss.' });
  if (!findings.some((finding) => finding.level !== 'ok')) findings.push({ level: 'ok', title: 'No pricing problems found', detail: 'Every step is profitable at the cheapest token and nothing is greedy.' });

  return {
    zones: MARGIN_ZONES,
    fairMargin: FAIR_MARGIN,
    currency: economics.currency,
    floorPerToken: reference.floorPerToken,
    floorPackage: reference.floorPackage,
    steps,
    youtube: { per30: youtube.nairaPer30s, costPer30: Math.round(filmCost / minorPerUnit), revenuePer30: Math.round(filmRevenue / minorPerUnit), margin: filmMargin, zone: zoneOf(filmMargin), recommendedPer30, providerUsdPer30: Math.round(filmUsd30 * 100) / 100 },
    packages,
    findings: findings.sort((a, b) => ['critical', 'warning', 'ok'].indexOf(a.level) - ['critical', 'warning', 'ok'].indexOf(b.level)),
    gates: GATES,
  };
}
