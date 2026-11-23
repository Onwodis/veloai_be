/**
 * "Create a look from the description": a character who has no real-life
 * photo (an invented lover, a rival, a narrator, a crowd face) gets reference
 * photos generated from what the artist wrote about them, so they work like
 * any photographed character: casting sheet, identity lock in every shot,
 * same face from scene to scene.
 *
 *   1. a front-facing head-and-shoulders portrait from the description
 *      (gender, age, build, skin tone, hair, eyes, marks, persona, first look,
 *      the video's location / cast background), text-to-image
 *   2. a full-body photo of THE SAME person in their first outfit, made from
 *      that portrait with the image-edit model (identity carried over)
 *   3. both attached to the character as photos; permission recorded as
 *      "AI-created character: no real person" (nobody's likeness is used)
 *   4. the casting sheet is built from them straight away
 * Tokens: one image + one image edit + the casting sheet, shown on the button
 * and held up front; only what was made is charged.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthContext } from '../middleware/authenticate.js';
import { keys, uploadFile } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { assertStorage } from '../storage/service.js';
import * as fal from '../studio/fal.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { ENGINE_NAME } from '../utils/engineName.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';
import { parse } from '../studio/director.js';
import type { CharacterRow } from './cast.js';
import { access, assertStage, castOne, load, loadCharacter, view } from './service.js';
import { parseDirection, placeText } from './songmap.js';

/**
 * People may describe a character with famous names ("a young Denzel", "like Rihanna in 2016"). The
 * image model must never draw a real, recognisable person: the director first turns every name into
 * general traits (age range, build, skin tone, hair, style, energy), and the portrait is of an
 * original person with a face of their own.
 */
const ORIGINAL =
  'An original, entirely fictional person with their own distinct face: not any real, famous or recognisable individual and must not resemble any celebrity; a believable real human, not a model-perfect AI face.';

/**
 * The words that make image models' safety filters black out a photo (sexual words, sizes of intimate
 * body parts) even when the brief is an ordinary music-video casting. Used when the director can't be
 * reached: the look is kept, the trigger words go.
 */
const FILTER_WORDS: [RegExp, string][] = [
  [/\b(big|huge|large|fat|thick)\s+(bum\s*bum|bum|booty|butt|backside|behind|ass)\b/gi, 'full hips'],
  [/\b(bum\s*bum|booty|butt|ass)\b/gi, 'hips'],
  [/\b(moderate|small|big|huge|large)\s+(breasts?|boobs?|chest|bust)(\s+size)?\b/gi, ''],
  [/\b(breasts?|boobs?|cleavage|nipples?)\b/gi, ''],
  [/\b(extremely|very|super)\s+(sexy|hot)\b/gi, 'striking'],
  [/\b(sexy|hot|seductive|sensual|naughty|kinky|erotic|nude|naked|horny|lingerie)\b/gi, 'confident'],
];

function filterSafe(text: string): string {
  let out = text;
  for (const [pattern, replacement] of FILTER_WORDS) out = out.replace(pattern, replacement);
  return out.replace(/\b(confident)(\s*,?\s*confident)+\b/gi, '$1').replace(/\s{2,}/g, ' ').replace(/\s+([,;.])/g, '$1').replace(/([,;])\s*[,;]+/g, '$1').trim();
}

const BriefSchema = z.object({
  look: z
    .string()
    .describe(
      'The character as a casting director and stylist would brief a photographer: age range, gender, ethnicity/heritage when given, skin tone, face, hair, build and figure ' +
        '(e.g. "curvy hourglass figure, full hips and thighs"), height, energy and attitude, styling. Keep every physical intent of the artist; professional, non-explicit words only; no names of anyone.',
    ),
});
const BRIEF_SYSTEM =
  'You are the casting director of a music video, turning the artist\'s notes into a brief for a photographer and an image model. Keep everything the artist wants: ' +
  'beauty, body type and figure (curvy, hourglass, full hips, slim, athletic, plus-size…), heritage and skin tone, age, hair, confidence and attitude. Write it the way ' +
  'a professional casting brief or fashion shoot call sheet does: respectful, concrete, tasteful. Image models block sexual wording and sizes of intimate body parts, so ' +
  'say figure and attitude in styling terms instead (e.g. "big bum bum" → "full, curvy hips"; "extremely sexy, naughty" → "magnetic, playful, confident"), never in sexual terms. ' +
  'Never name a real or famous person: turn "looks like X" into general traits (age range, build, skin tone, hair, style, energy). The person must be someone new.';

/**
 * The description a photo is made from: the artist's notes as a professional casting brief that
 * keeps the look (beautiful, curvy, African, confident…) in words image filters accept, with famous
 * names turned into general traits. Falls back to the notes with the trigger words removed.
 */
export async function castingBrief(description: string, lookLike: string | undefined): Promise<string> {
  const text = [description, lookLike ? `Looks a bit like: ${lookLike}` : ''].filter(Boolean).join('\n');
  try {
    const { data } = await parse('music-video', BriefSchema, BRIEF_SYSTEM, [{ type: 'text', text }]);
    return filterSafe(data.look.trim()) || filterSafe(description);
  } catch (error) {
    logger.warn({ err: error }, 'character look: casting brief unavailable; using the notes with trigger words removed');
    return filterSafe(description.replace(/\b(like|resembl\w*|similar to)\b[^;,.]*/gi, ''));
  }
}

const REAL =
  'A real photograph from a real camera: natural light, true colour, real skin with pores, small imperfections and natural asymmetry, accurate hands; ' +
  'no retouching, no beauty filter, no illustration, no text, no watermark. Tasteful and fully clothed.';

/** The image model's safety filter blocked the photo (it came back black and flagged). */
class BlockedImage extends Error {
  constructor() {
    super('blocked by the image safety filter');
  }
}

/** The character in words, from everything the artist filled in. */
export function describeCharacter(character: Pick<CharacterRow, 'name' | 'attributes' | 'costumes'>): string {
  const a = character.attributes;
  const look = character.costumes[0];
  const parts = [
    [a.ageRange ? `${a.ageRange} years old` : '', a.gender ?? ''].filter(Boolean).join(' '),
    a.heightCm ? `about ${a.heightCm} cm tall` : '',
    a.build ? `${a.build} build` : '',
    a.skinTone ? `${a.skinTone} skin` : '',
    a.bald ? 'bald / shaved head' : [a.hairLength, a.hairColor, a.hairStyle].filter(Boolean).join(' ') ? `${[a.hairLength, a.hairColor, a.hairStyle].filter(Boolean).join(' ')} hair` : '',
    a.facialHair ? `facial hair: ${a.facialHair}` : '',
    a.eyes ? `eyes: ${a.eyes}` : '',
    a.marks ? `marks: ${a.marks}` : '',
    a.persona ? `presence: ${a.persona}` : '',
    a.accessories ? `accessories: ${a.accessories}` : '',
    look ? `wearing ${look.description}${look.palette ? ` (${look.palette})` : ''}${look.footwear ? `, ${look.footwear}` : ''}` : '',
    a.notes ? `notes: ${a.notes}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

export async function lookCost(): Promise<number> {
  const { costs } = await getStudioSettings();
  return costs.image + costs.imageEdit + costs.mvCasting;
}

export async function createCharacterLook(auth: AuthContext, workspaceId: string, projectId: string, characterId: string, input: { dryRun: boolean; lookLike?: string | undefined }, ip: string | null) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const character = await loadCharacter(projectId, characterId);
  const written = describeCharacter(character);
  const settings = await getStudioSettings();
  const imageTokens = settings.costs.image + settings.costs.imageEdit;
  const total = imageTokens + settings.costs.mvCasting;
  if (input.dryRun) return { estimate: { tokens: total }, project: null };
  if (written.length < 12 && !input.lookLike?.trim() && !mv.vision.trim()) throw AppError.badRequest(`Describe ${character.name} first (gender, age, build, skin tone, hair, outfit…): the photo is made from it.`);
  if (character.likenessUserId) throw AppError.badRequest(`${character.name} uses a saved likeness ("This is me"): no generated look is needed.`);
  if (!fal.falConfigured() || !settings.models.textToImage.enabled || !settings.models.imageEdit.enabled) {
    throw new AppError(503, 'INTERNAL_ERROR', `Character photos are not switched on yet (the ${ENGINE_NAME} is not connected).`);
  }
  await assertStorage(auth, 6 * 1024 * 1024, 'the character photos');

  // A professional casting brief (keeps the look, drops words image filters block, no famous names).
  const description = await castingBrief(written, input.lookLike?.trim() || undefined);
  const place = placeText(parseDirection(mv.direction), mv.lyrics?.voice ?? null);
  const world = [mv.vision.trim().slice(0, 300), place].filter(Boolean).join(' · ');
  const { reservation } = await reserveTokens(auth, workspaceId, 'MV_CASTING', imageTokens, { projectId, characterId, look: true });
  const dir = await mkdtemp(join(tmpdir(), 'mv-look-'));
  let spent = 0;
  try {
    // A photo the model's safety filter blocked comes back black and flagged: never keep it.
    const run = async (endpoint: string, body: Record<string, unknown>): Promise<string> => {
      const result = await fal.wait<Record<string, unknown>>(await fal.submit(endpoint, body), { timeoutMs: 5 * 60_000 });
      const flags = result['has_nsfw_concepts'];
      if (Array.isArray(flags) && flags.some(Boolean)) throw new BlockedImage();
      return fal.outputUrl(result, 'image');
    };
    // One retry when blocked (or no image came back): same person, more conservative framing and wording.
    const attempt = async (endpoint: string, body: Record<string, unknown>, safer: Record<string, unknown>): Promise<string> => {
      try {
        return await run(endpoint, body);
      } catch (error) {
        if (!(error instanceof BlockedImage) && !(error instanceof fal.FalError && /returned no image/i.test(error.message))) throw error;
        logger.warn({ characterId, endpoint }, 'character look: image blocked or empty; retrying with safer wording');
        try {
          return await run(endpoint, safer);
        } catch (again) {
          if (again instanceof BlockedImage || (again instanceof fal.FalError && /returned no image/i.test(again.message))) {
            throw new AppError(
              422,
              'BAD_REQUEST',
              `The image model's safety filter blocked ${character.name}'s photo. Describe the look in styling terms (figure, outfit, attitude) rather than body-part sizes or "sexy" words, and try again. Nothing was charged for the blocked photo.`,
            );
          }
          throw again;
        }
      }
    };
    const safe = filterSafe(description);
    // 1. The face: a clean, front-facing portrait (the identity reference every shot uses).
    const portrait = (look: string): Record<string, unknown> => ({
      ...settings.models.textToImage.extra,
      prompt:
        `Head-and-shoulders portrait photograph of ${character.name}, a music-video character: ${look || 'an ordinary, believable person'}. ` +
        `Facing the camera, neutral relaxed expression, eyes to the lens, even soft daylight, plain softly blurred background. ${world ? `The video's world: ${filterSafe(world)}. ` : ''}${ORIGINAL} ${REAL}`,
      aspect_ratio: '3:4',
    });
    const faceUrl = await attempt(settings.models.textToImage.endpoint, portrait(description), portrait(`${safe}. Elegant, modest styling; a fashion-magazine casting portrait`));
    spent += settings.costs.image;
    // 2. The full body: the same person (from the portrait), standing, in the first outfit.
    const outfit = character.costumes[0] ? filterSafe(character.costumes[0].description) : '';
    const fullBody = (wearing: string, figure: string): Record<string, unknown> => ({
      ...settings.models.imageEdit.extra,
      prompt:
        `A new full-body photograph of the exact person in the reference image (identical face, skin tone, hair and age), ${figure}, standing naturally, ` +
        `whole body visible head to toe, facing the camera, ${wearing}, plain real-world background, soft daylight. ${REAL}`,
      image_urls: [faceUrl],
    });
    const bodyUrl = await attempt(
      settings.models.imageEdit.endpoint,
      fullBody(outfit ? `wearing ${outfit}` : 'in clothes that suit them', `with the build and figure described here: ${description.slice(0, 400)}`),
      fullBody('in an elegant, well-fitted outfit that suits them', `with the build and figure described here: ${safe.slice(0, 300)}`),
    );
    spent += settings.costs.imageEdit;

    // 3. Both become the character's photos.
    const assetIds: string[] = [];
    for (const [label, url] of [
      ['portrait', faceUrl],
      ['full body', bodyUrl],
    ] as const) {
      const file = join(dir, `${label.replace(' ', '-')}.png`);
      await downloadUrl(url, file);
      const [asset] = await sql<{ id: string }[]>`
        INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta, status)
        VALUES (${projectId}, ${workspaceId}, 'PHOTO', '', ${`${character.name} · ${label} (created).png`.slice(0, 200)}, 'image/png', ${(await stat(file)).size},
          ${json({ subject: true, generated: true, caption: `${character.name}, ${label}, created from the description` })}, 'PENDING') RETURNING id`;
      const key = keys.studioAsset(workspaceId, projectId, asset!.id, `look-${randomUUID().slice(0, 8)}.png`);
      await uploadFile(key, file, 'image/png');
      await sql`UPDATE studio_assets SET key = ${key}, status = 'READY' WHERE id = ${asset!.id}`;
      assetIds.push(asset!.id);
    }
    await sql`
      UPDATE mv_characters SET
        media_asset_ids = media_asset_ids || ${assetIds}::uuid[],
        reference_keys = '{}'::text[], approved_at = NULL,
        consent_at = COALESCE(consent_at, now()), consent_by = COALESCE(consent_by, ${auth.userId}), consent_ip = COALESCE(consent_ip, ${ip}),
        updated_at = now()
      WHERE id = ${characterId}`;
    logger.info({ projectId, characterId, userId: auth.userId }, 'AI-created character look (no real person); permission recorded as AI-created');
    await settleSystem(reservation.id, workspaceId, spent, `Music video · ${project.title.slice(0, 50)}: ${character.name}'s look (created)`);
    if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${spent} WHERE id = ${projectId}`;
  } catch (error) {
    if (spent > 0) await settleSystem(reservation.id, workspaceId, spent, `Music video · ${project.title.slice(0, 50)}: ${character.name}'s look (stopped)`).catch(() => undefined);
    else await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  // 4. The casting sheet from the new photos (charged on its own, like the button).
  await castOne(auth, workspaceId, projectId, characterId).catch((error: unknown) => logger.warn({ err: error, characterId }, 'casting sheet after a created look failed'));
  return { estimate: { tokens: total }, project: await view(auth, workspaceId, projectId) };
}

