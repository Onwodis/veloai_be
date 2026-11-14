/**
 * VeloBot as a commercial director (the AI calls of the commercials studio).
 *
 *   discuss()      one turn of the director's room: a short spoken-style reply
 *                  (it may be read aloud) AND the updated running summary
 *                  (agreed / still open / next step), in the same call, so the
 *                  conversation never re-sends a growing history to summarise.
 *   writeScript()  the ad script from company + product (with its photos) +
 *                  objective + general rules + the approved summary, held to
 *                  the ad's length (never over 60 s).
 * Token cost is charged by the caller (ads.ts) per call.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import { parse, photoBlock } from '../studio/director.js';
import type { CompanyRow } from './companies.js';
import type { ProductRow } from './products.js';
import { MAX_AD_SECONDS, scriptSchema, type AdRules, type AdScript } from './schemas.js';

export interface AdBrief {
  objective: string;
  platform: string;
  lengthSec: number;
  goal: string;
  callToAction: string;
  rules: AdRules;
}

export interface DirectorSummary {
  agreed: string[];
  open: string[];
  next: string;
}

const SummarySchema = z.object({
  agreed: z.array(z.string()).describe('Decisions the client and director agreed, short bullet phrases'),
  open: z.array(z.string()).describe('Questions still open, short'),
  next: z.string().describe('The single next step, one sentence'),
});

const TurnSchema = z.object({
  reply: z
    .string()
    .describe('The director’s reply: warm, plain spoken English (it may be read aloud), under 90 words, at most two questions, no lists or markdown'),
  summary: SummarySchema,
});

function context(company: CompanyRow, product: ProductRow, brief: AdBrief): string {
  const rules = brief.rules;
  const cast = (rules.characters ?? [])
    .map((character) => `${character.name}${character.role ? ` (${character.role})` : ''}: ${[character.age, character.gender, character.look].filter(Boolean).join(', ')}${character.voice ? `; voice ${[character.voice.language, character.voice.accent, character.voice.tone].filter(Boolean).join(', ')}` : ''}`)
    .join('\n');
  return [
    `Company: ${company.name}${company.industry ? ` (${company.industry})` : ''}. ${company.description}`.trim(),
    company.tone ? `Brand tone: ${company.tone}` : '',
    `Product: ${product.name}${product.category ? ` · ${product.category}` : ''}${product.price ? ` · ${product.price}` : ''}. ${product.description}`.trim(),
    product.usps.length ? `Selling points: ${product.usps.join('; ')}` : '',
    Object.keys(product.audience).length ? `Audience: ${Object.entries(product.audience).map(([key, value]) => `${key} ${value}`).join(', ')}` : '',
    `Objective: ${brief.objective.toLowerCase().replace('_', ' ')} · platform ${brief.platform.toLowerCase()} · length ${brief.lengthSec} s (hard limit ${MAX_AD_SECONDS} s).`,
    brief.goal ? `Goal in the client's words: ${brief.goal}` : '',
    brief.callToAction ? `Call to action: ${brief.callToAction}` : '',
    `General rules every scene follows: ${[
      rules.environment && `environment ${rules.environment}`,
      rules.location && `location ${rules.location}`,
      rules.country && `country ${rules.country}`,
      rules.castEthnicity && `cast ${rules.castEthnicity}`,
      rules.language && `language ${rules.language}`,
      rules.accent && `accent ${rules.accent}`,
      rules.education && `education / register ${rules.education}`,
      rules.composure && `composure ${rules.composure}`,
      rules.costume && `costume ${rules.costume}`,
      rules.dressSense && `dress sense ${rules.dressSense}`,
      rules.music && `music ${rules.music}`,
    ]
      .filter(Boolean)
      .join('; ') || 'none set'}`,
    cast ? `Default cast:\n${cast}` : 'No fixed cast yet.',
  ]
    .filter(Boolean)
    .join('\n');
}

const DISCUSS_SYSTEM = `You are ${env.BOT_NAME}, an award-winning commercial director, in a pre-production meeting with a client. ` +
  'Lead the conversation: understand the product, the audience and what the ad must achieve, then shape the idea (the hook in the first 2 seconds, the story, the proof, the call to action). ' +
  'Ask at most two focused questions per turn; propose concrete ideas, not generic ones; respect the general rules and the length limit. ' +
  'Keep the running summary up to date: what is agreed, what is still open, and the next step. When nothing important is open, say the summary is ready to approve.';

export async function discuss(input: { company: CompanyRow; product: ProductRow; brief: AdBrief; summary: DirectorSummary | null; recent: { author: string; content: string }[]; message: string }) {
  const history = input.recent.map((item) => `${item.author === 'CREATOR' ? 'CLIENT' : 'DIRECTOR'}: ${item.content}`).join('\n');
  const { data, engine } = await parse('commercial', TurnSchema, DISCUSS_SYSTEM, [
    { type: 'text', text: context(input.company, input.product, input.brief) },
    { type: 'text', text: `Running summary so far: ${input.summary ? JSON.stringify(input.summary) : 'none yet (first turn)'}` },
    { type: 'text', text: history ? `Recent turns:\n${history}` : 'This is the first message.' },
    { type: 'text', text: `CLIENT: ${input.message}` },
  ]);
  return { ...data, engine };
}

const SCRIPT_SYSTEM = `You are ${env.BOT_NAME}, a top commercial director and copywriter. Write a shootable ad script. ` +
  'Hook in the first 2 seconds; one clear idea; show the product exactly as it is (its real look, packaging and colours from the photos); proof or benefit; a clear call to action at the end. ' +
  `Scenes are 2-8 seconds each and the total MUST NOT exceed the requested length (never more than ${MAX_AD_SECONDS} s). ` +
  'Every visual is a concrete, filmable shot description following the general rules (setting, cast, wardrobe, language, accent); real-life look, never "AI cinematic". ' +
  'Spoken lines are natural, in the requested language and accent, short enough to say in the scene time (about 2.5 words per second). ' +
  'In "why", explain in plain words why this script fits the objective and audience.';

export async function writeScript(input: { company: CompanyRow; product: ProductRow; brief: AdBrief; summary: DirectorSummary | null; productPhotoKeys: string[]; notes?: string | undefined }): Promise<AdScript & { engine: string }> {
  const photos = await Promise.all(input.productPhotoKeys.slice(0, 2).map((key) => photoBlock(key).catch(() => null)));
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: 'text', text: context(input.company, input.product, input.brief) },
    { type: 'text', text: `Agreed in the director's room: ${input.summary ? JSON.stringify(input.summary) : 'nothing recorded; use the brief'}` },
    ...(input.notes ? [{ type: 'text' as const, text: `Extra notes from the client for this version: ${input.notes}` }] : []),
    ...(photos.some(Boolean) ? [{ type: 'text' as const, text: 'Product photos (show it exactly like this):' }, ...photos.filter((block): block is NonNullable<typeof block> => Boolean(block))] : []),
  ];
  const { data, engine } = await parse('commercial', scriptSchema, SCRIPT_SYSTEM, content);
  return { ...fitToLength(data, input.brief.lengthSec), engine };
}

/** Holds the script to the ad length: scenes 2-10 s (half seconds), total ≤ length (≤ 60 s). */
export function fitToLength(script: AdScript, lengthSec: number): AdScript {
  const limit = Math.min(MAX_AD_SECONDS, lengthSec);
  const round = (value: number): number => Math.round(Math.min(10, Math.max(2, value)) * 2) / 2;
  let scenes = script.scenes.map((scene) => ({ ...scene, seconds: round(scene.seconds) }));
  const total = scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  if (total > limit) {
    const factor = limit / total;
    scenes = scenes.map((scene) => ({ ...scene, seconds: round(scene.seconds * factor) }));
    // Rounding can still overshoot by a half second or two: trim from the longest scenes.
    let over = scenes.reduce((sum, scene) => sum + scene.seconds, 0) - limit;
    while (over > 0.01) {
      const longest = scenes.reduce((best, scene, index) => (scene.seconds > scenes[best]!.seconds ? index : best), 0);
      if (scenes[longest]!.seconds <= 2) break;
      scenes[longest] = { ...scenes[longest]!, seconds: scenes[longest]!.seconds - 0.5 };
      over -= 0.5;
    }
    // Still too long with every scene at its 2 s minimum: drop middle scenes (keep the hook and the call to action).
    while (scenes.length > 2 && scenes.reduce((sum, scene) => sum + scene.seconds, 0) > limit + 0.01) scenes.splice(scenes.length - 2, 1);
  }
  return { ...script, scenes };
}
