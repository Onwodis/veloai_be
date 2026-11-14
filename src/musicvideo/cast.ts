/**
 * Who is in a scene, as the image/video models need it: reference images
 * (photos + frames from the character's videos, lead first) and one written
 * description per character with the costume they wear in that scene.
 * Used by studio/service.ts → generate() for MUSIC_VIDEO projects.
 */
import { sql } from '../studio/sql.js';
import type { SceneRow } from '../studio/types.js';

export interface CharacterAttributes {
  gender?: string;
  ageRange?: string;
  heightCm?: number;
  build?: string;
  skinTone?: string;
  hairStyle?: string;
  hairColor?: string;
  hairLength?: string;
  bald?: boolean;
  facialHair?: string;
  eyes?: string;
  marks?: string;
  /** 0-5: how glamorous / alluring the styling is (always tasteful, never explicit). */
  glamLevel?: number;
  persona?: string;
  signatureMoves?: string;
  accessories?: string;
  notes?: string;
}

export interface Costume {
  id: string;
  name: string;
  description: string;
  palette?: string;
  accessories?: string;
  footwear?: string;
}

export interface CharacterRow {
  id: string;
  projectId: string;
  position: number;
  role: 'LEAD' | 'CO_LEAD' | 'SECOND_LEAD' | 'VIXEN' | 'SUPPORTING' | 'DANCER' | 'EXTRA';
  name: string;
  isArtist: boolean;
  attributes: CharacterAttributes;
  costumes: Costume[];
  mediaAssetIds: string[];
  referenceKeys: string[];
  profile: string | null;
  prompt: string | null;
  /** How they sing / express themselves, studied from their videos (mig 019). */
  performance?: string | null;
  /** Peak-expression stills from their videos (never identity references). */
  expressionKeys?: string[];
  castEngine: string | null;
  consentAt: Date | null;
  consentBy: string | null;
  consentIp: string | null;
  approvedAt: Date | null;
  /** This character is that user: their saved likeness drives the shots. */
  likenessUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SceneCast {
  referenceKeys: string[];
  /** Per-character photos in cast order (identity reference elements for the video model). */
  elements: { name: string; keys: string[] }[];
  profile: string;
  style?: string | undefined;
}

export const ROLE_LABEL: Record<CharacterRow['role'], string> = {
  LEAD: 'lead artist',
  CO_LEAD: 'co-lead artist',
  SECOND_LEAD: 'second lead',
  VIXEN: 'video vixen',
  SUPPORTING: 'supporting role',
  DANCER: 'dancer',
  EXTRA: 'extra',
};

/** The model accepts up to 5 reference images per keyframe; share them across the cast. */
const MAX_REFERENCES = 5;

export async function sceneCasts(projectId: string, scenes: Pick<SceneRow, 'id' | 'characterIds' | 'costume'>[]): Promise<Map<string, SceneCast>> {
  const out = new Map<string, SceneCast>();
  const wanted = scenes.filter((scene) => (scene.characterIds ?? []).length > 0);
  if (wanted.length === 0) return out;
  const characters = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId}`;
  const byId = new Map(characters.map((character) => [character.id, character]));
  // Continuity anchors: the first frame of each character's earliest approved solo shot, per wardrobe.
  // A later scene in the same wardrobe gets it as an extra reference, so the face, hair and build stay
  // exactly as the artist approved them (photos alone let small things drift from shot to shot).
  const approved = await sql<{ sceneId: string; position: number; characterIds: string[]; costume: string | null; keyframeKey: string }[]>`
    SELECT s.id AS scene_id, s.position, s.character_ids, s.costume, t.keyframe_key FROM studio_scenes s
    JOIN studio_takes t ON t.id = s.selected_take_id AND t.status = 'READY' AND t.keyframe_key IS NOT NULL
    WHERE s.project_id = ${projectId} AND s.shot_approved_at IS NOT NULL AND cardinality(s.character_ids) = 1
    ORDER BY s.position`;
  const wardrobe = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();
  const anchorFor = (characterId: string, sceneId: string, costume: string | null | undefined): string | null =>
    approved.find((row) => row.characterIds[0] === characterId && row.sceneId !== sceneId && wardrobe(row.costume) === wardrobe(costume))?.keyframeKey ?? null;

  for (const scene of wanted) {
    const cast = scene.characterIds.map((id) => byId.get(id)).filter((item): item is CharacterRow => Boolean(item));
    if (cast.length === 0) continue;
    const perCharacter = Math.max(1, Math.floor(MAX_REFERENCES / cast.length));
    const anchors = cast.length === 1 ? [anchorFor(cast[0]!.id, scene.id, scene.costume)].filter((key): key is string => Boolean(key)) : [];
    // Photos first (identity), the continuity still last (it replaces the 5th photo when all slots are taken).
    const photos = cast.flatMap((character) => character.referenceKeys.slice(0, perCharacter));
    const referenceKeys = [...photos.slice(0, MAX_REFERENCES - anchors.length), ...anchors].slice(0, MAX_REFERENCES);
    const profile = cast
      .map((character, index) => {
        const description = character.prompt || character.profile || '';
        // Their own way of singing, studied from their videos: the face moves like THEM, not a generic singer.
        const performance = character.performance ? ` When singing, as seen in their own videos: ${character.performance.slice(0, 600)}` : '';
        return `Person ${index + 1}, ${character.name} (${ROLE_LABEL[character.role]}${character.isArtist ? ', the artist' : ''}): ${description}${performance}`;
      })
      .concat(scene.costume ? [`Wardrobe in this scene: ${scene.costume}`] : [])
      .concat(['Faces must match the reference photos exactly (same face shape, features, skin, marks, hairline); do not beautify or idealise.'])
      .concat([
        'The same person in every scene of this video: age, skin tone, hair length, colour and style, facial hair, height and body build never change between shots; only the wardrobe the scene asks for changes.',
      ])
      .concat(anchors.length ? ['The last reference is a frame from an earlier approved scene of this video: match that face, hair and build exactly.'] : [])
      .concat(cast.length > 1 ? ['Reference photos are given in the same order as the people above; keep every person distinct and recognisable.'] : [])
      .join('\n');
    const elements = cast.filter((character) => character.referenceKeys.length > 0).map((character) => ({ name: character.name, keys: character.referenceKeys.slice(0, 4) }));
    out.set(scene.id, { referenceKeys, elements, profile });
  }
  return out;
}
