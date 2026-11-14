/** Request schemas for moves, custom moves and scene moves. */
import { z } from 'zod';
import { GENDERS, MOODS, MOVE_CATEGORIES, MOVE_DOMAINS, SHOTS, SONG_SECTIONS, TEMPOS } from './types.js';

export const MAX_CUSTOM_MOVES = 100;
export const MOVE_ID = /^CM-[A-HJ-NP-Z2-9]{8}$/;

const text = (max: number) => z.string().trim().max(max);
const word = z.string().trim().min(1).max(30);

export const libraryQuery = z.strictObject({
  domain: z.enum(MOVE_DOMAINS).optional(),
  category: z.enum(MOVE_CATEGORIES).optional(),
  section: z.enum(SONG_SECTIONS).optional(),
  mood: z.enum(MOODS).optional(),
  tempo: z.enum(TEMPOS).optional(),
  gender: z.enum(GENDERS).optional(),
  energy: z.coerce.number().int().min(1).max(5).optional(),
  signature: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  baseOnly: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  favourites: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  q: text(80).optional(),
  sort: z.enum(['category', 'name', 'energy']).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(6).max(48).default(24),
});

export const templateQuery = z.strictObject({
  domain: z.enum(MOVE_DOMAINS).optional(),
  kind: z.enum(['INTRO', 'SCENE', 'OUTRO']).optional(),
  q: text(80).optional(),
});

/** A move the user writes (or remixes from the library). The cue is what the person does, starting with a verb. */
export const customMoveSchema = z.strictObject({
  domain: z.enum(MOVE_DOMAINS),
  category: z.enum(MOVE_CATEGORIES),
  name: text(80).min(2),
  cue: text(420).min(12),
  detail: text(2000).optional(),
  sections: z.array(z.enum(SONG_SECTIONS)).min(1).max(8),
  moods: z.array(z.enum(MOODS)).min(1).max(6),
  tempo: z.enum(TEMPOS),
  energy: z.number().int().min(1).max(5),
  gender: z.enum(GENDERS),
  genres: z.array(word).max(6).default([]),
  shot: z.enum(SHOTS),
  props: z.array(word).max(6).default([]),
  tags: z.array(word).max(8).default([]),
  basedOn: z.string().regex(/^(MV|AD)-[A-Z]{3}-\d{3}(-[A-Z]{2})?$/).optional(),
});
export type CustomMoveInput = z.infer<typeof customMoveSchema>;

export const importSchema = z.strictObject({
  moveId: z.string().trim().toUpperCase().regex(MOVE_ID, 'Move ids look like CM-7K2Q9XHD.'),
  key: z.string().trim().min(16).max(32),
});

/** A library id (MV-MIC-001, MV-MIC-001-SB) or a custom move id (CM-…). */
export const moveRef = z.string().trim().regex(/^((MV|AD)-[A-Z]{3}-\d{3}(-[A-Z]{2})?|CM-[A-HJ-NP-Z2-9]{8})$/);

export const addSceneMoveSchema = z.strictObject({
  ref: moveRef,
  /** Music videos: the character (must be in the scene). */
  characterId: z.uuid().optional(),
  /** Ads: the cast member's name (must be in the cast or speak in the scene). */
  characterName: text(60).min(1).optional(),
});

export const applyTemplateSchema = z.strictObject({
  templateId: z.string().regex(/^TP-[A-Z]{2}-\d{3}$/),
  mode: z.enum(['replace', 'append']).default('append'),
});
