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
import type { CharacterRow } from './cast.js';
import { access, assertStage, castOne, load, loadCharacter, view } from './service.js';
import { parseDirection, placeText } from './songmap.js';

const REAL =
  'A real photograph from a real camera: natural light, true colour, real skin with pores, small imperfections and natural asymmetry, accurate hands; ' +
  'no retouching, no beauty filter, no illustration, no text, no watermark. Tasteful and fully clothed.';

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

export async function createCharacterLook(auth: AuthContext, workspaceId: string, projectId: string, characterId: string, input: { dryRun: boolean }, ip: string | null) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  assertStage(mv, 'CHARACTERS');
  const character = await loadCharacter(projectId, characterId);
  const description = describeCharacter(character);
  const settings = await getStudioSettings();
  const imageTokens = settings.costs.image + settings.costs.imageEdit;
  const total = imageTokens + settings.costs.mvCasting;
  if (input.dryRun) return { estimate: { tokens: total }, project: null };
  if (description.length < 12 && !mv.vision.trim()) throw AppError.badRequest(`Describe ${character.name} first (gender, age, build, skin tone, hair, outfit…): the photo is made from it.`);
  if (character.likenessUserId) throw AppError.badRequest(`${character.name} uses a saved likeness ("This is me"): no generated look is needed.`);
  if (!fal.falConfigured() || !settings.models.textToImage.enabled || !settings.models.imageEdit.enabled) {
    throw new AppError(503, 'INTERNAL_ERROR', `Character photos are not switched on yet (the ${ENGINE_NAME} is not connected).`);
  }
  await assertStorage(auth, 6 * 1024 * 1024, 'the character photos');

  const place = placeText(parseDirection(mv.direction), mv.lyrics?.voice ?? null);
  const world = [mv.vision.trim().slice(0, 300), place].filter(Boolean).join(' · ');
  const { reservation } = await reserveTokens(auth, workspaceId, 'MV_CASTING', imageTokens, { projectId, characterId, look: true });
  const dir = await mkdtemp(join(tmpdir(), 'mv-look-'));
  let spent = 0;
  try {
    const run = async (endpoint: string, body: Record<string, unknown>): Promise<string> => fal.outputUrl(await fal.wait(await fal.submit(endpoint, body), { timeoutMs: 5 * 60_000 }), 'image');
    // 1. The face: a clean, front-facing portrait (the identity reference every shot uses).
    const faceUrl = await run(settings.models.textToImage.endpoint, {
      ...settings.models.textToImage.extra,
      prompt:
        `Head-and-shoulders portrait photograph of ${character.name}, a music-video character: ${description || 'an ordinary, believable person'}. ` +
        `Facing the camera, neutral relaxed expression, eyes to the lens, even soft daylight, plain softly blurred background. ${world ? `The video's world: ${world}. ` : ''}${REAL}`,
      aspect_ratio: '3:4',
    });
    spent += settings.costs.image;
    // 2. The full body: the same person (from the portrait), standing, in the first outfit.
    const bodyUrl = await run(settings.models.imageEdit.endpoint, {
      ...settings.models.imageEdit.extra,
      prompt:
        `A new full-body photograph of the exact person in the reference image (identical face, skin tone, hair, age and build), standing naturally, ` +
        `whole body visible head to toe, facing the camera, ${character.costumes[0] ? `wearing ${character.costumes[0].description}` : 'in everyday clothes that suit them'}, ` +
        `plain real-world background, soft daylight. ${REAL}`,
      image_urls: [faceUrl],
    });
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

