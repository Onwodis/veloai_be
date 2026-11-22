/**
 * Cinematography vocabulary shared by the director, the take generator and
 * assembly. KEEP IN SYNC with fe/src/utils/studioApi.ts (labels for the UI).
 *
 * Realism comes from three places, not one magic prompt:
 *   1. identity: a photoreal keyframe of the creator made from their own
 *      reference photos, which the video model then animates;
 *   2. camera language: real lenses, real camera moves, motivated light;
 *   3. finishing: grade, grain, halation-free sharpening, letterbox and a
 *      proper encode at assembly (see assemble.ts).
 */

export const SHOTS = {
  'aerial-establishing': 'Aerial drone establishing shot, slow steady forward glide over the real location',
  'aerial-orbit': 'Aerial drone shot slowly orbiting the subject in a smooth wide arc, the landscape turning behind them',
  'aerial-reveal': 'Drone rises from behind an obstacle and tilts down to reveal the subject in the wider landscape',
  'aerial-topdown': "Top-down bird's-eye drone shot looking straight down, slow rotation",
  wide: 'Wide shot, subject full body in the environment, locked-off tripod camera',
  medium: 'Medium shot from the waist up, gentle handheld float',
  'close-up': 'Close-up on the face, 85mm lens, shallow depth of field, eyes in sharp focus',
  'extreme-close-up': 'Extreme close-up detail shot, macro lens, very shallow focus',
  tracking: 'Steadicam tracking shot following the subject as they move, smooth and stable',
  'dolly-in': 'Slow, subtle push-in towards the subject',
  'dolly-out': 'Slow dolly pull-back revealing more of the scene',
  crane: 'Gentle jib shot rising from eye level to a slightly high angle',
  'low-angle': 'Slightly low angle looking up at the subject, steady and natural',
  handheld: 'Handheld documentary camera with subtle natural shake, intimate and immediate',
  'slow-motion': 'High-frame-rate slow motion capture, every movement smooth and deliberate',
  performance: 'Subject singing directly to camera with real emotion on the whole face, medium close-up',
  // Kinetic music-video camera (bold / wild energy).
  'fpv-dive': 'FPV drone dive: the camera plunges from height and races low across the scene, pulling up hard onto the subject',
  'fpv-flythrough': 'FPV drone flying fast through the space, threading a doorway or a gap in the crowd and banking around the subject',
  'orbit-360': 'Fast 360-degree orbit around the subject at chest height, the background whipping round behind them',
  'whip-pan': 'Whip pan: the camera snaps sideways onto the subject through a streak of motion blur and lands dead on them',
  'crash-zoom': "Crash zoom: a sudden, punchy zoom from wide straight into the subject's face, landing on the beat",
  'dutch-angle': 'Dutch angle: the frame tilted 20-30 degrees, tense and stylish, the subject sharp in the tilted frame',
  'worms-eye': "Worm's-eye view: the lens on the ground looking straight up at the subject towering over it against the sky",
  'overhead-spin': 'Overhead top-down shot directly above the subject, the frame slowly spinning',
  'dolly-zoom': 'Dolly zoom (vertigo effect): the subject stays the same size while the background stretches away behind them',
  snorricam: 'Body-mounted camera (snorricam): the subject locked in the centre of the frame while the world swings and bounces around them',
  'push-through': 'The camera pushes through a gap (a window, a fence, a crowd, hanging fabric) and lands on the subject',
  'speed-ramp': 'Speed ramp: real-time motion that drops into slow motion at the peak moment, then snaps back to speed',
} as const;
export type Shot = keyof typeof SHOTS;
export const SHOT_IDS = Object.keys(SHOTS) as [Shot, ...Shot[]];
export const isAerial = (shot: string): boolean => shot.startsWith('aerial-');

/**
 * ffmpeg xfade transition + length. `cut` is a true hard cut (frames joined, no
 * blend, so no ghost frame). Blends are measured in BEATS of the song, like an
 * editor cutting to the music: a crossfade lasts one beat at any tempo
 * (`seconds` is the fallback when the tempo is unknown; clamped 0.25-1.2 s).
 */
export const TRANSITIONS = {
  cut: { xfade: 'fade', seconds: 0, beats: 0 },
  crossfade: { xfade: 'fade', seconds: 0.6, beats: 1 },
  'dip-black': { xfade: 'fadeblack', seconds: 0.8, beats: 1.5 },
  'flash-white': { xfade: 'fadewhite', seconds: 0.3, beats: 0.5 },
  'whip-left': { xfade: 'smoothleft', seconds: 0.35, beats: 0.75 },
  'whip-right': { xfade: 'smoothright', seconds: 0.35, beats: 0.75 },
  'zoom-in': { xfade: 'zoomin', seconds: 0.5, beats: 1 },
  'wipe-up': { xfade: 'wipeup', seconds: 0.5, beats: 1 },
  dissolve: { xfade: 'dissolve', seconds: 0.6, beats: 1 },
  'circle-open': { xfade: 'circleopen', seconds: 0.6, beats: 1 },
} as const;
export type Transition = keyof typeof TRANSITIONS;
export const TRANSITION_IDS = Object.keys(TRANSITIONS) as [Transition, ...Transition[]];

/** How long a transition lasts at this tempo (seconds; 0 = hard cut). */
export function transitionSeconds(id: Transition, bpm: number | null | undefined): number {
  const transition = TRANSITIONS[id];
  if (transition.beats === 0) return 0;
  if (!bpm || bpm < 40 || bpm > 240) return transition.seconds;
  return Math.min(1.2, Math.max(0.25, (transition.beats * 60) / bpm));
}

/**
 * Colour looks applied at assembly (ffmpeg filters, applied before grain).
 * Deliberately subtle: heavy grades are what make footage read as fake.
 */
export const LOOKS = {
  natural: 'eq=contrast=1.03:saturation=1.02',
  filmic: "curves=master='0/0.03 0.25/0.22 0.5/0.5 0.75/0.79 1/0.97',colorbalance=rs=0.02:bs=0.03:rh=0.03:bh=-0.02,eq=saturation=0.94",
  'teal-orange': "colorbalance=rs=-0.05:gs=0.01:bs=0.07:rh=0.07:gh=0.02:bh=-0.07,curves=master='0/0.02 0.5/0.5 1/0.98',eq=saturation=1.05",
  'golden-hour': "colorbalance=rm=0.05:gm=0.02:bm=-0.05:rh=0.04:bh=-0.04,curves=master='0/0.03 0.5/0.52 1/0.98',eq=saturation=1.06",
  'cool-night': "colorbalance=rs=-0.03:bs=0.06:rm=-0.02:bm=0.04,curves=master='0/0.02 0.5/0.46 1/0.95',eq=saturation=0.9",
  noir: "hue=s=0,curves=master='0/0 0.3/0.22 0.7/0.8 1/1',eq=contrast=1.08",
  vivid: 'eq=contrast=1.06:saturation=1.15',
} as const;
export type Look = keyof typeof LOOKS;
export const LOOK_IDS = Object.keys(LOOKS) as [Look, ...Look[]];

export const ASPECTS = { '16:9': { width: 1920, height: 1080, model: '16:9' }, '9:16': { width: 1080, height: 1920, model: '9:16' }, '1:1': { width: 1440, height: 1440, model: '1:1' } } as const;
export type Aspect = keyof typeof ASPECTS;

/**
 * Appended to every generation prompt. Reads like real footage from a working
 * crew: available light, a real lens, and the small imperfections of real life.
 * No "epic", no glow, no haze machines unless the scene asks for them.
 */
export const REALISM =
  'Real live-action footage, indistinguishable from a phone-free professional shoot: natural available light, true-to-life colour, real lens with gentle falloff, light natural grain. ' +
  'Real people with real imperfections: visible pores, uneven skin tone, small blemishes, moles, fine lines, slight under-eye shadows, flyaway hairs, a little shine on the skin, natural asymmetry of the face. ' +
  'Lived-in clothes with creases, lint and soft wear; slightly scuffed shoes; ordinary background clutter.';

/** Subtle head and body turns are where generated footage breaks: keep the anatomy solid through them. */
export const STABILITY =
  'When the head or body turns, the face stays the same person from every angle: stable jaw, ears, hairline, teeth and eyes, no smearing, no warping, no flicker; ' +
  'turns are unhurried and anatomically natural, hands stay five-fingered and solid.';

/** Live action only: everything that would make it look drawn, rendered or retouched. */
const NEGATIVE_NOT_REAL =
  'cgi, 3d render, video game, cartoon, anime, illustration, painting, plastic skin, waxy skin, airbrushed, over-smoothed, beauty filter, porcelain skin, perfect symmetrical face, glamour retouch, uncanny, ';
/** Every look: the failure modes of generated video. */
const NEGATIVE_ARTIFACTS =
  'distorted face, asymmetrical eyes, extra fingers, fused fingers, deformed hands, extra limbs, morphing, warping, melting, face smearing during head turn, warped profile, ' +
  'flickering teeth, blurry mouth, mouth artifacts, rubbery lips, flicker, jitter, identity drift, face swap artifacts, text, subtitles, watermark, logo, ' +
  'oversaturated, overexposed, heavy bloom, glowing light, lens flare overload, excessive haze, neon overload, teal-orange grade, HDR look, blurry, low quality, ' +
  'static background, frozen background, still crowd, mannequin, stiff fabric, painted-on clothes, plastic clothing, ai-generated look, epic cinematic look, ';
/** Natural camera energy only: bold / wild energy asks for exactly these moves. */
const NEGATIVE_TAME_CAMERA = 'whip pan, crash zoom, dutch angle, spinning camera, ';
const NEGATIVE_MOTION = 'slow-motion when not asked, floaty movement, sliding feet';

export const NEGATIVE = NEGATIVE_NOT_REAL + NEGATIVE_ARTIFACTS + NEGATIVE_TAME_CAMERA + NEGATIVE_MOTION;

/**
 * The look of the whole video, chosen when a project starts: real people (live action, the
 * realism rules above) or an animated style, where the cast stay recognisable as characters.
 */
export const VISUAL_STYLES = {
  human: { label: 'Real people (live action)', look: '' },
  'animated-3d': {
    label: '3D animated film',
    look: 'Stylised 3D animated feature-film look: appealing characters with slightly exaggerated, expressive proportions, smooth sculpted forms, soft global illumination and warm rim light, rich saturated colour, detailed stylised sets.',
  },
  anime: {
    label: 'Anime',
    look: 'Hand-drawn anime look: clean confident line art, cel shading with soft gradients, expressive eyes, richly painted backgrounds, dynamic composition, the polish of a high-end animated film.',
  },
  comic: {
    label: 'Comic book',
    look: 'Comic-book look: bold ink outlines, halftone shading, flat punchy blocks of colour, dramatic graphic framing, kinetic and stylised.',
  },
  clay: {
    label: 'Clay animation',
    look: 'Stop-motion clay animation look: handmade plasticine characters and miniature sets with visible fingerprints and texture, miniature lighting, charming tactile imperfection.',
  },
} as const;
export type VisualStyle = keyof typeof VISUAL_STYLES;
export const VISUAL_STYLE_IDS = Object.keys(VISUAL_STYLES) as [VisualStyle, ...VisualStyle[]];
const animated = (visual: VisualStyle | undefined): boolean => Boolean(visual && visual !== 'human');

/**
 * Lip-synced shots: what kills the performance. A frozen face or a mouth that
 * never opens gives the lip-sync model no "singer" to learn from (it copies the
 * speaker's style from the source video), so the result looks dubbed. Shouted,
 * exaggerated shapes are still out: the model has to redraw them.
 */
export const NEGATIVE_LIP_SYNC =
  'back to camera, facing away from the camera, rear view, turned away, head turned away, side profile, looking down, face hidden, frozen face, expressionless face, botox face, static mouth, clenched jaw, exaggerated mouth shapes, shouting, mouth covered, ';

/** Scene text that asks for the subject to face away (then turning away is allowed). */
const FACES_AWAY = /\b(back to (?:the )?camera|from behind|walks? away|walking away|turns? (?:his|her|their)? ?back|turns? away|over (?:his|her|their) shoulder|rear view|facing away|(?:he|she|they) leaves?|exits? the|walks? (?:out|off)|towards? the (?:door|window|horizon)|silhouette)\b/i;

/**
 * Blocking + continuity for every shot with a person in it. Video models drift: a character turns
 * to face a door, walks off, or someone appears from nowhere. Unless the scene asks for it, the
 * subject faces the camera or the action, and the set stays as described.
 */
export const BLOCKING =
  'Blocking and continuity: the people move and face exactly as the scene describes, turned toward the camera or toward the action they are playing; ' +
  'nobody turns their back to the camera, faces a wall or door, walks away or leaves frame unless the scene says so. ' +
  'Doors, props, furniture and vehicles stay where the scene puts them; nobody appears or vanishes; wardrobe, hair and anything held stay the same for the whole shot.';

/** Extra negatives for a shot with a person in it whose scene doesn't ask them to face away. */
export function facingNegative(scene: string | undefined): string {
  return scene && FACES_AWAY.test(scene) ? '' : 'back to camera, facing away from the camera, walking away, leaving frame, rear view, extra people appearing, ';
}

/**
 * What to keep out. Animated looks drop the "not drawn / not rendered" list; bold and wild camera
 * energy drop the bans on the very moves they ask for (whip pans, crash zooms, dutch angles).
 */
export function negativePrompt(
  lipSync: boolean,
  options: { energy?: CameraEnergy | undefined; visual?: VisualStyle | undefined; /** A person is in the shot: guard their blocking (see BLOCKING). */ subject?: boolean | undefined; scene?: string | undefined } = {},
): string {
  const base = (animated(options.visual) ? '' : NEGATIVE_NOT_REAL) + NEGATIVE_ARTIFACTS + (options.energy && options.energy !== 'natural' ? '' : NEGATIVE_TAME_CAMERA) + NEGATIVE_MOTION;
  // Lip-synced shots already ban every turned-away view; other shots with people get it unless the scene asks.
  const facing = !lipSync && options.subject ? facingNegative(options.scene) : '';
  return (lipSync ? NEGATIVE_LIP_SYNC : '') + facing + base;
}

/**
 * How a singer delivers a line. Each one names what the face actually does
 * (brows, forehead and eye creases, cheeks), because "emotional" alone gives
 * a still face with a mood. KEEP IN SYNC with fe/src/utils/musicVideoApi.ts.
 */
export const PERFORMANCE_EMOTIONS = {
  joyful: 'a real smile reaching the eyes, cheeks lifted, crow’s-feet creases at the eyes, brows lifting on the high notes',
  confident: 'steady gaze into the lens, a slight knowing smile, chin up, one brow lifting on the punchlines',
  playful: 'quick grins, raised brows, eyes flicking to the lens, cheeks bunching on the smiles',
  tender: 'soft eyes, a gentle half-smile, brows slightly raised and relaxed, slow blinks',
  longing: 'brows drawn up in the middle, faint forehead lines, eyes glistening, gaze drifting off and back',
  heartbroken: 'brows pinched and raised, forehead creased, eyes wet and squeezing shut on the long notes, chin trembling slightly',
  defiant: 'brows lowered, jaw set between lines, nostrils flaring on the breaths, a hard direct stare',
  intense: 'furrowed brow with deep forehead lines, eyes squeezing on the high notes, neck tendons and veins showing on the big lines',
  calm: 'relaxed face, unhurried blinks, the faintest smile, brows soft',
} as const;
export type PerformanceEmotion = keyof typeof PERFORMANCE_EMOTIONS;
export const PERFORMANCE_EMOTION_IDS = Object.keys(PERFORMANCE_EMOTIONS) as [PerformanceEmotion, ...PerformanceEmotion[]];

/** 1 subtle · 2 natural · 3 full out. */
const INTENSITY_LINE: Record<1 | 2 | 3, string> = {
  1: 'Understated delivery: small movements, the feeling held back.',
  2: 'Natural delivery, the way a singer actually performs a take: the face works with every phrase.',
  3: 'Full-out delivery: big notes pull the whole face, the head tips back on the high lines, the body leans in.',
};

/**
 * Old scene text asked for "clear / exaggerated mouth movement"; that phrase is
 * dropped (the lip-sync pass draws the words). Singing itself stays: the base
 * video should look like someone singing so the face moves like a singer's.
 */
export function calmPerformance(text: string): string {
  return text.replace(/,?\s*(?:with\s+)?(?:clear|big|exaggerated|wide|open|visible)\s+(?:jaw\s+and\s+)?(?:mouth|lip)\s+(?:movements?|shapes?)/gi, '');
}

export interface PromptInput {
  /** The scene in plain words (director-expanded when available). */
  scene: string;
  shot: Shot;
  /** Overall look / mood the creator gave the whole video. */
  style?: string | undefined;
  /** Written description of the creator, from their photos. */
  identity?: string | undefined;
  featuresSubject: boolean;
  aspect: Aspect;
  /** Music videos: the song under this shot, so movement and camera ride the beat. */
  rhythm?: { bpm: number | null; section: string; energy: number } | undefined;
  /** Music videos: cast background + shoot location ("Lagos, Nigeria; a natural mix of Black and white people"). */
  place?: string | undefined;
  /** Creative mode: sharp, bold camera work. */
  creative?: boolean | undefined;
  /** How hard the camera works (CAMERA_ENERGY); default natural. */
  energy?: CameraEnergy | undefined;
  /** The video's opening shot: built to stop the scroll (HOOK). */
  hook?: boolean | undefined;
  /** The video's look: real people (default) or an animated style (VISUAL_STYLES). */
  visual?: VisualStyle | undefined;
  /** Music video: real-world music-video performance standard. */
  musicVideo?: boolean | undefined;
  /** Lip-synced shot: the subject sings these words to the song. */
  lipSync?: boolean | undefined;
  /** The words sung under this shot (lip-synced shots). */
  lyric?: string | undefined;
  /** Lip-synced shots: how the line is delivered. */
  performance?: { emotion?: PerformanceEmotion | null | undefined; intensity?: number | null | undefined } | undefined;
  /**
   * Reference-conditioned animation: how the prompt names the start frame and each
   * character's identity reference (e.g. "@Image1 is the first frame. @Element1 is Ada…").
   * With references the face comes from them, so the prompt only directs light, place and camera.
   */
  references?: string | undefined;
}

/**
 * Real music-video performance, the way it looks on a real set: the artist
 * owns the moment with small, confident movement, the body rides the groove,
 * light comes from real sources. Nothing theatrical, nothing that reads as AI.
 */
export const SHORT_FILM =
  'Shot like a real, well-made music video on location: the artist performs naturally and with conviction, small confident gestures riding the groove; ' +
  'light comes from real sources in the scene (windows, street lamps, practicals, sun).';

/** Creative mode: still real-world camera work, just more deliberate and musical. */
export const CREATIVE_CAMERA =
  'Camera with intent but no gimmicks: a slow push-in or a gentle drift that lands on the downbeat, an operator reframing by hand, ' +
  'a smooth tracking move that follows the artist; every move motivated by the music and the action, never flashy.';

/** What makes footage feel alive and shot, not generated. */
export const LIFE =
  'The world is alive: background people and traffic move naturally, leaves and fabric stir in the air, reflections shift. ' +
  'Natural cloth physics: creases and folds that move and settle with every step and gesture, hair moving with motion and air. ' +
  'The subject breathes, blinks and shifts weight naturally, with small unplanned micro-expressions; real weight and momentum in every movement.';

/**
 * Lip-synced shots: the footage the lip-sync pass needs.
 *  - A face large enough to carry mouth detail (a mouth a few pixels wide can't show a p, b or m).
 *  - A singer's face, alive: the lip-sync model redraws the mouth but copies the
 *    performer's style (how wide they open, teeth, jaw) from this footage, and the
 *    rest of the face (brows, creases, cheeks) is never touched by it. A held-still
 *    mouth here = a small, dubbed-looking mouth after sync.
 *  - No shouted, exaggerated shapes: they have to be redrawn and smear.
 */
export const LIP_SYNC =
  'Real singing performance shot for lip sync: the face is large in frame (head and shoulders fill at least a third of the frame height), well lit, turned toward the camera ' +
  '(never more than a three-quarter view), mouth fully visible and unobstructed (no microphone, hand, hair or object in front of the lips). ' +
  'The whole face is alive the way a singer’s face is: brows lift and pinch with the phrasing, forehead lines and eye creases form and release, cheeks lift, nostrils flare on the breaths, the throat moves. ' +
  'The mouth opens only as much as the voice in the song does: relaxed and small on conversational or soft lines, wider only on belted, held notes; between phrases it rests or closes. ' +
  'Never a constantly open or gaping mouth, never shapes held for the camera; the tension of the voice (strained, tender, cool, joyful) shows in the jaw, lips and eyes the way it would on a real singer. ' +
  'Head and shoulders move with the phrasing.';

/**
 * Soft passages (humming, low choruses, "ooh"s, cool laid-back lines): a real
 * singer barely opens their mouth. Forcing big shapes here is what makes lip
 * sync look dubbed and AI.
 */
export const LIP_SYNC_SOFT =
  'Real singing performance shot for lip sync, sung softly and effortlessly: the face is large in frame, well lit, turned toward the camera, mouth fully visible and unobstructed. ' +
  'Cool, relaxed delivery: lips part only slightly, small natural mouth movement, closed-mouth humming on the "mm" sounds, the jaw stays loose and mostly still, no wide-open vowels. ' +
  'The feeling is in the eyes, a slow blink, a slight head sway and the breath; calm shoulders, nothing forced.';

/** Hums and vocal sounds ("mmm", "ooh", "ah", "la la", "yeah"): sung with the mouth almost closed. */
const HUM = /^(?:\s*[(\[]?\s*(?:m+h*|h+m+|hm+|o+h+|o{2,}|a+h+|la|na|da|eh+|ay+|yeah+|ye+|wo+|whoa+|uh+|mm+-?hm+)[\s,.!?~\-)\]]*)+$/i;

/**
 * Should this lip-synced shot be sung softly? Hummed / vowel-only lyrics, a
 * low-energy part of the song (quiet verse, low chorus, intro, outro), or a
 * scene directed at intensity 1.
 */
export function softDelivery(input: { lyric?: string | undefined; rhythm?: PromptInput['rhythm']; performance?: PromptInput['performance'] }): boolean {
  const lyric = input.lyric?.replace(/\s*\/\s*/g, ' ').trim() ?? '';
  if (lyric && HUM.test(lyric)) return true;
  if ((input.performance?.intensity ?? 2) <= 1) return true;
  if (input.rhythm && input.rhythm.energy < 0.35 && (input.performance?.intensity ?? 2) < 3) return true;
  return false;
}

const DANCE = /\b(danc\w*|choreograph\w*|twerk\w*|whine|whining|groov\w*|shak\w+ (?:her|his|their) (?:waist|hips)|amapiano|shaku|legwork|zanku|azonto|footwork|two-step)\b/i;
const AERIAL = /\b(aerial|drone|bird'?s[- ]eye|overhead|top[- ]down|helicopter)\b/i;
const PLAYER = /\b(guitar\w*|bass(?:ist| guitar)|piano|pianist|keys|keyboard\w*|drum\w*|percussion\w*|talking drum|conga\w*|djembe|sax\w*|trumpet\w*|horn\w*|violin\w*|cello|kora|flute|band|strum\w*|DJ|turntable\w*)\b/i;

/**
 * Tempo feel: the song's BPM and energy turned into how people move, so a
 * slow song gets slow strums and sways and a fast one gets quick, tight hits.
 * Dancers move on the beat at the song's real tempo; instrument players
 * strum, strike or press in time with it (the classic AI tell is a guitarist
 * strumming double-time over a ballad).
 */
function rhythmLine(rhythm: PromptInput['rhythm'], scene = ''): string {
  if (!rhythm) return '';
  const energy = rhythm.energy >= 0.7 ? 'high energy' : rhythm.energy >= 0.4 ? 'medium energy' : 'low energy, intimate';
  const bpm = rhythm.bpm ?? null;
  const beat = bpm ? ` (a beat every ${(60 / bpm).toFixed(2)} s)` : '';
  const tempo = !bpm ? '' : bpm < 85 ? 'slow' : bpm < 112 ? 'mid-tempo' : 'up-tempo';
  const pace =
    rhythm.energy >= 0.7 ? 'driving body movement, still grounded and natural' : rhythm.energy >= 0.4 ? 'relaxed grooving movement' : 'slow, flowing movement and a still, gentle camera';
  const parts = [
    `Music: ${rhythm.section.toLowerCase()}, ${energy}${bpm ? `, ${bpm} BPM, ${tempo}` : ''}. ${pace}; head nods, shoulder bounces, steps and hand gestures land on the beat${beat}, the way a real artist feels the track, not choreographed for show.`,
  ];
  if (DANCE.test(scene)) {
    parts.push(
      tempo === 'slow'
        ? `Dancers move slowly with the ${bpm} BPM groove: smooth sways, body rolls and weight shifts that resolve on each beat, never fast or frantic.`
        : tempo === 'up-tempo'
          ? `Dancers hit the ${bpm} BPM beat: steps, footwork and arm hits land exactly on the beat${beat}, tight and together, matching the song's speed (never faster).`
          : `Dancers groove in time with the ${bpm ?? 'song’s'} BPM beat${beat}: steps and bounces on the beat, relaxed and together.`,
    );
  }
  if (PLAYER.test(scene)) {
    parts.push(
      tempo === 'slow'
        ? `Instrument players play at the song's slow tempo: slow, sustained strums and soft, unhurried strikes, one motion per beat or slower${beat}; hands never move faster than the music.`
        : tempo === 'up-tempo'
          ? `Instrument players play in time with the fast beat: strums, strikes and key presses land on every beat${beat}, energetic and precise.`
          : `Instrument players play in time with the song${beat}: steady strums and strikes on the beat, hands relaxed and believable.`,
    );
  }
  if (AERIAL.test(scene)) {
    parts.push(
      `The aerial camera moves with the music: it glides steadily between hits, and each move (a rise, a push, a turn) starts on a kick drum or burst in the beat${beat}${rhythm.energy >= 0.7 ? ', with a stronger, faster push on the biggest hit' : ''}; smooth and real, like a drone pilot cutting to the track.`,
    );
  }
  return parts.join(' ');
}

const placeLine = (place: string | undefined): string => (place ? `Cast and place: ${clampText(place, 300)}. Extras, passers-by, signage, streets, interiors and wardrobe belong to this place.` : '');

/** Prompt for the identity-locked still (keyframe) of the scene's first frame. */
export function keyframePrompt(input: PromptInput): string {
  const drawn = animated(input.visual);
  const look = drawn ? VISUAL_STYLES[input.visual!].look : '';
  return fitParts([
    { text: drawn ? `Create a single frame of an animated film, the first frame of this shot, in this look: ${look}` : 'Create a single photorealistic film still: the first frame of this shot.', keep: 0 },
    {
      text: input.featuresSubject
        ? drawn
          ? 'The person in the reference photos is the subject, drawn as a character in this style yet instantly recognisable as that exact person: same face shape, eyes, nose, lips, jawline, skin tone, hairline, hair, body frame and signature features, translated into the style.'
          : 'The person in the reference photos is the subject and must be instantly recognisable as that exact person: same face shape, eyes, nose, lips, jawline, skin tone and skin texture, hairline, hair, body frame, height and proportions. ' +
            'Where the reference photos differ, trust the most natural, unfiltered, least retouched photo for the face and skin. Do not beautify, smooth, slim, age or idealise them; keep every real imperfection (pores, marks, moles, asymmetry, uneven tone).'
        : '',
      keep: 0,
    },
    { text: input.identity ? `Subject details: ${clampText(input.identity, 600)}` : '', keep: 3 },
    { text: `Shot: ${SHOTS[input.shot]}.`, keep: 0 },
    { text: `Scene: ${input.scene}`, keep: 0, scene: true },
    { text: input.style ? `Look and mood: ${clampText(input.style, 300)}.` : '', keep: 0 },
    // The first frame sets who is around the subject and where: the cast mix and location land here.
    { text: placeLine(input.place), keep: 5 },
    {
      text: input.lipSync
        ? `The subject faces the camera (no more than three-quarter view), caught mid-phrase singing ${
            (input.performance?.intensity ?? 2) >= 3 ? 'a strong, open note (mouth open as a real singer’s is on a belted note, not gaping)' : (input.performance?.intensity ?? 2) <= 1 ? 'softly, lips just parted' : 'naturally, lips relaxed and only slightly apart'
          }, mouth unobstructed, face large in frame and evenly lit${
            input.performance?.emotion ? `; expression: ${PERFORMANCE_EMOTIONS[input.performance.emotion]}` : ''
          }.`
        : '',
      keep: 0,
    },
    {
      text: input.hook ? 'The opening frame of the video: a bold, graphic composition with depth and a strong angle that grabs attention at once; the moment is already in motion.' : '',
      keep: 0,
    },
    { text: `Frame for a ${input.aspect} aspect ratio.`, keep: 0 },
    {
      text: drawn
        ? 'The whole frame in that one consistent animated style (characters, sets and light alike), clean and polished, no text or logos.'
        : 'Looks like an untouched frame from real footage: natural available light, true colour, real lens falloff, realistic skin with pores and small blemishes, flyaway hairs, real fabric with creases and lint, an ordinary lived-in background, no retouching, no glow, no text or logos.',
      keep: drawn ? 0 : 1,
    },
  ]);
}

/**
 * Camera language per shot: lens, move and pacing a cinematographer would use,
 * so the model gets a precise, physically plausible camera instead of "cinematic".
 */
export const CAMERA_LANGUAGE: Record<Shot, string> = {
  'aerial-establishing': 'Drone at altitude, 24mm, slow steady forward glide, horizon level, gentle parallax over the landscape.',
  'aerial-orbit': 'Drone slowly circling the subject at a constant radius and height, 35mm, smooth unhurried arc.',
  'aerial-reveal': 'Drone rising slowly from close to the ground to reveal the subject in the wide location, 24mm, one continuous move.',
  'aerial-topdown': "Bird's-eye top-down drone shot, 24mm, slow lateral drift.",
  wide: 'Tripod or very slow push, 28mm, full body in the environment, eye level, real foreground elements.',
  medium: 'Waist-up, 50mm, operator handheld with the faint natural sway of a person holding the camera, eye level.',
  'close-up': 'Close-up on the face, 85mm, soft background, slight handheld float, natural catchlight from the real light source.',
  'extreme-close-up': 'Extreme close-up detail, macro lens, very shallow focus, a small natural focus adjustment.',
  tracking: 'Steadicam following the subject at walking pace, 35mm, steady with a human rhythm, parallax on the background.',
  'dolly-in': 'Slow, barely noticeable push-in toward the subject, 50mm.',
  'dolly-out': 'Slow pull-back from the subject revealing the space, 35mm.',
  crane: 'Gentle jib rise from eye level to a slightly high angle, 28mm, one continuous move.',
  'low-angle': 'Camera a little below eye level looking up, 35mm, held steady, no distortion.',
  handheld: 'Handheld camera, 35mm, organic micro-movement and small reframes, documentary realism.',
  'slow-motion': 'Gentle slow motion (60 fps played at 24), 50mm, fluid natural motion.',
  performance: 'Performance shot, 50-85mm, the artist singing to camera, operator handheld with a slight natural sway, light from a real source on the face.',
  'fpv-dive': 'FPV racing drone, 14mm wide, starts high and dives steeply, skims low and fast over the ground, then pulls up and slows to frame the subject; real speed, slight horizon roll.',
  'fpv-flythrough': 'FPV racing drone, 14mm wide, one continuous fast flight through the real space, threading a gap, banking around the subject, motion blur at the edges.',
  'orbit-360': 'Handheld gimbal orbit, 24mm, one fast complete circle around the subject at chest height, the subject sharp in the centre, background streaking behind.',
  'whip-pan': 'Operator whip pan, 35mm: a fast horizontal snap with heavy directional motion blur that stops precisely framed on the subject.',
  'crash-zoom': 'Zoom lens, 24-200mm: a sudden fast zoom from wide to a tight face shot, slight overshoot and settle, handheld energy.',
  'dutch-angle': 'Dutch angle, 28mm, camera rolled 20-30 degrees, slow drift toward the subject, strong diagonals in the frame.',
  'worms-eye': "Camera on the ground pointing up, 16mm wide, the subject towering above the lens, sky or ceiling behind, slow upward tilt.",
  'overhead-spin': 'Top-down, 24mm, camera directly above the subject, slow continuous rotation of the whole frame.',
  'dolly-zoom': 'Dolly zoom (vertigo): the camera tracks back while zooming in, 24-70mm, the subject the same size, the background stretching away.',
  snorricam: 'Body-mounted rig, 24mm, the camera fixed to the subject facing them: they stay centred and steady while the background swings with every step.',
  'push-through': 'Gimbal, 24mm, a continuous forward move through a foreground gap (glass, fence, fabric, a crowd) that opens onto the subject.',
  'speed-ramp': 'High-frame-rate capture, 35mm: real-time motion that ramps down into smooth slow motion at the peak action, then back up to real time.',
};

/** Kinetic shots: the camera itself is the show. */
export const KINETIC_SHOTS: ReadonlySet<Shot> = new Set(['fpv-dive', 'fpv-flythrough', 'orbit-360', 'whip-pan', 'crash-zoom', 'overhead-spin', 'dolly-zoom', 'push-through', 'speed-ramp']);

/**
 * A lip-synced shot needs the face large, steady and readable for the whole clip (a mouth a few
 * pixels wide, or smeared by motion, can't be synced). A kinetic shot asked for on a lip-synced
 * scene keeps its attitude in a face-safe form: tilted, low, body-mounted or a short push.
 */
export function lipSafeShot(shot: Shot): Shot {
  switch (shot) {
    case 'fpv-dive':
    case 'fpv-flythrough':
    case 'push-through':
      return 'dolly-in';
    case 'orbit-360':
    case 'overhead-spin':
    case 'speed-ramp':
    case 'whip-pan':
    case 'dolly-zoom':
      return 'performance';
    case 'crash-zoom':
    case 'extreme-close-up':
      return 'close-up';
    case 'worms-eye':
      return 'low-angle';
    default:
      return shot;
  }
}

/**
 * How hard the camera works. natural = the restrained real-life look; bold = a motivated move on
 * every shot and striking angles on the big moments; wild = full music-video energy. The picture
 * itself (real light, real skin, real places) stays photoreal at every level.
 */
export const CAMERA_ENERGY = {
  natural: '',
  bold:
    'Camera with attitude: the shot has a clear, motivated move (a push, an orbit, a rise, a fast track) that lands on the beat, a strong composition with foreground layers and depth, ' +
    'a striking angle when the moment is big; the frame is never static or flat. Still real lenses, real physics, real light.',
  wild:
    'Full-energy music-video camera: kinetic, daring moves (FPV dives and fly-throughs, fast orbits, whip pans, crash zooms, tilted and extreme low or top-down angles, speed ramps) ' +
    'that dance with the artist and hit the beat, foreground objects wiping across the lens; every frame bold and graphic, yet real lenses, real physics, real light and real people.',
} as const;
export type CameraEnergy = keyof typeof CAMERA_ENERGY;

/** Bold / wild energy on a lip-synced shot: attitude in the framing, never in a moving, blurred face. */
export const FACE_SAFE_ENERGY =
  'Performance with attitude: a striking angle (low, tilted or tight) and a confident slow push or drift, the artist owning the lens; ' +
  'the face stays large, steady and sharp for the whole shot, no fast moves, no motion blur on the face.';
export const CAMERA_ENERGY_IDS = Object.keys(CAMERA_ENERGY) as [CameraEnergy, ...CameraEnergy[]];

/** The opening shot: it has one second to stop a viewer scrolling. */
export const HOOK =
  'This is the opening shot and must stop the viewer in the first second: the action and the camera are already moving at frame 1, one striking, unexpected image (a bold angle, ' +
  'a sudden move, eyes straight to the lens), no slow fade-in, no empty establishing beat.';

/** Picture quality cues a colourist and DP would sign off on, kept restrained. */
export const GRADE =
  'Natural, restrained colour: real skin tones, soft contrast, highlights that roll off gently, shadows with detail; ' +
  'looks graded by a careful colourist, not filtered; no bloom, no glow, no artificial haze.';

/**
 * Video models cap the prompt (Kling: 2500 chars). Stay under it with headroom
 * so the scene the creator wrote is never what gets cut.
 */
export const PROMPT_BUDGET = 2400;

/** Cut text to `max` chars on a word boundary. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}.`;
}

/**
 * Join prompt parts within `budget`. Each part has a priority; the
 * lowest-priority parts are dropped first, and only if the essentials alone are
 * still too long is the scene itself shortened.
 */
function fitParts(parts: { text: string; keep: number; scene?: boolean }[], budget = PROMPT_BUDGET): string {
  const live = parts.filter((part) => part.text);
  const length = (): number => live.reduce((sum, part) => sum + part.text.length + 1, -1);
  const optional = live.filter((part) => part.keep > 0).sort((a, b) => a.keep - b.keep);
  for (const part of optional) {
    if (length() <= budget) break;
    live.splice(live.indexOf(part), 1);
  }
  const over = length() - budget;
  if (over > 0) {
    const scene = live.find((part) => part.scene) ?? live.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    scene.text = clampText(scene.text, Math.max(200, scene.text.length - over));
  }
  return clampText(live.map((part) => part.text).join(' '), budget);
}

/** Prompt for the video model (animating the keyframe, or text-only for scenes without the creator). */
export function motionPrompt(input: PromptInput): string {
  // keep: 0 = essential; higher numbers survive longer when trimming.
  // The scene is the director's 50-110 words; anything far longer is capped so the realism,
  // stability and lip-sync guidance always fit alongside it.
  const scene = input.lipSync ? calmPerformance(input.scene) : input.scene;
  const soft = Boolean(input.lipSync && softDelivery(input));
  return fitParts([
    { text: input.references ?? '', keep: 0 },
    { text: `${SHOTS[input.shot]}.`, keep: 0 },
    // A kinetic shot IS its camera move: its precise lens and move language outlasts the boilerplate.
    { text: CAMERA_LANGUAGE[input.shot] ?? '', keep: KINETIC_SHOTS.has(input.shot) || input.energy === 'wild' ? 10 : 5 },
    { text: clampText(scene, 900), keep: 0, scene: true },
    { text: input.style ? `Mood and look: ${clampText(input.style, 200)}.` : '', keep: 0 },
    {
      text: input.featuresSubject
        ? input.references
          ? 'Faces, bone structure, skin and hair come only from the references and never change; this prompt directs only the light, the place, the wardrobe movement and the camera.'
          : 'The subject keeps exactly the same face, hair, body and wardrobe from the first frame to the last; natural, physically plausible movement.'
        : '',
      keep: 0,
    },
    { text: input.lipSync ? (soft ? LIP_SYNC_SOFT : LIP_SYNC) : '', keep: 0 },
    // People in shot: they face and move as written, and the set stays put (no turning to the door, no walking off).
    { text: input.featuresSubject || input.lipSync ? BLOCKING : '', keep: 0 },
    {
      // The emotion, as what the face does, plus how far to take it.
      text: input.lipSync
        ? [
            input.performance?.emotion ? `Delivery: ${input.performance.emotion}: ${PERFORMANCE_EMOTIONS[input.performance.emotion]}.` : '',
            soft ? INTENSITY_LINE[1] : INTENSITY_LINE[(Math.min(3, Math.max(1, input.performance?.intensity ?? 2)) as 1 | 2 | 3)],
          ]
            .filter(Boolean)
            .join(' ')
        : '',
      keep: 0,
    },
    {
      text:
        input.lipSync && input.lyric
          ? soft
            ? `They sing "${clampText(input.lyric, 200)}" softly, almost under their breath, mouth barely opening.`
            : `They sing "${clampText(input.lyric, 200)}", and the stressed words land on the face: brows, eyes and jaw.`
          : '',
      keep: 9,
    },
    {
      // Story / atmosphere shots still answer the words heard under them, without anyone mouthing them.
      text:
        !input.lipSync && input.musicVideo && input.lyric
          ? `Heard over this shot: "${clampText(input.lyric, 180)}". The action, expressions and body language show what these words are about; nobody on screen sings or mouths words.`
          : '',
      keep: 9,
    },
    { text: input.featuresSubject ? STABILITY : '', keep: 8 },
    // Animated looks: the style replaces the live-action realism (and must never be trimmed away).
    {
      text: animated(input.visual)
        ? `${VISUAL_STYLES[input.visual!].look} Every frame keeps that one style; characters stay recognisable as the people in the references, with believable weight and acting.`
        : REALISM,
      keep: animated(input.visual) ? 0 : 7,
    },
    { text: rhythmLine(input.rhythm, input.scene), keep: 6 },
    { text: placeLine(input.place), keep: 6 },
    { text: input.musicVideo ? SHORT_FILM : '', keep: 4 },
    { text: LIFE, keep: 3 },
    { text: input.creative && !input.energy ? CREATIVE_CAMERA : '', keep: 2 },
    // The camera's energy outranks the realism boilerplate: it is what makes the shot.
    // Lip-synced shots get the energy in a face-safe form: the mouth has to stay sharp for the sync.
    { text: input.energy && input.energy !== 'natural' ? (input.lipSync ? FACE_SAFE_ENERGY : CAMERA_ENERGY[input.energy]) : '', keep: 8 },
    { text: input.hook ? HOOK : '', keep: 0 },
    { text: 'One continuous shot, no cuts, no morphing.', keep: 0 },
    { text: animated(input.visual) ? '' : GRADE, keep: 1 },
  ]);
}
