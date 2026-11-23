/**
 * The music-video director (Claude). Four jobs:
 *
 *   castCharacter   photos + video frames + the artist's notes → a casting
 *                   sheet and the prompt fragment used in every shot
 *   expandScene     one scene idea → a shootable, approved-ready plan
 *   discuss         the director's room: argues, cites real music videos,
 *                   proposes concrete scene changes; the artist decides
 *   storyboard      the final timeline: intro → story scenes → outro, timed
 *                   to the song and its lyrics
 *
 * Everything the artist typed is data inside tags. Styling is always tasteful:
 * "glam level" means fashion and confidence, never explicit content.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import { PERFORMANCE_EMOTION_IDS, PERFORMANCE_EMOTIONS, SHOT_IDS, SHOTS, TRANSITION_IDS, VISUAL_STYLES, type VisualStyle } from '../studio/cinema.js';
import { parse, photoBlock } from '../studio/director.js';
import { ROLE_LABEL, type CharacterRow } from './cast.js';
import { PRO_RULES } from './songmap.js';
import { TITLE_STYLES, type Titles } from './titles.js';

const RULES =
  'Never identify real people from their photos and never speculate about sensitive traits. ' +
  'Styling can be glamorous, sensual in attitude and confident, but never sexually explicit, never nude, never suggestive of minors. ' +
  'Video models need one clear action per shot, grounded locations, motivated light and believable wardrobe. ' +
  'The picture is real life, never "AI cinematic": available light from real sources, natural colour, no glowing haze, lens-flare showers or neon overload unless the artist asks; ' +
  'how hard the camera works follows <camera_energy>. People look like real people: natural styling by default, real skin with pores and small imperfections, lived-in clothes. ' +
  'On lip-synced shots keep head and body turns small and the face large, steady and readable (the mouth must be clear for the whole shot).';

/** Camera direction per energy level (the project's setting; studio/cinema.ts CAMERA_ENERGY renders it). */
const CAMERA_DIRECTION: Record<'natural' | 'bold' | 'wild', string> = {
  natural: 'natural: restrained, real-life camera work (tripod, handheld, slow steadicam, gentle push-ins); no whip pans, crash zooms or Dutch angles.',
  bold:
    'bold: every shot has a motivated camera move that lands on the beat (push-in, orbit-360, tracking, crane, push-through), striking angles on the big moments (low-angle, worms-eye, dutch-angle, overhead-spin, dolly-zoom), ' +
    'strong compositions with foreground layers; an occasional FPV or whip-pan for a drop or a turn.',
  wild:
    'wild: full music-video energy: kinetic shots everywhere they fit (fpv-dive, fpv-flythrough, orbit-360, whip-pan, crash-zoom, snorricam, speed-ramp, dutch-angle, worms-eye, overhead-spin), ' +
    'the camera dancing with the artist on every beat; still real places, real light, real people.',
};

/** What makes a video grab and hold attention: the hook and the rhythm of the cuts. */
const ATTENTION =
  '<hook_and_rhythm>The FIRST scene is the hook: it must stop a viewer scrolling within one second: motion from the first frame, the most striking image of the video (a bold angle, an unexpected action, ' +
  'the artist’s eyes straight to the lens, the song’s strongest moment pulled forward if the story allows), never a slow establishing beat. After it, a pattern interrupt on every cut: change the shot size, ' +
  'the angle or the camera move from one scene to the next (never two similar shots in a row), the biggest moves on the drops and chorus hits, quieter framing for intimate lines. ' +
  'Lip-synced performance shots stay face-safe (close-up, medium, low-angle, dutch-angle, snorricam or a slow push); give the kinetic moves to story, dance and B-roll shots.</hook_and_rhythm>';

/* ------------------------------------------------------------------ context */

export interface DirectorContext {
  title: string;
  /** Artist or band name. */
  artist: string;
  genre: string;
  vision: string;
  mood: string;
  leadAct: string;
  aspect: string;
  songSeconds: number | null;
  lyrics: string | null;
  /** Bold, sharp camera work wanted. */
  creativeMode?: boolean;
  /** How hard the camera works: natural / bold / wild. */
  cameraEnergy?: 'natural' | 'bold' | 'wild';
  /** The look: real people (live action) or an animated style. */
  visualStyle?: VisualStyle;
  characters: Pick<CharacterRow, 'id' | 'name' | 'role' | 'isArtist' | 'profile' | 'prompt' | 'costumes'>[];
  scenes: { id: string; kind: string; description: string; prompt: string | null; durationSec: number; characterIds: string[]; location: string | null; costume: string | null; mode?: string | null; lyric?: string | null }[];
  /** Sections, words per section, bar length and the artist's direction settings (songmap.ts). */
  songMap?: string;
  /** Opening titles as they stand (null = none yet). */
  titles?: Titles | null;
  /** Cast background + shoot location (the artist's, or the song's regional cue). */
  place?: string;
}

export function contextText(context: DirectorContext): string {
  const cast = context.characters
    .map(
      (character, index) =>
        `C${index} ${character.name} — ${ROLE_LABEL[character.role]}${character.isArtist ? ' (the artist)' : ''}: ${(character.prompt || character.profile || 'not cast yet').slice(0, 500)}` +
        (character.costumes.length
          ? `\n   costumes: ${character.costumes
              .map((costume) => `${costume.name}: ${costume.description}`)
              .join(' | ')
              .slice(0, 500)}`
          : ''),
    )
    .join('\n');
  const scenes = context.scenes
    .map(
      (scene, index) =>
        `S${index} [${scene.kind}${scene.mode ? ` · ${scene.mode}` : ''}] ${scene.durationSec}s — ${scene.description}${scene.location ? ` @ ${scene.location}` : ''}${scene.characterIds.length ? ` (cast: ${scene.characterIds.map((id) => context.characters.find((character) => character.id === id)?.name ?? '?').join(', ')})` : ''}${scene.lyric ? `\n   under: "${scene.lyric.slice(0, 160)}"` : ''}`,
    )
    .join('\n');
  return [
    `<song title="${context.title}" artist="${context.artist}" genre="${context.genre}" length="${context.songSeconds ? `${Math.round(context.songSeconds)} s` : 'unknown'}" lead_act="${context.leadAct}" aspect="${context.aspect}">`,
    `<vision>${context.vision}</vision>`,
    context.mood ? `<mood>${context.mood}</mood>` : '',
    '<craft>Aim for a real, well-made music video shot on location by a good crew: the artist performing naturally and with conviction, body riding the groove so head nods, shoulder bounces, steps and gestures land on the beat, ' +
      'performance shots in close-up or medium close-up, face toward the lens, mouth unobstructed, the artist singing with the feeling on the whole face (brows, forehead and eye creases, cheeks), never a still, blank face; the exact mouth shapes come from lip sync afterwards, ' +
      'light from real sources, real places with real texture, story intercut with performance. Human and believable in the picture, as daring in the camera as <camera_energy> allows.</craft>',
    `<camera_energy>${CAMERA_DIRECTION[context.cameraEnergy ?? (context.creativeMode ? 'wild' : 'bold')]}</camera_energy>`,
    context.visualStyle && context.visualStyle !== 'human'
      ? `<visual_style>${VISUAL_STYLES[context.visualStyle].label}: ${VISUAL_STYLES[context.visualStyle].look} The whole video is animated in this one style: write every prompt for it (the live-action rules about real skin, pores, grain and available light don't apply); keep believable acting, real-world weight and the cast recognisable as characters.</visual_style>`
      : '',
    ATTENTION,
    context.place
      ? `<cast_and_place>${context.place}. Every scene is set here and its supporting cast, extras and crowd follow this mix; characters cast from photos keep their own looks. Write locations, extras and wardrobe that are true to this place.</cast_and_place>`
      : '',
    context.songMap ? context.songMap.slice(0, 9000) : context.lyrics ? `<lyrics>\n${context.lyrics.slice(0, 6000)}\n</lyrics>` : '<lyrics>not transcribed</lyrics>',
    `</song>`,
    context.titles?.enabled
      ? `<opening_titles>${JSON.stringify({ presenter: context.titles.presenter, label: context.titles.label, artist: context.titles.artist, song: context.titles.song, featuring: context.titles.featuring, prologue: context.titles.prologue.map((card) => card.text), style: context.titles.style, placement: context.titles.placement })}</opening_titles>`
      : '<opening_titles>none yet</opening_titles>',
    `<cast>\n${cast || 'no characters yet'}\n</cast>`,
    `<scenes>\n${scenes || 'no scenes yet'}\n</scenes>`,
  ]
    .filter(Boolean)
    .join('\n');
}

const idsFor = (indexes: number[], context: DirectorContext): string[] => [...new Set(indexes)].flatMap((index) => (context.characters[index] ? [context.characters[index]!.id] : []));

/* ------------------------------------------------------------------ casting */

const CastSchema = z.object({
  profile: z
    .string()
    .describe(
      'Casting sheet: face, skeletal frame, build, proportions, height impression, skin tone, hair (or baldness), facial hair, marks/tattoos, posture, movement/gait if video frames show it, and the styling direction. 120-220 words.',
    ),
  prompt: z
    .string()
    .describe(
      'A compact 40-80 word description an image model can follow to render this exact person in any scene, including their default styling (natural unless the artist set a higher glam level) ' +
        'and their real, specific imperfections (moles, marks, uneven skin tone, asymmetry, gap teeth, scars). No names, no flattering adjectives.',
    ),
  bestReferences: z
    .array(z.number().int())
    .describe(
      'Indexes of up to 4 IDENTITY images, best first: only images labelled "photo" or "saved likeness photo" when any exist (video frames only when there are no photos). ' +
        'Prefer the most natural, unfiltered, least edited or retouched images (no beauty filter, no heavy makeup retouch, no face-smoothing, no stylised grading) ' +
        'that show the face sharp and front-on, then the full body; a plain natural photo beats a polished edited one.',
    ),
  performance: z
    .string()
    .describe(
      'From the "performance video" frames ONLY (empty string when there are none): how this person physically performs while singing, as a director would brief an actor. ' +
        'Cover: how wide the jaw and mouth open on stressed words and long vowels, lip shapes (spread on "ee", rounded on "oo", lips pressed on p/b/m), teeth showing or not; ' +
        'brows (raise, knit), forehead lines, eye creases, eyes closing on held notes; head tilts, nods, chin lifts, shoulder movement; hand gestures; signature expressions; ' +
        'how intensity builds from verse to chorus. Concrete and observable, 80-160 words, no flattery.',
    ),
  expressionFrames: z
    .array(z.number().int())
    .describe('Indexes of up to 4 "performance video" frames showing their most characteristic singing expressions (mouth open mid-word, peak emotion); empty when there are none.'),
  notes: z.string().describe('Advice if references are weak (e.g. "add a full-body photo", "add a walking video"), else empty'),
});
export type CastResult = z.infer<typeof CastSchema> & { engine: string };

export async function castCharacter(
  character: Pick<CharacterRow, 'name' | 'role' | 'isArtist' | 'attributes' | 'costumes'>,
  images: { key: string; label: string }[],
  vision: string,
): Promise<CastResult> {
  const chosen = images.slice(0, 16);
  const blocks = await Promise.all(chosen.map((image) => photoBlock(image.key)));
  const content: Anthropic.Beta.BetaContentBlockParam[] = blocks.flatMap((block, index) => [{ type: 'text' as const, text: `Image ${index} (${chosen[index]!.label}):` }, block]);
  content.push({
    type: 'text',
    text: [
      `Character: ${character.name}, ${ROLE_LABEL[character.role]}${character.isArtist ? ' (the artist)' : ''}.`,
      `<artist_notes>${JSON.stringify(character.attributes)}</artist_notes>`,
      character.costumes.length ? `<costumes>${character.costumes.map((costume) => `${costume.name}: ${costume.description}`).join(' | ')}</costumes>` : '',
      `<video_vision>${vision.slice(0, 1500)}</video_vision>`,
      chosen.length
        ? 'Build the casting sheet from the images; where the artist states a fact (height, baldness, build), it wins. When images disagree (filters, retouching, heavy edits), ' +
          'describe the person as they look in the most natural, least edited image. Record real imperfections faithfully: they are what make the person recognisable and real. ' +
          'The PHOTOS define who the person is (face, features, proportions): every shot must match them. The "performance video" frames are a sequence from the artist singing: ' +
          'study them for HOW the face and body move and express emotion (performance sheet), and only use them for identity when there are no photos.'
        : 'No images: build the sheet from the artist notes alone.',
      `Glam level ${character.attributes.glamLevel ?? 0} of 5 (0 = natural, everyday, the default).`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const { data, engine } = await parse(
    'music-video',
    CastSchema,
    `You are a music-video casting director writing precise character sheets so image and video models portray each person faithfully and consistently across every shot. ${RULES}`,
    content,
  );
  const isPhoto = (index: number): boolean => /photo/i.test(chosen[index]?.label ?? '');
  const hasPhotos = chosen.some((_, index) => isPhoto(index));
  const valid = (index: number): boolean => index >= 0 && index < chosen.length;
  return {
    ...data,
    // Identity comes from photos whenever there are any (video frames are blurry, mid-word, odd angles).
    bestReferences: data.bestReferences.filter((index) => valid(index) && (!hasPhotos || isPhoto(index))).slice(0, 4),
    expressionFrames: data.expressionFrames.filter((index) => valid(index) && !isPhoto(index)).slice(0, 4),
    performance: chosen.some((image) => image.label.startsWith('performance video')) ? data.performance : '',
    engine,
  };
}

/* ------------------------------------------------------------------ random cast */

const ROLE_IDS = ['LEAD', 'CO_LEAD', 'SECOND_LEAD', 'VIXEN', 'SUPPORTING', 'DANCER', 'EXTRA'] as const;

const DetectSchema = z.object({
  people: z
    .array(
      z.object({
        label: z.string().describe('Short visual description to name them by, e.g. "Woman in the red dress", "Tall man with locs". Never a real name.'),
        images: z.array(z.number().int()).describe('Indexes of every image this same person appears in'),
        face: z
          .object({ image: z.number().int(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })
          .describe('Box around their face in the clearest image, as fractions 0-1 of the image width / height (x, y = top-left)'),
        gender: z.string().describe('Presentation as seen, e.g. "woman", "man"; empty if unclear'),
        ageRange: z.string().describe('e.g. "25-30"'),
        heightCm: z.number().int().describe('Height estimate in cm from proportions, surroundings, other people and objects'),
        heightConfidence: z.enum(['low', 'medium', 'high']),
        build: z.string().describe('Body frame, e.g. "slim", "athletic", "curvy", "broad-shouldered", "petite"'),
        skinTone: z.string(),
        hairStyle: z.string().describe('Empty when bald'),
        hairColor: z.string(),
        bald: z.boolean(),
        facialHair: z.string().describe('"clean" when none'),
        expression: z.string().describe('Typical expression / energy seen, e.g. "warm smile, playful"'),
        suggestedRole: z.enum(ROLE_IDS),
        roleReason: z.string().describe('One short reason for the role, using the song and the cast so far'),
      }),
    )
    .describe('One entry per distinct person (the same person across several images is ONE entry). Skip people too small or blurred to use.'),
});
export type DetectedPerson = z.infer<typeof DetectSchema>['people'][number];

/**
 * "Add random characters": finds every distinct person across a pile of
 * photos and video frames, estimates their look and height / body frame, and
 * suggests a role for each from the song and the cast already there.
 */
export async function detectPeople(
  images: { key: string; label: string }[],
  context: { title: string; artist: string; genre: string; vision: string; leadAct: string; cast: { name: string; role: string }[] },
): Promise<{ people: DetectedPerson[]; engine: string }> {
  const chosen = images.slice(0, 20);
  const blocks = await Promise.all(chosen.map((image) => photoBlock(image.key)));
  const content: Anthropic.Beta.BetaContentBlockParam[] = blocks.flatMap((block, index) => [{ type: 'text' as const, text: `Image ${index} (${chosen[index]!.label}):` }, block]);
  content.push({
    type: 'text',
    text: [
      `<song title="${context.title}" artist="${context.artist}" genre="${context.genre}" lead_act="${context.leadAct}"/>`,
      `<vision>${context.vision.slice(0, 1200)}</vision>`,
      `<cast_so_far>${context.cast.map((item) => `${item.name}: ${item.role}`).join('; ') || 'none'}</cast_so_far>`,
      'Find every distinct person. Group the same person across images by face, hair, build and clothing. Estimate height and body frame from proportions and reference objects. ' +
        'Suggest roles the video still needs: fill missing lead / co-lead slots for the lead act first, then second lead, vixens, dancers, supporting roles and extras.',
    ].join('\n'),
  });
  const { data, engine } = await parse(
    'music-video',
    DetectSchema,
    `You are a music-video casting director sorting audition photos and video stills into people. ${RULES}`,
    content,
  );
  const valid = (index: number): boolean => index >= 0 && index < chosen.length;
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return {
    people: data.people
      .map((person) => ({
        ...person,
        images: [...new Set(person.images.filter(valid))],
        heightCm: Math.max(50, Math.min(272, Math.round(person.heightCm))),
        face: { ...person.face, image: valid(person.face.image) ? person.face.image : (person.images.find(valid) ?? 0), x: clamp(person.face.x), y: clamp(person.face.y), w: clamp(person.face.w), h: clamp(person.face.h) },
      }))
      .filter((person) => person.images.length > 0),
    engine,
  };
}

/* ------------------------------------------------------------------ one scene */

const PlannedScene = z.object({
  title: z.string().describe('A short, evocative scene name for the storyboard card, 2-5 words (e.g. "Rooftop at dusk", "The phone call")'),
  subtitle: z.string().describe('One short line under the title: the song part and the place, e.g. "Verse 1 · Lagos rooftop"'),
  description: z.string().describe("One or two plain sentences of what happens, in the artist's terms"),
  prompt: z
    .string()
    .describe(
      'Prompt for the video model, written like a DP describing real footage: one clear action, setting, time of day, the real light source, wardrobe, and the camera move (as strong as <camera_energy> asks, matched to the shot id). ' +
        'For lip-synced shots: close-up or medium close-up, the artist sings toward camera with the emotion on the whole face (brows, forehead and eye creases, cheeks), mouth unobstructed, head moving with the phrasing; ' +
        'do not script the mouth shapes (lip sync draws the words). Describe the face only through light and expression, never its features (identity comes from the cast photos). 50-110 words. No quality buzzwords, no "cinematic", "epic" or "stunning".',
    ),
  shot: z.enum(SHOT_IDS),
  transition: z.enum(TRANSITION_IDS).describe('Transition INTO the next scene'),
  speed: z
    .enum(['normal', 'slow-motion', 'dramatic-slow', 'fast'])
    .describe(
      'How the shot plays in the edit, the way a music-video editor uses speed: "slow-motion" for reveals, entrances and sensual or emotional beats (a woman stepping out of a car, ' +
        'heels touching the ground and hands before the face is revealed; hair and fabric in the wind; a slow turn to camera; a drop or the first chorus hit), "dramatic-slow" for the ' +
        'single biggest moment of the video, "fast" for a quick, high-energy cut, otherwise "normal". Use slow motion on purpose (a few shots, never most). Lip-synced shots are always "normal".',
    ),
  durationSec: z
    .number()
    .describe(
      'Seconds on screen, 3-10. Give the scene the time its action, place and details need to play out (usually 6-10 s; the video model renders up to 10 s, so a short scene throws detail away). Under 5 s only for deliberate quick cuts on a fast, high-energy part.',
    ),
  location: z.string().describe('Short location name'),
  timeOfDay: z.string().describe('e.g. golden hour, night, dawn'),
  costume: z.string().describe('What the cast wears in this scene (from their costumes when given)'),
  characterIndexes: z.array(z.number().int()).describe('Indexes (C0, C1…) of the characters in the shot; empty for establishing / cutaway shots'),
  lipSync: z
    .boolean()
    .describe(
      'True when an artist (lead / co-lead) is on screen singing the words heard at that moment: performance shots and any shot where they sing. Must be true for at least a third of the shots that feature the artist, especially during verses and the chorus.',
    ),
  lyric: z.string().describe('The lyric line this scene sits under, if known, else empty'),
  mode: z
    .enum(['PERFORMANCE', 'NARRATIVE', 'BROLL'])
    .describe('PERFORMANCE = the artist sings the words to camera (lip sync); NARRATIVE = the story acting out what the words are about, nobody sings; BROLL = atmosphere / instrumental / transition'),
  emotion: z
    .enum(PERFORMANCE_EMOTION_IDS)
    .describe(
      `How the artist delivers the line in a PERFORMANCE shot, read from the lyric and the song's energy: ${Object.entries(PERFORMANCE_EMOTIONS)
        .map(([id, face]) => `${id} (${face})`)
        .join('; ')}. For other modes pick the scene's mood anyway.`,
    ),
  intensity: z
    .number()
    .int()
    .describe('1 = subtle (verses, intimate lines), 2 = natural, 3 = full out (big hooks, belted notes, the final chorus)'),
  why: z
    .string()
    .describe(
      "For the artist, 2-4 plain sentences: what you planned or changed (shot, length, place, cast, lip sync, emotion) and WHY, tied to the song (section, lyric, energy), the story and the artist's notes. No filler.",
    ),
});
export type PlannedMvScene = Omit<z.infer<typeof PlannedScene>, 'characterIndexes'> & { characterIds: string[] };

const shotGuide = `Shot ids: ${Object.entries(SHOTS)
  .map(([id, text]) => `${id} = ${text}`)
  .join('; ')}.`;

export async function expandScene(context: DirectorContext, draft: { kind: string; description: string; notes?: string | undefined }): Promise<PlannedMvScene & { engine: string }> {
  const { data, engine } = await parse(
    'music-video',
    PlannedScene,
    `You are a music-video director turning the artist's scene idea into a shootable plan for photoreal AI video. Keep their intent; add what a DP needs. ${RULES} ${shotGuide}`,
    [
      {
        type: 'text',
        text: `${contextText(context)}\n\nScene type: ${draft.kind}.\n<scene_idea>${draft.description}</scene_idea>${draft.notes ? `\n<artist_edits>${draft.notes}</artist_edits>` : ''}`,
      },
    ],
  );
  const { characterIndexes, ...rest } = data;
  return { ...rest, durationSec: clampDuration(rest.durationSec), characterIds: idsFor(characterIndexes, context), engine };
}

const clampDuration = (value: number): number => Math.min(10, Math.max(3, Math.round(value * 2) / 2));

/* ------------------------------------------------------------------ the director's room */

const DiscussSchema = z.object({
  reply: z.string().describe('Your answer as the director: candid, specific, 80-250 words. Push back with reasons when an idea will hurt the video, but defer to the artist as lead director.'),
  references: z
    .array(
      z.object({
        title: z.string(),
        artist: z.string(),
        year: z.string().describe('Release year if you are confident, else empty'),
        director: z.string().describe('Video director if you are confident, else empty'),
        why: z.string().describe('What to take from it for this video'),
      }),
    )
    .describe('0-3 real, well-known music videos you are confident exist, relevant to the point. Never invent one.'),
  proposals: z
    .array(
      z.object({
        sceneIndex: z.number().int().describe('S index the change applies to, or -1 for a new scene'),
        summary: z.string().describe('One line: what changes and why'),
        description: z.string().describe('The new scene description (full), or empty to keep it'),
        location: z.string().describe('New location, or empty'),
        costume: z.string().describe('New wardrobe, or empty'),
        durationSec: z.number().describe('New duration, or 0 to keep'),
      }),
    )
    .describe('0-3 concrete scene changes the artist can apply with one click'),
  titles: z
    .object({
      propose: z.boolean().describe('True when you are proposing (or revising) the opening titles in this reply'),
      presenter: z.string().describe('Production credit, e.g. "A Sunset Films production"; use the artist\'s own company names when they gave them, else a tasteful placeholder they can rename'),
      label: z.string().describe('Record label line, e.g. "Mavin Records presents", or empty'),
      featuring: z.string().describe('Featured artist(s) if any, else empty'),
      director: z.string().describe('End credit name for "Directed by …", or empty'),
      prologue: z
        .array(z.object({ text: z.string().describe('One short sentence of story set-up, max 200 characters'), seconds: z.number().describe('2-8 s on screen') }))
        .describe('0-3 text cards shown on black before the song, only when the story needs setting up (time, place, what happened)'),
      style: z.enum(TITLE_STYLES).describe('classic = serif, letter-spaced; minimal = thin lowercase; typewriter = mono, words appear one by one; bold = heavy sans'),
      placement: z.enum(['over-intro', 'on-black']).describe('Credits over the intro footage, or on black before the song'),
      why: z.string().describe('One sentence on why this opening suits the song'),
    })
    .describe('Opening titles: propose them when the artist asks about the intro / titles / opening / label / production credit, or in your first reply when none exist yet. Otherwise propose = false.'),
});
export type DiscussResult = z.infer<typeof DiscussSchema> & { engine: string };

export async function discuss(context: DirectorContext, history: { author: 'CREATOR' | 'DIRECTOR'; content: string }[], message: string): Promise<DiscussResult> {
  const transcript = history
    .slice(-16)
    .map((item) => `${item.author === 'CREATOR' ? 'ARTIST' : 'DIRECTOR'}: ${item.content.slice(0, 1500)}`)
    .join('\n');
  const { data, engine } = await parse(
    'music-video',
    DiscussSchema,
    `You are ${env.BOT_NAME}, ${env.APP_NAME}'s AI director: an experienced music-video director in pre-production with the artist. When you refer to yourself, you are ${env.BOT_NAME}. ` +
      'The artist is the lead director and has the final word; you are the expert who argues when it matters. ' +
      'Reference real, famous music videos only when you are sure they exist (title, artist), and say concretely what to borrow: framing, colour, choreography, pacing, transitions. ' +
      `Tie ideas to the song's lyrics and structure (intro, verses, hooks, bridge, outro), using the song map when given. ` +
      'You also own the opening: discuss a proper music-video opening with the artist (production credit, record label, artist and song title cards, and story text cards on black when the story needs a set-up), ' +
      'ask for their real company / label names if unknown, and propose it in the titles field. ' +
      (context.place
        ? ''
        : 'Information gathering: the cast background and the shoot location are not set yet. Early in the conversation ask where the video is shot and who the supporting cast and extras are ' +
          '(for example "Lagos or London?", "do you want Black and white people mixed, or an all-local cast?"); the artist sets them in Direction → Cast and location. ') +
      `${PRO_RULES} ${RULES}`,
    [{ type: 'text', text: `${contextText(context)}\n\n<conversation>\n${transcript || '(start)'}\n</conversation>\n\n<artist_message>${message}</artist_message>` }],
  );
  return { ...data, references: data.references.slice(0, 3), proposals: data.proposals.slice(0, 3), engine };
}

/* ------------------------------------------------------------------ storyboard */

/*
 * The storyboard is written in two steps so every scene is its own moment and nothing is cut short:
 *   1. outline: the whole video as N distinct beats placed on the song (who, where, what happens,
 *      which words are sung under it), drawn from the song, the vision, the director's room and cast;
 *   2. scenes: each beat written out in full, a few per call in parallel (one call can't hold
 *      20-30 detailed scenes, which is what used to collapse a song into one repeated scene).
 * The outline is checked for repeats and retried once with the repeats named.
 */
const OutlineSchema = z.object({
  logline: z.string().describe('One-sentence story of the video'),
  arc: z.string().describe('How the story and performance build across the song: set-up, rise, peak on the hooks, turn at the bridge, resolution. 2-4 sentences.'),
  beats: z.array(
    z.object({
      kind: z.enum(['INTRO', 'STORY', 'OUTRO']),
      startSec: z.number().describe('Where this beat starts in the video, in seconds, on a section change or bar line from the song map'),
      title: z.string().describe('2-5 word name, different from every other beat'),
      beat: z.string().describe('What happens in this moment, concretely (action, who, where, what changes since the previous beat). 1-2 sentences, never a repeat of another beat.'),
      lyricCue: z.string().describe('The words sung under this beat (from the song map), or the section name for instrumental parts'),
      location: z.string().describe('Short location name'),
      mode: PlannedScene.shape.mode,
      characterIndexes: z.array(z.number().int()).describe('Indexes (C0, C1…) of the characters in this beat'),
    }),
  ),
});
type Outline = z.infer<typeof OutlineSchema>;
type OutlineBeat = Outline['beats'][number];

const BatchSchema = z.object({
  scenes: z.array(PlannedScene.extend({ kind: z.enum(['INTRO', 'STORY', 'OUTRO']), startSec: z.number() })),
});
type BatchScene = z.infer<typeof BatchSchema>['scenes'][number];

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);

/** Beats that repeat an earlier one (same title or same action), by index. */
function repeatedBeats(beats: { title: string; beat: string }[]): number[] {
  const seen = new Set<string>();
  const repeats: number[] = [];
  beats.forEach((item, index) => {
    const keys = [`t:${norm(item.title)}`, `b:${norm(item.beat)}`];
    if (keys.some((key) => seen.has(key))) repeats.push(index);
    keys.forEach((key) => seen.add(key));
  });
  return repeats;
}

/** The context with the current scenes de-duplicated (copies from an older build must not be "kept"). */
function withDistinctScenes(context: DirectorContext): DirectorContext {
  const seen = new Set<string>();
  const scenes = context.scenes.filter((scene) => {
    const key = norm(scene.description);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...context, scenes };
}

const storyboardRole = (): string =>
  `You are ${env.BOT_NAME}, the AI director, writing the storyboard of a music video. Listen to the song through its song map: the sections, the energy ` +
  "and above all the words sung in each part. Draw on the artist's vision, mood and direction settings, the director's room, the cast and the place, " +
  'and build a story that resonates with the song and moves forward with it, intercut with performance. ';

async function outlineBeats(context: DirectorContext, discussion: string, count: number, feedback?: string): Promise<Outline> {
  const { data } = await parse(
    'music-video',
    OutlineSchema,
    storyboardRole() +
      `Plan exactly ${count} beats: exactly one INTRO first, exactly one OUTRO last, STORY between. ` +
      'Every beat is a different moment: a new action, place, angle or turn in the story; the same location may come back, the same action never does. ' +
      'Place them on the song map with startSec in order, no gaps, the last ending at the end of the video; each beat covers its own lines, ' +
      'so what happens follows what is being sung (a line about leaving shows the leaving, a hook gets the biggest performance moment). ' +
      "The <scenes> list is the current draft and the artist's own ideas: keep the artist's ideas that fit, in spirit and order, and never repeat a scene. " +
      'Set mode PERFORMANCE where the artist sings to camera. ' +
      `${PRO_RULES} ${RULES}`,
    [
      {
        type: 'text',
        text:
          `${contextText(context)}\n\n<directors_room_summary>\n${discussion.slice(0, 8000) || 'no discussion'}\n</directors_room_summary>` +
          (feedback ? `\n\n<fix>${feedback}</fix>` : ''),
      },
    ],
  );
  return data;
}

function beatLines(beats: OutlineBeat[], start: number, end: number): string {
  const from = Math.max(0, start);
  return beats
    .slice(from, Math.max(from, end))
    .map(
      (item, offset) =>
        `B${from + offset} [${item.kind}${item.mode ? ` · ${item.mode}` : ''}] at ${item.startSec}s · ${item.title} @ ${item.location}: ${item.beat} ` +
        `(under: ${item.lyricCue}) cast: ${item.characterIndexes.map((index) => `C${index}`).join(', ') || 'none'}`,
    )
    .join('\n');
}

async function writeBatch(context: DirectorContext, outline: Outline, from: number, to: number): Promise<BatchScene[]> {
  const beats = outline.beats;
  const { data } = await parse(
    'music-video',
    BatchSchema,
    storyboardRole() +
      `Write out beats B${from} to B${to - 1} of the outline as full scenes: exactly one scene per beat, in order, keeping each beat's kind, startSec, cast and idea. ` +
      'Each scene has its own action, framing and camera move; it continues from the beat before it and leads into the next, and never repeats it. ' +
      'The lyric field is the words under that beat. Set lipSync true exactly for PERFORMANCE scenes. ' +
      `${PRO_RULES} ${RULES} ${shotGuide}`,
    [
      {
        type: 'text',
        text:
          `${contextText(context)}\n\n<outline logline="${outline.logline.replace(/"/g, "'")}">\n<arc>${outline.arc}</arc>\n` +
          (from > 0 ? `<before>\n${beatLines(beats, from - 2, from)}\n</before>\n` : '') +
          `<write_these>\n${beatLines(beats, from, to)}\n</write_these>\n` +
          (to < beats.length ? `<after>\n${beatLines(beats, to, to + 2)}\n</after>\n` : '') +
          '</outline>',
      },
    ],
  );
  return data.scenes;
}

/** A scene from its outline beat alone (only if a batch came back short twice). */
function fromBeat(item: OutlineBeat): BatchScene {
  return {
    kind: item.kind,
    startSec: item.startSec,
    title: item.title,
    subtitle: item.lyricCue.slice(0, 100),
    description: item.beat,
    prompt: `${item.beat} Location: ${item.location}.`,
    shot: SHOT_IDS[0],
    transition: TRANSITION_IDS[0],
    speed: 'normal',
    durationSec: 6,
    location: item.location,
    timeOfDay: '',
    costume: '',
    characterIndexes: item.characterIndexes,
    lipSync: item.mode === 'PERFORMANCE' && item.characterIndexes.length > 0,
    lyric: item.lyricCue,
    mode: item.mode,
    why: '',
  } as BatchScene;
}

export async function storyboard(
  rawContext: DirectorContext,
  discussion: string,
  sceneCount?: number,
  /** Progress for the page: what the director is doing and how far along (0-1). */
  onProgress?: (step: string, fraction: number) => Promise<void> | void,
): Promise<{ logline: string; scenes: (PlannedMvScene & { kind: 'INTRO' | 'STORY' | 'OUTRO' })[]; engine: string }> {
  const context = withDistinctScenes(rawContext);
  await onProgress?.(`${env.BOT_NAME} is listening to the song and planning the story…`, 0.05);
  const count = Math.max(3, Math.min(60, sceneCount ?? (context.songSeconds ? Math.ceil(context.songSeconds / 7) : 10)));

  // 1. Outline, retried once if it came back short or repetitive.
  const problems = (plan: Outline): string | null => {
    const repeats = repeatedBeats(plan.beats);
    const short = plan.beats.length < Math.ceil(count * 0.75);
    if (!repeats.length && !short) return null;
    return [
      short ? `You planned ${plan.beats.length} beats; plan ${count}.` : '',
      repeats.length ? `Beats ${repeats.map((index) => `B${index} ("${plan.beats[index]!.title}")`).join(', ')} repeat earlier beats: give each its own moment from the words sung under it.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  };
  let outline = await outlineBeats(context, discussion, count);
  const issue = problems(outline);
  if (issue) {
    await onProgress?.(`${env.BOT_NAME} is reworking the plan so no two scenes repeat…`, 0.2);
    const second = await outlineBeats(context, discussion, count, issue);
    if (!problems(second) || second.beats.length > outline.beats.length) outline = second;
  }
  outline.beats.sort((a, b) => a.startSec - b.startSec);
  await onProgress?.(`Story planned: ${outline.beats.length} scenes. ${env.BOT_NAME} is writing them…`, 0.3);
  let done = 0;

  // 2. Full scenes, a few beats per call, in parallel (one retry per batch).
  const SIZE = 6;
  const ranges: [number, number][] = [];
  for (let from = 0; from < outline.beats.length; from += SIZE) ranges.push([from, Math.min(outline.beats.length, from + SIZE)]);
  const batches = await Promise.all(
    ranges.map(async ([from, to]) => {
      let written = await writeBatch(context, outline, from, to).catch(() => [] as BatchScene[]);
      if (written.length < to - from) written = await writeBatch(context, outline, from, to).catch(() => written);
      done += to - from;
      await onProgress?.(`Wrote scenes ${from + 1}–${to} (${done} of ${outline.beats.length})…`, 0.3 + 0.6 * (done / outline.beats.length));
      // One scene per beat, in order; anything still missing falls back to the beat itself.
      return outline.beats.slice(from, to).map((item, offset) => {
        const scene = written[offset];
        return scene ? { ...scene, kind: item.kind, startSec: item.startSec } : fromBeat(item);
      });
    }),
  );
  const planned = batches.flat();

  // Durations from the planned start times (the beats sit on the song map), else the scene's own.
  const end = context.songSeconds ?? 0;
  const scenes = planned.map(({ characterIndexes, startSec, ...scene }, index, list) => {
    const next = list[index + 1]?.startSec ?? (end > 0 ? end : startSec + scene.durationSec);
    const fromStarts = next - startSec;
    const span = fromStarts > 0 ? Math.round(Math.min(120, Math.max(3, fromStarts)) * 2) / 2 : clampDuration(scene.durationSec);
    return { ...scene, durationSec: span, characterIds: idsFor(characterIndexes, context) };
  });
  // Enforce the bookends even if the model slipped.
  if (scenes.length && scenes[0]!.kind !== 'INTRO') scenes[0]!.kind = 'INTRO';
  if (scenes.length > 1 && scenes.at(-1)!.kind !== 'OUTRO') scenes.at(-1)!.kind = 'OUTRO';
  scenes.forEach((scene, index) => {
    if (index > 0 && index < scenes.length - 1) scene.kind = 'STORY';
  });
  return { logline: outline.logline, scenes, engine: 'Claude' };
}

/* ------------------------------------------------------------------ regenerate scripts */

const RewriteSchema = z.object({
  scenes: z.array(PlannedScene.extend({ index: z.number().int().describe('The S index of the scene this rewrites') })),
});

/**
 * Rewrites the scripts of the scenes at `indexes` (copies of other scenes, or ones the artist
 * picked) so each becomes its own moment for its slot on the song: its time, the words under it,
 * and the scenes around it. Everything else on the board stays as it is. Batches run one after
 * another and each sees the scripts already rewritten, so no two new scenes repeat each other;
 * anything still missing or still repeating is rewritten again (up to two more rounds).
 */
export async function rewriteScenes(
  context: DirectorContext,
  indexes: number[],
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<Map<number, PlannedMvScene>> {
  const out = new Map<number, PlannedMvScene>();
  // A working copy of the board: rewritten scenes replace the copies as we go.
  const board = { ...context, scenes: context.scenes.map((scene) => ({ ...scene })) };
  const titles = new Map<number, string>();
  const SIZE = 6;
  const key = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);

  const writeGroup = async (group: number[]): Promise<void> => {
    const slots = group
      .map((index) => {
        const scene = board.scenes[index]!;
        const start = board.scenes.slice(0, index).reduce((sum, item) => sum + item.durationSec, 0);
        return `S${index} [${scene.kind}] at ${start.toFixed(1)}s for ${scene.durationSec}s${scene.lyric ? ` · under: "${scene.lyric.slice(0, 200)}"` : ''}`;
      })
      .join('\n');
    const used = [...titles.values()].map((title) => `"${title}"`).join(', ');
    const ask = () =>
      parse(
        'music-video',
        RewriteSchema,
        `You are ${env.BOT_NAME}, the AI director, fixing a music-video storyboard where some scenes are copies of another scene. ` +
          'Write a new script for each scene listed in <rewrite>: exactly one scene per index, its own moment on the song. Keep its kind, its place and length on the song and the words under it; ' +
          'make what happens follow those words and continue the story from the scene before it into the scene after it (see <scenes>). ' +
          'Every rewritten scene must differ from every other scene on the board and from each other: a new action, place, angle or turn in the story, never the same title or script. ' +
          "Stay true to the artist's vision, mood, cast and place. Set lipSync true exactly for PERFORMANCE scenes. " +
          `${PRO_RULES} ${RULES} ${shotGuide}`,
        [{ type: 'text', text: `${contextText(board)}\n\n${used ? `<titles_taken>${used}</titles_taken>\n` : ''}<rewrite>\n${slots}\n</rewrite>` }],
      );
    const { data } = await ask().catch(() => ask());
    data.scenes.forEach((item, position) => {
      const index = group.includes(item.index) ? item.index : group[position];
      if (index === undefined) return;
      const { characterIndexes, index: _index, ...scene } = item;
      out.set(index, { ...scene, characterIds: idsFor(characterIndexes, context) });
      titles.set(index, scene.title);
      // The board now shows the new script, so the next batch builds on it.
      board.scenes[index] = { ...board.scenes[index]!, description: scene.description, prompt: scene.prompt, location: scene.location, costume: scene.costume };
    });
  };

  let pending = [...indexes];
  let lastError: unknown = null;
  for (let round = 0; round < 3 && pending.length; round += 1) {
    for (let at = 0; at < pending.length; at += SIZE) {
      await writeGroup(pending.slice(at, at + SIZE)).catch((error: unknown) => {
        lastError = error;
      });
      await onProgress?.(Math.min(indexes.length, out.size), indexes.length);
    }
    // Next round: anything not written, or still repeating another scene's title or script.
    const seenTitles = new Map<string, number>();
    const seenScripts = new Map<string, number>();
    board.scenes.forEach((scene, index) => {
      const script = key(scene.description);
      if (!seenScripts.has(script)) seenScripts.set(script, index);
      const title = titles.get(index);
      if (title && !seenTitles.has(key(title))) seenTitles.set(key(title), index);
    });
    pending = indexes.filter((index) => {
      if (!out.has(index)) return true;
      const title = key(titles.get(index) ?? '');
      return seenTitles.get(title) !== index || seenScripts.get(key(board.scenes[index]!.description)) !== index;
    });
    // Every call failing (the AI is down, a key problem…): stop and say why instead of "done, 0 rewritten".
    if (out.size === 0 && lastError) throw lastError;
  }
  return out;
}

/* ------------------------------------------------------------------ lyrics */

/**
 * How sung lyrics are written. Speech models force everything into standard
 * English; artists sing in pidgin, mixes of languages and ad-libs.
 */
const LYRIC_LANGUAGE_RULES =
  'Write lyrics the way the artist actually sings them. Detect the language(s): artists often mix English with Nigerian / West African Pidgin, Yoruba, Igbo, Hausa, ' +
  'Twi, Swahili, Zulu, French, Spanish, Jamaican Patois and others, sometimes inside one line. Pidgin stays pidgin, written the usual way: "dem be", "dem say", ' +
  '"I go do am later", "wetin dey happen", "no wahala", "e don do", "how far", "abeg", "I no fit", "na so", "make we", "comot", "sabi", "wey", "una", "sef". ' +
  'Never "correct" pidgin or other languages into standard English. Keep exclamations and ad-libs as their own words with an exclamation mark ("Ehn!", "Oya!", ' +
  '"Haba!", "Chai!", "Ah!", "Ayy!", "Yeah!", "Woah!", "Eh-eh!", "Ooh!", "Gbese!", "Kai!"). Background ad-libs go in parentheses, e.g. "(Oya!)".';

const LanguageSchema = z.object({
  primary: z.string().describe('Main language, e.g. "Nigerian Pidgin", "English", "Yoruba"'),
  others: z.array(z.string()).describe('Other languages mixed in, most used first. Empty if none.'),
  pidgin: z.boolean().describe('True when any pidgin / creole is sung'),
  note: z.string().describe('One short sentence on how the artist writes, e.g. "Pidgin verses, English hook, Yoruba ad-libs"'),
});
export type LyricLanguages = z.infer<typeof LanguageSchema>;

const PolishSchema = z.object({
  languages: LanguageSchema,
  lines: z
    .array(
      z.object({
        index: z.number().int(),
        text: z.string().describe('The rewritten line in the artist\'s language and spelling style'),
        reason: z.string().describe('Short reason, e.g. "pidgin forced into English"'),
        kind: z.enum(['LYRIC', 'EXCLAMATION', 'ADLIB']).describe('EXCLAMATION when the line is (or is mainly) a shout / interjection; ADLIB for background ad-libs'),
      }),
    )
    .describe('Only lines you changed. Leave clear, correct lines out.'),
});

/**
 * The artist wrote a few lines correctly (in their own language / pidgin /
 * spelling). The director learns their style from them, detects the song's
 * languages, and rewrites every other line that is unclear or badly
 * transcribed, including pidgin and exclamations. Suggestions only.
 */
const VoiceSchema = z.object({
  accent: z.string().describe('How the singing sounds from the words and spelling, e.g. "Nigerian (Lagos) English with Pidgin", "London (MLE) English", "Jamaican Patois", "Southern US". Empty when unclear.'),
  region: z.string().describe('The country / region the song most likely speaks to, e.g. "Lagos, Nigeria", "Accra, Ghana", "South London, UK", "Atlanta, USA". Empty when unclear.'),
  confidence: z.enum(['low', 'medium', 'high']),
  note: z.string().describe('One sentence: the clues (languages, slang, place names, references) behind it.'),
});
export type VoiceProfile = z.infer<typeof VoiceSchema>;

/**
 * The song's voice as a background cue: accent, language and the region the
 * song speaks to, read from the transcribed words (languages, slang, pidgin,
 * places named). Used only when the artist has not set the cast background
 * and the shoot location themselves. Never a guess at anyone's race or skin
 * colour: a voice does not tell you that, and the artist's own choice wins.
 */
export async function profileVoice(lines: { text: string }[], context: { title: string; artist: string; genre: string; language: string | null }): Promise<VoiceProfile & { engine: string }> {
  const text = lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 12000);
  const { data, engine } = await parse(
    'music-video',
    VoiceSchema,
    'You read sung lyrics (an automatic transcript) and describe the singing voice\'s accent and the region the song most likely speaks to, from the evidence in the words only: ' +
      'languages and code-switching, pidgin / creole, slang, spelling, ad-libs, places and cultural references named. This is used as a cue for where a music video is set and who appears in it. ' +
      'Do not guess race, ethnicity or skin colour, and do not use the artist\'s name as evidence. If the words do not point anywhere, leave accent and region empty with low confidence.',
    [
      {
        type: 'text',
        text: `<song title="${context.title}" artist="${context.artist}" genre="${context.genre}" detected_language="${context.language ?? 'unknown'}"/>\n<lyrics>\n${text || '(no words)'}\n</lyrics>`,
      },
    ],
  );
  return { ...data, engine };
}

export async function polishLyrics(
  lines: { start: number; end: number; text: string }[],
  samples: string,
  context: { title: string; artist: string; genre: string },
): Promise<{ languages: LyricLanguages; changes: { index: number; text: string; reason: string; kind: 'LYRIC' | 'EXCLAMATION' | 'ADLIB' }[]; engine: string }> {
  const numbered = lines.map((line, index) => `${index}: ${line.text}`).join('\n');
  const { data, engine } = await parse(
    'music-video',
    PolishSchema,
    'You fix automatic transcriptions of sung lyrics. The artist has written a few lines themselves: they are correct and show the language, slang, pidgin and spelling ' +
      'style of this song. Learn from them, then find every transcribed line that is unclear, garbled, misheard or written in the wrong language and rewrite it the way ' +
      'the artist would write it, matching sounds (a misheard line sounds like the real one). Lines that repeat the artist\'s lines (hooks, choruses) must match them. ' +
      `${LYRIC_LANGUAGE_RULES} Do not touch lines that are already right; never invent new lyrics, never censor.`,
    [
      {
        type: 'text',
        text:
          `<song title="${context.title}" artist="${context.artist}" genre="${context.genre}"/>\n` +
          `<artist_written_lines>\n${samples.slice(0, 4000)}\n</artist_written_lines>\n<transcribed_lyrics>\n${numbered.slice(0, 20000)}\n</transcribed_lyrics>`,
      },
    ],
  );
  const seen = new Set<number>();
  return {
    languages: data.languages,
    changes: data.lines
      .filter((item) => item.index >= 0 && item.index < lines.length && item.text.trim() && item.text.trim() !== lines[item.index]!.text && !seen.has(item.index) && seen.add(item.index))
      .map((item) => ({ ...item, text: item.text.trim() })),
    engine,
  };
}

const LyricFixSchema = z.object({
  lines: z.array(z.object({ index: z.number().int(), text: z.string() })).describe('Only the lines you changed, by index, with the corrected text. Leave lines you did not change out.'),
});

/**
 * The artist corrected some transcribed lines. Speech-to-text mishears the same
 * words the same way every time they come back (hooks, choruses, ad-libs), so
 * the director applies each correction to every other line where the same
 * words were misheard, keeping each line's own wording otherwise.
 */
export async function correctLyrics(
  lines: { start: number; end: number; text: string }[],
  corrections: { index: number; before: string; after: string }[],
  context: { title: string; artist: string; genre: string },
): Promise<{ changes: { index: number; text: string }[]; engine: string }> {
  const numbered = lines.map((line, index) => `${index}: ${line.text}`).join('\n');
  const examples = corrections.map((item) => `line ${item.index}: heard "${item.before}" → actually "${item.after}"`).join('\n');
  const { data, engine } = await parse(
    'music-video',
    LyricFixSchema,
    'You correct automatic transcriptions of sung lyrics. The artist has corrected some lines; the transcriber misheard those same words the same way wherever they recur ' +
      '(repeated hooks, choruses, chants, ad-libs, slang, pidgin and other languages). Apply each correction to every other line where the same words were misheard, ' +
      'matching by sound, not exact spelling (e.g. "miss miss" heard for "mies mies"). Keep the rest of each line as it is; do not rewrite lines that are not affected; never invent lyrics. ' +
      LYRIC_LANGUAGE_RULES,
    [
      {
        type: 'text',
        text: `<song title="${context.title}" artist="${context.artist}" genre="${context.genre}"/>\n<artist_corrections>\n${examples}\n</artist_corrections>\n<lyrics>\n${numbered.slice(0, 20000)}\n</lyrics>`,
      },
    ],
  );
  return { changes: data.lines.filter((line) => line.index >= 0 && line.index < lines.length && line.text.trim()), engine };
}

const ProofreadSchema = z.object({
  suggestions: z
    .array(
      z.object({
        index: z.number().int().describe('Line index'),
        text: z.string().describe('The corrected line'),
        reason: z.string().describe('Short reason, e.g. "sounds like \'enemies\'; matches the hook on line 4"'),
        confidence: z.number().describe('0-1'),
      }),
    )
    .describe('Only lines that are probably misheard. Leave correct lines out.'),
});

/**
 * Proofreads a sung-lyrics transcript: finds lines the speech model probably
 * misheard (words that make no sense in context, broken repeats of the hook,
 * mangled slang / pidgin / other-language words) and proposes corrections.
 * Suggestions only: nothing changes until the artist accepts them.
 */
export async function proofreadLyrics(
  lines: { start: number; end: number; text: string }[],
  context: { title: string; artist: string; genre: string; vision: string },
): Promise<{ suggestions: { index: number; text: string; reason: string; confidence: number }[]; engine: string }> {
  const numbered = lines.map((line, index) => `${index}: ${line.text}`).join('\n');
  const { data, engine } = await parse(
    'music-video',
    ProofreadSchema,
    'You proofread automatic transcriptions of sung lyrics. Speech models mishear singing: words blur into similar-sounding ones, slang, pidgin and other ' +
      'languages get forced into English, ad-libs become nonsense, and a repeated hook comes out differently each time. Find lines that are probably wrong and ' +
      'propose the most likely real lyric, using the song title, artist, genre, the rest of the lyrics and the way choruses repeat. Be conservative: only suggest ' +
      "a change when the line is likely misheard, keep the artist's own spelling style, never invent new lyrics or censor. " +
      LYRIC_LANGUAGE_RULES,
    [
      {
        type: 'text',
        text: `<song title="${context.title}" artist="${context.artist}" genre="${context.genre}"/>\n<vision>${context.vision.slice(0, 800)}</vision>\n<lyrics>\n${numbered.slice(0, 20000)}\n</lyrics>`,
      },
    ],
  );
  const seen = new Set<number>();
  return {
    suggestions: data.suggestions
      .filter((item) => item.index >= 0 && item.index < lines.length && item.text.trim() && item.text.trim() !== lines[item.index]!.text && !seen.has(item.index) && seen.add(item.index))
      .map((item) => ({ ...item, text: item.text.trim(), confidence: Math.max(0, Math.min(1, item.confidence)) })),
    engine,
  };
}
