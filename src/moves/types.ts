/**
 * Performance moves: what a person on screen does (an entrance, a walk, a
 * mic grab, a look, a dance step, a product reveal) and when it works.
 *
 *   Library moves   ~1000 professional moves shipped with the app in a local
 *                   file (be/data/moves/library.json, built from catalog/),
 *                   read-only, ids like MV-MIC-012 or MV-MIC-012-SB
 *   Custom moves    the user's own (or copied with a move id + key), in the
 *                   database, ids like CM-7K2Q9XHD, at most 100 per user
 *
 * A move is never pasted into a prompt as-is: its `cue` (one short, natural
 * sentence written for the film engine) is woven into the scene's
 * performance direction with a "human, unforced" frame (see prompt.ts).
 */

export const MOVE_DOMAINS = ['MUSIC', 'AD'] as const;
export type MoveDomain = (typeof MOVE_DOMAINS)[number];

export const MOVE_CATEGORIES = [
  // Music
  'ENTRANCE',
  'WALK',
  'STANCE',
  'HANDS',
  'FACE',
  'VOCAL',
  'MIC',
  'EMOTION',
  'CROWD',
  'DANCE',
  'FOOTWORK',
  'PROP',
  'DUET',
  'GROUP',
  'STUNT',
  'EXIT',
  // Ads
  'PRESENTER',
  'PRODUCT',
  'REACTION',
  'TESTIMONIAL',
  'LIFESTYLE',
  'CALL_TO_ACTION',
] as const;
export type MoveCategory = (typeof MOVE_CATEGORIES)[number];

export const CATEGORY_INFO: Record<MoveCategory, { label: string; domain: MoveDomain; blurb: string }> = {
  ENTRANCE: { label: 'Entrances', domain: 'MUSIC', blurb: 'How the star arrives: the first seconds of the song or the scene.' },
  WALK: { label: 'Walk patterns', domain: 'MUSIC', blurb: 'Signature walks: pace, weight, swagger, purpose.' },
  STANCE: { label: 'Stances & poses', domain: 'MUSIC', blurb: 'Power positions held between phrases and on big notes.' },
  HANDS: { label: 'Hand gestures', domain: 'MUSIC', blurb: 'What the free hand says while the voice sings.' },
  FACE: { label: 'Facial expressions', domain: 'MUSIC', blurb: 'Looks, eyes and micro-expressions for close-ups.' },
  VOCAL: { label: 'Lip & vocal delivery', domain: 'MUSIC', blurb: 'How the mouth and breath carry the line (lip-synced shots).' },
  MIC: { label: 'Mic technique', domain: 'MUSIC', blurb: 'Grabs, holds, stand work and the mic as a character.' },
  EMOTION: { label: 'Emotional responses', domain: 'MUSIC', blurb: 'Being moved by the song: tears, joy, release, defiance.' },
  CROWD: { label: 'Camera & crowd connection', domain: 'MUSIC', blurb: 'Playing to the lens or the room.' },
  DANCE: { label: 'Dance', domain: 'MUSIC', blurb: 'Grooves and choreography across Afro, urban, pop and classic styles.' },
  FOOTWORK: { label: 'Footwork', domain: 'MUSIC', blurb: 'Steps, slides, spins and legwork.' },
  PROP: { label: 'Props & wardrobe play', domain: 'MUSIC', blurb: 'Jackets, shades, hats, chairs, scarves, canes.' },
  DUET: { label: 'Duet & chemistry', domain: 'MUSIC', blurb: 'Two people: tension, harmony, call and response.' },
  GROUP: { label: 'Group & crew', domain: 'MUSIC', blurb: 'The crew, the band, the dancers around the lead.' },
  STUNT: { label: 'Stunts & big moments', domain: 'MUSIC', blurb: 'Showstoppers. Always performed safely and shot to look bigger.' },
  EXIT: { label: 'Exits & endings', domain: 'MUSIC', blurb: 'How the star leaves the song: last note, last look.' },
  PRESENTER: { label: 'Presenter', domain: 'AD', blurb: 'Talking to camera with trust and energy.' },
  PRODUCT: { label: 'Product handling', domain: 'AD', blurb: 'Hero reveals, demos and the hand that sells.' },
  REACTION: { label: 'Reactions', domain: 'AD', blurb: 'The honest first-try moment.' },
  TESTIMONIAL: { label: 'Testimonial', domain: 'AD', blurb: 'Real people, real stories, believable delivery.' },
  LIFESTYLE: { label: 'Lifestyle', domain: 'AD', blurb: 'The product living in a real day.' },
  CALL_TO_ACTION: { label: 'Call to action', domain: 'AD', blurb: 'The closing beat that makes people act.' },
};

export const SONG_SECTIONS = ['INTRO', 'VERSE', 'PRE_CHORUS', 'CHORUS', 'BRIDGE', 'DROP', 'BREAKDOWN', 'INSTRUMENTAL', 'AD_LIB', 'OUTRO', 'ANY'] as const;
export type SongSection = (typeof SONG_SECTIONS)[number];

export const MOODS = ['HAPPY', 'ROMANTIC', 'SENSUAL', 'SAD', 'DEFIANT', 'CONFIDENT', 'SPIRITUAL', 'PLAYFUL', 'NOSTALGIC', 'TRIUMPHANT', 'MYSTERIOUS', 'CALM', 'ANY'] as const;
export type Mood = (typeof MOODS)[number];

export const TEMPOS = ['SLOW', 'MID', 'FAST', 'ANY'] as const;
export type Tempo = (typeof TEMPOS)[number];

export const GENDERS = ['ANY', 'FEMALE', 'MALE'] as const;
export type MoveGender = (typeof GENDERS)[number];

export const SHOTS = ['CLOSE_UP', 'MEDIUM', 'WIDE', 'TRACKING', 'LOW_ANGLE', 'OVERHEAD'] as const;
export type MoveShot = (typeof SHOTS)[number];

export interface Move {
  id: string;
  name: string;
  domain: MoveDomain;
  category: MoveCategory;
  /** One natural sentence for the film engine (woven into the scene prompt). */
  cue: string;
  /** For people: what it is, how to make it land, what to avoid. */
  detail: string;
  sections: SongSection[];
  moods: Mood[];
  tempo: Tempo;
  /** 1 = still and subtle … 5 = all-out. */
  energy: number;
  gender: MoveGender;
  genres: string[];
  shot: MoveShot;
  /** 1 = anyone, 2 = rehearsed, 3 = trained performer / stunt (performed safely). */
  difficulty: number;
  props: string[];
  /** A star's trademark: the moves people remember. */
  signature: boolean;
  tags: string[];
  /** Variants: the base move id. */
  baseId?: string;
}

/** Scene templates: how a whole scene / intro / outro is staged (camera, light, action). */
export interface SceneTemplate {
  id: string;
  name: string;
  domain: MoveDomain;
  kind: 'INTRO' | 'SCENE' | 'OUTRO';
  /** The staging, written like a director's note (becomes the scene description). */
  direction: string;
  camera: string;
  light: string;
  seconds: number;
  moods: Mood[];
  whenToUse: string;
  tags: string[];
}

/** A move placed on a character in a scene (studio_scenes.moves, a frozen copy). */
export interface SceneMove {
  /** This placement (remove by it). */
  id: string;
  ref: string;
  name: string;
  cue: string;
  category: MoveCategory;
  characterId: string | null;
  characterName: string;
  source: 'LIBRARY' | 'CUSTOM';
  /** Copied custom moves: the original creator (credited wherever the move is used). */
  creditTo?: string | null;
  addedAt: string;
}
