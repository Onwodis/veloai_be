/**
 * Variants: the same move performed a different way. Each one changes the
 * performance (not just the name): the cue gains a clause the film engine
 * can act, and the when-to-use data moves with it (tempo, energy, shot, mood,
 * who it suits). A variant only applies where it makes sense (no slow-burn of
 * an already slow move, no close-up of a facial expression, and so on).
 */
import type { Move, MoveCategory, Mood } from '../types.js';

export interface Variant {
  code: string;
  label: string;
  categories: MoveCategory[];
  applies: (move: Move) => boolean;
  clause: string;
  note: string;
  change: (move: Move) => Partial<Move>;
}

const add = <T>(list: T[], ...items: T[]): T[] => [...new Set([...list.filter((item) => item !== ('ANY' as T)), ...items])];
const onlyMoods = (move: Move, moods: Mood[]): boolean => move.moods.every((mood) => moods.includes(mood));

export const VARIANTS: Variant[] = [
  {
    code: 'SB',
    label: 'Slow-Burn',
    categories: ['ENTRANCE', 'WALK', 'HANDS', 'EMOTION', 'DANCE', 'DUET', 'EXIT'],
    applies: (move) => move.tempo !== 'SLOW' && move.energy > 1,
    clause: 'taken at half the speed, every part lingering a beat longer, the breath visible between movements',
    note: 'Slow-burn version for ballads, slow jams and emotional bridges: same intention, half the speed.',
    change: (move) => ({ tempo: 'SLOW', energy: Math.max(1, move.energy - 1), sections: add(move.sections, 'VERSE', 'BRIDGE'), moods: add(move.moods, 'ROMANTIC') }),
  },
  {
    code: 'AR',
    label: 'Arena',
    categories: ['STANCE', 'VOCAL', 'MIC', 'EMOTION', 'CROWD', 'DUET', 'GROUP'],
    applies: (move) => move.energy < 5 && move.shot !== 'CLOSE_UP',
    clause: 'played big for a packed arena: fuller reach, longer holds, the whole body committed',
    note: 'Arena version for anthem choruses and live-show staging: bigger shapes that read from the back row.',
    change: (move) => ({ energy: Math.min(5, move.energy + 1), shot: 'WIDE', sections: add(move.sections, 'CHORUS'), moods: add(move.moods, 'TRIUMPHANT') }),
  },
  {
    code: 'CU',
    label: 'Close-Up',
    categories: ['HANDS', 'EMOTION', 'DUET', 'MIC'],
    applies: (move) => move.shot !== 'CLOSE_UP' && move.energy < 5,
    clause: 'scaled down for a tight close-up: the same intention carried by the eyes, jaw and shoulders, nothing wider than the frame',
    note: 'Close-up version: the move translated to the face and shoulders for tight lip-sync shots.',
    change: (move) => ({ shot: 'CLOSE_UP', energy: Math.max(1, move.energy - 1) }),
  },
  {
    code: 'ST',
    label: 'Street',
    categories: ['WALK', 'DANCE', 'FOOTWORK', 'PROP'],
    // Not on moves that are street already (it would only repeat them) or on sacred / tender ones.
    applies: (move) =>
      !onlyMoods(move, ['SAD', 'SPIRITUAL', 'ROMANTIC', 'CALM']) && !move.genres.some((genre) => ['gospel', 'afrobeats', 'amapiano', 'hiphop', 'dancehall', 'drill', 'trap'].includes(genre)),
    clause: 'loose and unbothered, with a street-level bounce in the knees and a half-smile, as if nobody is watching',
    note: 'Street version for Afrobeats, Amapiano and hip-hop: looser, cooler, behind the beat.',
    change: (move) => ({ genres: add(move.genres, 'afrobeats', 'amapiano', 'hiphop'), moods: add(move.moods, 'CONFIDENT', 'PLAYFUL') }),
  },
  {
    code: 'SL',
    label: 'Soulful',
    categories: ['FACE', 'VOCAL', 'HANDS', 'EMOTION'],
    applies: (move) => !onlyMoods(move, ['PLAYFUL', 'DEFIANT']),
    clause: 'with church in it: the eyes closing, a slow head roll, the feeling arriving just before the gesture',
    note: 'Soulful version for gospel, soul and R&B: the emotion leads, the gesture follows.',
    change: (move) => ({ moods: add(move.moods, 'SPIRITUAL'), genres: add(move.genres, 'gospel', 'soul', 'rnb') }),
  },
  {
    code: 'DV',
    label: 'Diva',
    categories: ['ENTRANCE', 'WALK', 'STANCE', 'MIC', 'PROP'],
    applies: (move) => move.gender !== 'MALE',
    clause: 'with diva poise: chin lifted, shoulders back, long fluid lines finishing in the fingertips',
    note: 'Diva version for female leads: poise, length of line, total control.',
    change: () => ({ gender: 'FEMALE', signature: true }),
  },
  {
    code: 'DN',
    label: 'Don',
    categories: ['ENTRANCE', 'WALK', 'STANCE', 'MIC', 'PROP'],
    applies: (move) => move.gender !== 'FEMALE',
    clause: 'with quiet heavyweight cool: grounded, economical, the power held back rather than shown',
    note: 'Don version for male leads: weight, economy, nothing wasted.',
    change: () => ({ gender: 'MALE', signature: true }),
  },
  // Commercials
  {
    code: 'HY',
    label: 'High-Energy',
    categories: ['PRESENTER', 'REACTION', 'CALL_TO_ACTION', 'LIFESTYLE'],
    applies: (move) => move.energy < 4,
    clause: 'with bright, quick energy and a big genuine smile, built for the first second of a scroll',
    note: 'High-energy version for social feeds and youth brands.',
    change: (move) => ({ energy: Math.min(5, move.energy + 2), tempo: 'FAST', moods: add(move.moods, 'HAPPY', 'PLAYFUL') }),
  },
  {
    code: 'WM',
    label: 'Warm & Intimate',
    categories: ['PRESENTER', 'TESTIMONIAL', 'CALL_TO_ACTION', 'PRODUCT'],
    applies: (move) => move.energy > 1 || move.category === 'PRODUCT',
    clause: 'softly and close, as if talking to one friend at a kitchen table, unhurried',
    note: 'Warm version for trust-led brands: health, finance, family, premium.',
    change: (move) => ({ energy: Math.max(1, move.energy - 1), tempo: 'SLOW', moods: add(move.moods, 'CALM') }),
  },
  {
    code: 'MC',
    label: 'Macro Slow-Motion',
    categories: ['PRODUCT', 'LIFESTYLE'],
    applies: (move) => move.category === 'PRODUCT' || move.energy <= 2,
    clause: 'in extreme close-up slow motion, textures and droplets catching the light',
    note: 'Macro version for premium packshots and food, drink and beauty textures.',
    change: () => ({ shot: 'CLOSE_UP', tempo: 'SLOW' }),
  },
];
