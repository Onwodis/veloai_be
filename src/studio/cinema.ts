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

export const NEGATIVE =
  'cgi, 3d render, video game, cartoon, anime, illustration, painting, plastic skin, waxy skin, airbrushed, over-smoothed, beauty filter, porcelain skin, perfect symmetrical face, glamour retouch, ' +
  'uncanny, distorted face, asymmetrical eyes, extra fingers, fused fingers, deformed hands, extra limbs, morphing, warping, melting, face smearing during head turn, warped profile, ' +
  'flickering teeth, blurry mouth, mouth artifacts, rubbery lips, flicker, jitter, identity drift, face swap artifacts, text, subtitles, watermark, logo, ' +
  'oversaturated, overexposed, heavy bloom, glowing light, lens flare overload, excessive haze, neon overload, teal-orange grade, HDR look, blurry, low quality, ' +
  'static background, frozen background, still crowd, mannequin, stiff fabric, painted-on clothes, plastic clothing, ai-generated look, epic cinematic look, ' +
  'whip pan, crash zoom, dutch angle, spinning camera, slow-motion when not asked, floaty movement, sliding feet';

/**
 * Lip-synced shots: what kills the performance. A frozen face or a mouth that
 * never opens gives the lip-sync model no "singer" to learn from (it copies the
 * speaker's style from the source video), so the result looks dubbed. Shouted,
 * exaggerated shapes are still out: the model has to redraw them.
 */
export const NEGATIVE_LIP_SYNC = 'frozen face, expressionless face, botox face, static mouth, clenched jaw, exaggerated mouth shapes, shouting, mouth covered, ';

export function negativePrompt(lipSync: boolean): string {
  return lipSync ? NEGATIVE_LIP_SYNC + NEGATIVE : NEGATIVE;
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
  /** Creative mode: sharp, bold camera work. */
  creative?: boolean | undefined;
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
  'The mouth sings naturally: the jaw drops open on long vowels with teeth and tongue visible, lips press together and release, corners stretch wide on bright vowels, never shouted or exaggerated. ' +
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

function rhythmLine(rhythm: PromptInput['rhythm']): string {
  if (!rhythm) return '';
  const energy = rhythm.energy >= 0.7 ? 'high energy' : rhythm.energy >= 0.4 ? 'medium energy' : 'low energy, intimate';
  const pace =
    rhythm.energy >= 0.7 ? 'driving body movement, still grounded and natural' : rhythm.energy >= 0.4 ? 'relaxed grooving movement' : 'slow, flowing movement and a still, gentle camera';
  return `Music: ${rhythm.section.toLowerCase()}, ${energy}${rhythm.bpm ? `, ${rhythm.bpm} BPM` : ''}. ${pace}; head nods, shoulder bounces, steps and hand gestures land on the beat${rhythm.bpm ? ` (a beat every ${(60 / rhythm.bpm).toFixed(2)} s)` : ''}, the way a real artist feels the track, not choreographed for show.`;
}

/** Prompt for the identity-locked still (keyframe) of the scene's first frame. */
export function keyframePrompt(input: PromptInput): string {
  return fitParts([
    { text: 'Create a single photorealistic film still: the first frame of this shot.', keep: 0 },
    {
      text: input.featuresSubject
        ? 'The person in the reference photos is the subject and must be instantly recognisable as that exact person: same face shape, eyes, nose, lips, jawline, skin tone and skin texture, hairline, hair, body frame, height and proportions. ' +
          'Where the reference photos differ, trust the most natural, unfiltered, least retouched photo for the face and skin. Do not beautify, smooth, slim, age or idealise them; keep every real imperfection (pores, marks, moles, asymmetry, uneven tone).'
        : '',
      keep: 0,
    },
    { text: input.identity ? `Subject details: ${clampText(input.identity, 600)}` : '', keep: 3 },
    { text: `Shot: ${SHOTS[input.shot]}.`, keep: 0 },
    { text: `Scene: ${input.scene}`, keep: 0, scene: true },
    { text: input.style ? `Look and mood: ${clampText(input.style, 300)}.` : '', keep: 0 },
    {
      text: input.lipSync
        ? `The subject faces the camera (no more than three-quarter view), caught mid-phrase with the mouth naturally open on a vowel and teeth visible, mouth unobstructed, face large in frame and evenly lit${
            input.performance?.emotion ? `; expression: ${PERFORMANCE_EMOTIONS[input.performance.emotion]}` : ''
          }.`
        : '',
      keep: 0,
    },
    { text: `Frame for a ${input.aspect} aspect ratio.`, keep: 0 },
    {
      text: 'Looks like an untouched frame from real footage: natural available light, true colour, real lens falloff, realistic skin with pores and small blemishes, flyaway hairs, real fabric with creases and lint, an ordinary lived-in background, no retouching, no glow, no text or logos.',
      keep: 1,
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
};

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
    { text: CAMERA_LANGUAGE[input.shot] ?? '', keep: 5 },
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
    { text: REALISM, keep: 7 },
    { text: rhythmLine(input.rhythm), keep: 6 },
    { text: input.musicVideo ? SHORT_FILM : '', keep: 4 },
    { text: LIFE, keep: 3 },
    { text: input.creative ? CREATIVE_CAMERA : '', keep: 2 },
    { text: 'One continuous shot, no cuts, no morphing.', keep: 0 },
    { text: GRADE, keep: 1 },
  ]);
}
