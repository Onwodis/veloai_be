/**
 * The cold open: a short film VeloBot directs to play BEFORE the song, the
 * way big music videos open on a scene (a phone call, a memory, a street at
 * night) before the beat drops. It does not act out the scenes: it sets the
 * story up.
 *
 *   plan     VeloBot writes 2-5 shots (3-8 s each, 10-45 s in all): what the
 *            camera sees, the voice-over line, an on-screen text (place /
 *            year / a quote) and a film effect per shot, a narrator voice and
 *            a sound bed. The artist edits anything.
 *   film     each shot: an identity-locked first frame of the cast in it
 *            (same keyframe model as the takes), animated by the image-to-
 *            video model (text-to-video when nobody is in it); the voice-over
 *            by text to speech.
 *   render   shots cut to length, framed, effects applied, the on-screen text
 *            typed in, the voice-over placed on each shot with a bed under it
 *            (the song's intro muffled "through a wall", room tone, or
 *            silence), faded in and out, watermarked like every video.
 *   master   the clip plays first, before any titles on black and the song.
 * Tokens: the plan like a storyboard; the film is held up front (keyframes +
 * video seconds + voice) and only what was made is charged.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ffmpeg, mediaDuration, probe, canBurnSubtitles, subtitlesFilter } from '../media/ffmpeg.js';
import { projectWatermarked, WATERMARK_FILE, watermarkFilters } from '../media/watermark.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { deleteObject, downloadToFile, headObject, keys, listObjects, readUrl, uploadFile } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { ASPECTS, keyframePrompt, motionPrompt, NEGATIVE_LIP_SYNC, negativePrompt, SHOT_IDS, type PromptInput, type Shot } from '../studio/cinema.js';
import { lipSyncInput, vocalStem } from '../studio/lipsync.js';
import { parse } from '../studio/director.js';
import * as fal from '../studio/fal.js';
import { conformImage, downloadUrl, thumbnail } from '../studio/files.js';
import { getStudioSettings, pickDuration } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { AssetRow } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { ENGINE_NAME } from '../utils/engineName.js';
import { logger } from '../utils/logger.js';
import type { CharacterRow } from './cast.js';
import { contextText } from './director.js';
import { access, charged, directorContext, load } from './service.js';
import { assHeader, TEXT_TEMPLATE_IDS, templateStyle, textEvent, textStyleSchema, type TextStyle } from '../media/textfx.js';

/* ------------------------------------------------------------------ the plan */

export const EFFECTS = {
  none: 'Clean, no effect',
  'film-burn': 'Old film: warm flicker, grain, a burn-in from white',
  'slow-push': 'A slow push-in on the frame',
  'flash-cut': 'Flash cut: in and out through white',
  glitch: 'Digital glitch: colour split and noise',
  'light-leak': 'Warm light leak across the frame',
  'black-white': 'Black and white, a touch of contrast',
  vhs: 'VHS home video: noise, colour bleed',
  'dream-blur': 'Dreamy soft focus (a memory)',
  letterbox: 'Wide letterbox bars',
} as const;
export type Effect = keyof typeof EFFECTS;
const EFFECT_IDS = Object.keys(EFFECTS) as [Effect, ...Effect[]];

export const NARRATORS = {
  'deep-male': { label: 'Deep male narrator', voice: 'Brian', gender: 'male' },
  'warm-female': { label: 'Warm female narrator', voice: 'Charlotte', gender: 'female' },
  'young-male': { label: 'Young man', voice: 'Liam', gender: 'male' },
  'young-female': { label: 'Young woman', voice: 'Jessica', gender: 'female' },
  elder: { label: 'Older voice', voice: 'Bill', gender: 'male' },
  soft: { label: 'Soft, close whisper', voice: 'Lily', gender: 'female' },
} as const;
export type Narrator = keyof typeof NARRATORS;
const NARRATOR_IDS = Object.keys(NARRATORS) as [Narrator, ...Narrator[]];
/** A speaker's voice: the artist's own (cloned from the song's vocal) or a library preset. */
const VOICE_IDS = ['artist', ...NARRATOR_IDS] as const;
export type VoiceChoice = (typeof VOICE_IDS)[number];

export const BEDS = { 'song-muffled': 'The song’s opening, muffled as if through a wall', 'room-tone': 'Quiet room tone', silence: 'Silence (voice only)' } as const;
export type Bed = keyof typeof BEDS;

export const shotSchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  seconds: z.number().min(3).max(8),
  narration: z.string().trim().max(240),
  prompt: z.string().trim().min(10).max(1200),
  shot: z.enum(SHOT_IDS),
  characterIds: z.array(z.uuid()).max(4),
  effect: z.enum(EFFECT_IDS),
  text: z.string().trim().max(80),
  /** The filmed clip of this shot (kept, so an unchanged shot is never paid for twice) and what it was filmed from. */
  clipKey: z.string().max(600).optional(),
  clipFor: z.string().max(64).optional(),
  /** The recorded voice-over line, and what it was recorded from (narration + narrator). */
  voiceKey: z.string().max(600).optional(),
  voiceFor: z.string().max(64).optional(),
  /**
   * Who says the line: the unseen narrator, or a cast member in the shot (on camera,
   * lip-synced to their recorded line).
   */
  speaker: z.union([z.literal('narrator'), z.uuid()]).optional(),
  /** Lengths of the filmed clip and the recorded line (a speaking shot runs as long as its line). */
  clipSec: z.number().min(0).max(60).optional(),
  voiceSec: z.number().min(0).max(60).optional(),
  /** The lip-synced clip of a speaking shot, and what it was made from (clip + line). */
  syncKey: z.string().max(600).optional(),
  syncFor: z.string().max(64).optional(),
});
export const planSchema = z.strictObject({
  logline: z.string().trim().max(400),
  narrator: z.enum(NARRATOR_IDS),
  bed: z.enum(['song-muffled', 'room-tone', 'silence']),
  shots: z.array(shotSchema).min(1).max(8),
  /** One place, time and look shared by every shot (continuity: same room, light, clothes, props). */
  setting: z.string().trim().max(800).optional(),
  /** How the voices should sound ("Nigerian (Lagos) English with Pidgin"): picks accented library voices. */
  accent: z.string().trim().max(120).optional(),
  /** Each speaker's voice ("narrator" or a character id → the artist's own voice or a library preset). */
  voices: z.record(z.string().max(40), z.enum(VOICE_IDS)).optional(),
  /** Narrator lines left out (neither recorded nor mixed); the cast's on-camera lines stay. */
  muteNarrator: z.boolean().optional(),
  /** The cold open plays with no sound at all. */
  muteAll: z.boolean().optional(),
  /** What the current film was mixed from: a different value means the shots changed since. */
  mixedFor: z.string().max(64).optional(),
  /** The on-screen text's template (media/textfx.ts; typewriter by default) and the artist's own look over it. */
  textTemplate: z.enum(TEXT_TEMPLATE_IDS).optional(),
  textLook: textStyleSchema.optional(),
});

type PlanShot = z.infer<typeof shotSchema>;
export type ProloguePlan = z.infer<typeof planSchema>;
const digest = (value: unknown): string => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 24);

/** A cast member in the shot says its line on camera (lip-synced); otherwise the narrator does, unseen. */
export const isSpeaking = (shot: Pick<PlanShot, 'speaker' | 'characterIds'>): boolean =>
  Boolean(shot.speaker && shot.speaker !== 'narrator' && shot.characterIds.includes(shot.speaker));

/**
 * What a shot's picture is made from (effect and on-screen text are added at render: changing
 * them is free). The setting and the speaker only join when set, so older clips stay valid.
 */
export function visualFor(shot: Pick<PlanShot, 'prompt' | 'shot' | 'characterIds' | 'seconds' | 'speaker'>, setting = ''): string {
  const parts: unknown[] = [shot.prompt.trim(), shot.shot, [...shot.characterIds].sort(), Math.ceil(shot.seconds)];
  if (setting.trim()) parts.push(setting.trim());
  if (isSpeaking(shot)) parts.push(`talk:${shot.speaker}`);
  return digest(parts);
}
/** What a recorded line is made from: the words and the voice that says them. */
export function voiceFor(shot: Pick<PlanShot, 'narration'>, voice: string): string {
  return digest([shot.narration.trim(), voice]);
}
/** What a lip-synced clip is made from. */
const syncFor = (shot: Pick<PlanShot, 'clipKey' | 'voiceKey'>): string => digest([shot.clipKey ?? '', shot.voiceKey ?? '']);

/** The speaker of a shot's line: "narrator", or the cast member's id. */
const speakerOf = (shot: PlanShot): string => (isSpeaking(shot) ? shot.speaker! : 'narrator');

/** A speaker's voice: the plan's choice, else the narrator preset, the artist's own voice for the artist, a preset by gender. */
export function voiceChoice(plan: Pick<ProloguePlan, 'voices' | 'narrator'>, speaker: string, cast: Pick<CharacterRow, 'id' | 'isArtist' | 'role' | 'attributes'>[]): VoiceChoice {
  const chosen = plan.voices?.[speaker];
  if (chosen) return chosen;
  if (speaker === 'narrator') return plan.narrator;
  const person = cast.find((item) => item.id === speaker);
  if (person?.isArtist || person?.role === 'LEAD') return 'artist';
  return /female|woman|girl|lady/i.test(person?.attributes?.gender ?? '') ? 'young-female' : 'young-male';
}
/**
 * The voice identity a line is recorded with. The narrator's preset alone (as before), so
 * lines recorded before voices could be chosen are still reused.
 */
const voiceIdentity = (plan: ProloguePlan, shot: PlanShot, cast: CharacterRow[]): string => {
  const speaker = speakerOf(shot);
  const choice = voiceChoice(plan, speaker, cast);
  return speaker === 'narrator' ? choice : `${speaker}:${choice}`;
};
/** Is this line recorded at all? Narrator lines are skipped while the narrator is muted. */
const hasLine = (plan: ProloguePlan, shot: PlanShot): boolean => Boolean(shot.narration.trim()) && (isSpeaking(shot) || !plan.muteNarrator);
const needsVoice = (plan: ProloguePlan, shot: PlanShot, cast: CharacterRow[], force: ReadonlySet<string>): boolean =>
  hasLine(plan, shot) && (force.has(shot.id) || !shot.voiceKey || shot.voiceFor !== voiceFor(shot, voiceIdentity(plan, shot, cast)));
/** A speaking shot is re-filmed when its (new) line no longer fits the clip. */
const needsClip = (plan: ProloguePlan, shot: PlanShot, force: ReadonlySet<string>): boolean =>
  force.has(shot.id) ||
  !shot.clipKey ||
  shot.clipFor !== visualFor(shot, plan.setting) ||
  (isSpeaking(shot) && shot.voiceSec !== undefined && shot.clipSec !== undefined && shot.voiceSec + SPEECH_LEAD + 0.2 > shot.clipSec);
const needsSync = (shot: PlanShot, force: ReadonlySet<string>): boolean => isSpeaking(shot) && (force.has(shot.id) || !shot.syncKey || shot.syncFor !== syncFor(shot));
/**
 * Nothing forced. A re-film forces only the picture (the line you liked is kept); a new take of a
 * line (voiceOnly) forces only the line.
 */
const NO_FORCE: ReadonlySet<string> = new Set();
/** A spoken line starts this far into its shot (the lip-synced audio is built with the same lead). */
const SPEECH_LEAD = 0.3;
/** Length of a shot in the film: a speaking shot holds until its line is said. */
const shotLength = (shot: PlanShot): number => (isSpeaking(shot) && shot.voiceSec ? Math.max(shot.seconds, shot.voiceSec + SPEECH_LEAD + 0.4) : shot.seconds);
/** What the film is mixed from: when this changes, the film is older than the shots. */
export const mixFor = (plan: ProloguePlan): string =>
  digest([
    plan.shots.map((shot) => [isSpeaking(shot) ? shot.syncKey : shot.clipKey, hasLine(plan, shot) ? shot.voiceKey : null, shot.text.trim(), shot.effect, shot.seconds]),
    plan.bed,
    Boolean(plan.muteNarrator),
    Boolean(plan.muteAll),
    textLookOf(plan),
  ]);

/** The look of the cold open's on-screen text: the artist's own, else the template's (typewriter by default). */
export const textLookOf = (plan: Pick<ProloguePlan, 'textTemplate' | 'textLook'>): TextStyle => plan.textLook ?? templateStyle(plan.textTemplate ?? 'typewriter');

export const PlanSchema = z.object({
  logline: z.string().describe('One sentence: the story the cold open sets up'),
  setting: z
    .string()
    .describe('ONE place and moment the whole cold open happens in, 25-60 words: the location, time of day and light, who is there and what each wears, the key props. Every shot happens here, continuously.'),
  narrator: z.enum(NARRATOR_IDS).describe('The narrator voice that suits the story and the artist (used for lines nobody on screen says)'),
  bed: z.enum(['song-muffled', 'room-tone', 'silence']).describe('Sound under the voice'),
  shots: z
    .array(
      z.object({
        seconds: z.number().describe('3-8 s on screen'),
        narration: z.string().describe('The line spoken on this shot, at most about 2.3 words per second of the shot; empty for a silent beat'),
        speakerIndex: z
          .number()
          .int()
          .describe('Who says the line: the index (C0 → 0, C1 → 1…) of a cast member IN this shot, who says it on camera to someone or to the camera (lip-synced); -1 for the unseen narrator'),
        prompt: z
          .string()
          .describe(
            "What the camera sees, written like a DP: ONE simple, everyday, physically real action (nothing a real person would not do), the place from the setting, real light, wardrobe, subtle camera. 40-90 words. Name who is in frame and where they face; their faces are visible (front or three-quarter, never their back to the camera). Nobody sings. If a cast member speaks the line, they say it here, face to camera or to the other person; otherwise nobody talks. Describe faces only by expression (identity comes from the cast's photos).",
          ),
        shot: z.enum(SHOT_IDS),
        characterIndexes: z.array(z.number().int()).describe('Indexes (C0, C1…) of the cast in the shot; empty for places and details'),
        effect: z.enum(EFFECT_IDS).describe(`One per shot, used with taste: ${Object.entries(EFFECTS).map(([id, text]) => `${id} (${text})`).join('; ')}`),
        text: z.string().describe('Short on-screen text typed in on this shot (a place and year like "LAGOS, 2009", a time, a quote), or empty. Use on 1-2 shots at most.'),
      }),
    )
    .describe('2-5 shots'),
});

/** Cast on screen never speak: the narrator is heard, never seen talking. */
const OFF_SCREEN_VOICE = 'Nobody on screen talks, sings or mouths words: lips closed or relaxed at rest, the person listens, thinks, looks or moves in silence.';
const NEGATIVE_TALKING = 'talking, speaking, moving lips, mouth movement, open mouth, lip flapping, ';

const SYSTEM = (seconds: number): string =>
  'You are a music-video director writing the COLD OPEN: a short film that plays before the song starts, the way great music videos open on a scene before the beat. ' +
  'It does not act out the video; it sets up the story or the world (a phone call, a memory, a street at night, a letter being read, the moment before everything changes) and hands over to the song with a question or a feeling. ' +
  `Aim for about ${seconds} seconds over 2-5 shots. ` +
  'It must make sense as one real scene: ONE place, ONE continuous moment (write it as the setting), the same people in the same clothes with the same props from shot to shot, each shot following from the one before like coverage of a single scene. ' +
  'Only plain, everyday, physically real actions a camera could film tomorrow: people use things the normal way (drink from a glass, eat rice with a spoon or hand, answer a phone); nothing absurd, surreal or symbolic-but-strange. ' +
  'Nobody walks in or out, and no extra people appear, unless the story needs exactly that; never more people than the cast you put in the shot. The cast face the camera or each other with their faces visible, never with their backs to the lens. ' +
  'The words: short, spoken, specific lines in the artist\'s own language, slang and accent (Pidgin when the song uses Pidgin), never cheesy. A line is either said ON CAMERA by a cast member in that shot (set speakerIndex; they say it to the other person or to the camera, and it is lip-synced) or by the unseen narrator (speakerIndex -1, and then nobody on screen talks). Prefer the cast speaking when the scene is a conversation or a moment to camera. Leave a shot silent when the picture says enough. ' +
  'Pick one film effect per shot with taste (most shots clean or one consistent look; a flash or glitch only on a turn). Real places, real light, the cast from their photos. ' +
  'Never sexual, never minors in danger, no real people named.';

/** The director call itself (no charge, no save): exported so it can be checked on a real project. */
export function draftPrologue(context: Awaited<ReturnType<typeof directorContext>>, idea: string | undefined, seconds: number) {
  return parse('music-video', PlanSchema, SYSTEM(seconds), [
    { type: 'text', text: `${contextText(context)}\n\n<cold_open_idea>${idea?.trim() || 'Your call: what opening would make this video unforgettable?'}</cold_open_idea>` },
  ]);
}

/** VeloBot writes the cold open. */
export async function planPrologue(auth: AuthContext, workspaceId: string, projectId: string, input: { idea?: string | undefined; seconds: number }) {
  await access(auth, workspaceId, true);
  const { project, mv } = await load(workspaceId, projectId);
  const context = await directorContext(project, mv);
  const seconds = Math.max(10, Math.min(45, input.seconds));
  const { costs } = await getStudioSettings();
  const { data } = await charged(auth, workspaceId, projectId, 'MV_STORYBOARD', costs.mvStoryboard, `Music video · ${project.title.slice(0, 50)}: cold open plan`, () =>
    draftPrologue(context, input.idea, seconds),
  );
  // The voices should sound like the song: its accent picks accented library voices.
  const [song] = await sql<{ accent: string | null }[]>`SELECT lyrics -> 'voice' ->> 'accent' AS accent FROM mv_projects WHERE project_id = ${projectId}`;
  const plan: ProloguePlan = {
    logline: data.logline.slice(0, 400),
    setting: data.setting.trim().slice(0, 800),
    ...(song?.accent?.trim() ? { accent: song.accent.trim().slice(0, 120) } : {}),
    narrator: data.narrator,
    bed: data.bed,
    shots: data.shots.slice(0, 5).map((shot) => {
      const characterIds = [...new Set(shot.characterIndexes)].flatMap((index) => (context.characters[index] ? [context.characters[index]!.id] : [])).slice(0, 4);
      const speaker = context.characters[shot.speakerIndex]?.id;
      return {
        id: randomUUID().slice(0, 8),
        seconds: Math.max(3, Math.min(8, Math.round(shot.seconds * 2) / 2)),
        narration: shot.narration.slice(0, 240),
        speaker: speaker && characterIds.includes(speaker) ? speaker : 'narrator',
        prompt: shot.prompt.slice(0, 1200),
        shot: shot.shot,
        characterIds,
        effect: shot.effect,
        text: shot.text.slice(0, 80),
      };
    }),
  };
  await sql`
    INSERT INTO mv_prologues (project_id, workspace_id, plan, status, step, progress, error)
    VALUES (${projectId}, ${workspaceId}, ${json(plan)}, 'DRAFT', '', 0, NULL)
    ON CONFLICT (project_id) DO UPDATE SET plan = EXCLUDED.plan, status = CASE WHEN mv_prologues.status = 'FILMING' THEN mv_prologues.status ELSE 'DRAFT' END, error = NULL, updated_at = now()`;
  return prologueView(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ view + edits */

type ShotState = 'kept' | 'waiting' | 'frame' | 'animating' | 'done' | 'failed' | 'skipped';
interface ShotStatus {
  clip?: ShotState;
  voice?: ShotState;
  /** When the current state started (ISO). */
  at?: string;
}

interface PrologueRow {
  projectId: string;
  plan: Partial<ProloguePlan>;
  enabled: boolean;
  status: 'DRAFT' | 'FILMING' | 'PAUSED' | 'STOPPED' | 'READY' | 'FAILED';
  control: 'RUN' | 'PAUSE' | 'STOP';
  reservationId: string | null;
  spent: number;
  shotStatus: Record<string, ShotStatus>;
  startedAt: Date | null;
  workspaceId: string;
  step: string;
  progress: number;
  error: string | null;
  outputKey: string | null;
  thumbKey: string | null;
  durationSec: number | null;
  tokens: number;
  updatedAt: Date;
}

/** Tokens to film the plan (held up front; only what is made is charged). */
async function filmCost(plan: ProloguePlan, cast: CharacterRow[], force: Set<string> = new Set(), scope: { only?: Set<string> | null; voiceOnly?: boolean } = {}): Promise<number> {
  const { costs } = await getStudioSettings();
  // Only what has to be (re)made: kept clips, voice lines and lip syncs cost nothing.
  let total = 0;
  for (const shot of plan.shots) {
    if (scope.only && !scope.only.has(shot.id)) continue;
    const voiced = needsVoice(plan, shot, cast, scope.voiceOnly ? force : NO_FORCE);
    const lineSec = voiced ? Math.max(1, Math.ceil(shot.narration.trim().split(/\s+/).length / 2.5)) : (shot.voiceSec ?? 0);
    if (voiced) total += lineSec * costs.ttsPerSecond;
    if (scope.voiceOnly) continue;
    const speaking = isSpeaking(shot) && hasLine(plan, shot);
    const length = speaking ? Math.max(shot.seconds, lineSec + SPEECH_LEAD + 0.4) : shot.seconds;
    const filmed = needsClip(plan, shot, force);
    if (filmed) total += (shot.characterIds.length ? costs.keyframe : 0) + Math.ceil(Math.max(5, length)) * costs.videoPerSecond;
    if (speaking && (filmed || voiced || needsSync(shot, force))) total += Math.ceil(Math.max(5, length)) * costs.lipSyncPerSecond;
  }
  return total;
}

/** Cast of the project (voices and speakers are resolved against it). */
const castOf = (projectId: string): Promise<CharacterRow[]> => sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId}`;

/** Admin voice mapping of the TTS model (keys lower-cased). */
function voiceMapping(extra: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries((extra['voices'] ?? {}) as Record<string, string>).map(([key, value]) => [key.trim().toLowerCase(), value]));
}
/** "Nigerian (Lagos) English with Pidgin" → "nigerian". */
const accentKey = (accent: string | undefined): string => accent?.toLowerCase().match(/[a-z]+/)?.[0] ?? '';
/** A library preset's voice id: accented mapping first, then the preset mapping, then the stock voice. */
function libraryVoice(preset: Narrator, accent: string | undefined, mapping: Record<string, string>): { voice: string; accented: boolean } {
  const key = accentKey(accent);
  const gender = NARRATORS[preset].gender;
  for (const candidate of key ? [`${key} ${preset}`, `${key} ${gender}`, key] : []) if (mapping[candidate]) return { voice: mapping[candidate], accented: true };
  return { voice: mapping[preset] ?? mapping['narrator'] ?? NARRATORS[preset].voice, accented: false };
}

export async function prologueView(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, false);
  await load(workspaceId, projectId);
  const [row] = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE project_id = ${projectId}`;
  const { costs, models } = await getStudioSettings();
  if (!row) return { prologue: null, costs: { plan: costs.mvStoryboard } };
  const plan = planSchema.safeParse(row.plan);
  const cast = await castOf(projectId);
  const mapping = voiceMapping(models.tts.extra);
  const key = accentKey(plan.success ? plan.data.accent : undefined);
  return {
    prologue: {
      plan: plan.success ? plan.data : null,
      enabled: row.enabled,
      status: row.status,
      step: row.step,
      progress: row.progress,
      error: row.error,
      videoUrl: row.outputKey ? await readUrl(row.outputKey) : null,
      thumbUrl: row.thumbKey ? await readUrl(row.thumbKey) : null,
      durationSec: row.durationSec,
      tokens: row.tokens,
      filmTokens: plan.success ? await filmCost(plan.data, cast) : null,
      /**
       * Each shot's filmed clip (the lip-synced one for a speaking shot, when made) and whether it
       * still matches the shot as written; `synced` says the mouth is matched to the line.
       */
      clips: plan.success
        ? Object.fromEntries(
            await Promise.all(
              plan.data.shots
                .filter((shot) => shot.clipKey)
                .map(async (shot) => {
                  const synced = isSpeaking(shot) && Boolean(shot.syncKey) && shot.syncFor === syncFor(shot);
                  return [shot.id, { url: await readUrl(synced ? shot.syncKey! : shot.clipKey!), current: shot.clipFor === visualFor(shot, plan.data.setting), synced }] as const;
                }),
            ),
          )
        : {},
      /** Each recorded line (to listen to) and whether it still matches the words and voice. */
      lines: plan.success
        ? Object.fromEntries(
            await Promise.all(
              plan.data.shots
                .filter((shot) => shot.voiceKey)
                .map(async (shot) => [shot.id, { url: await readUrl(shot.voiceKey!), current: shot.voiceFor === voiceFor(shot, voiceIdentity(plan.data, shot, cast)), seconds: shot.voiceSec ?? null }] as const),
            ),
          )
        : {},
      /** Tokens to (re)film each shot on its own, and to (re)record each line. */
      shotTokens: plan.success ? Object.fromEntries(await Promise.all(plan.data.shots.map(async (shot) => [shot.id, await filmCost(plan.data, cast, new Set([shot.id]), { only: new Set([shot.id]) })] as const))) : {},
      lineTokens: plan.success
        ? Object.fromEntries(await Promise.all(plan.data.shots.map(async (shot) => [shot.id, await filmCost(plan.data, cast, new Set([shot.id]), { only: new Set([shot.id]), voiceOnly: true })] as const)))
        : {},
      /** Each speaker's voice as it stands (the plan's choice or the default). */
      voices: plan.success
        ? Object.fromEntries(['narrator', ...cast.map((person) => person.id)].map((speaker) => [speaker, voiceChoice(plan.data, speaker, cast)]))
        : {},
      /** Accented library voices are set up for this accent in the console (else presets sound British / American). */
      accentVoices: Boolean(key) && Object.keys(mapping).some((item) => item === key || item.startsWith(`${key} `)),
      /** The artist's own voice can be cloned (the engine is on). */
      cloneVoice: models.voiceClone.enabled,
      /** The film is older than the shots / lines / sound settings (mix it again). */
      mixStale: Boolean(row.outputKey && plan.success && plan.data.mixedFor && plan.data.mixedFor !== mixFor(plan.data)),
      updatedAt: row.updatedAt.toISOString(),
      /** Live filming details: what each shot is doing, what was spent so far, a Pause / Stop asked for. */
      control: row.control,
      spent: row.spent,
      shotStatus: row.shotStatus,
      startedAt: row.startedAt?.toISOString() ?? null,
      /** Tokens to film what is left (kept shots and voice lines are free). */
      remainingTokens: plan.success ? await filmCost(plan.data, cast) : null,
    },
    costs: { plan: costs.mvStoryboard },
  };
}

export async function savePrologue(auth: AuthContext, workspaceId: string, projectId: string, input: { plan?: ProloguePlan | undefined; enabled?: boolean | undefined }) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [row] = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE project_id = ${projectId}`;
  if (!row) throw AppError.badRequest('Ask VeloBot for a cold open first (or write one).');
  if (row.status === 'FILMING' && input.plan) throw AppError.conflict('The cold open is being filmed: wait for it to finish.');
  if (input.plan) {
    const cast = new Set((await sql<{ id: string }[]>`SELECT id FROM mv_characters WHERE project_id = ${projectId}`).map((item) => item.id));
    const own = `${keys.studio(workspaceId, projectId)}/prologue/`;
    const plan: ProloguePlan = {
      ...input.plan,
      // Voices only for speakers that exist.
      ...(input.plan.voices ? { voices: Object.fromEntries(Object.entries(input.plan.voices).filter(([speaker]) => speaker === 'narrator' || cast.has(speaker))) } : {}),
      shots: input.plan.shots.map((shot) => {
        const next = { ...shot, characterIds: shot.characterIds.filter((id) => cast.has(id)) };
        // A line is said on camera only by someone in the shot.
        if (next.speaker && next.speaker !== 'narrator' && !next.characterIds.includes(next.speaker)) next.speaker = 'narrator';
        // Only this project's own prologue files can be kept on a shot.
        if (next.clipKey && !next.clipKey.startsWith(own)) {
          delete next.clipKey;
          delete next.clipFor;
          delete next.clipSec;
        }
        if (next.voiceKey && !next.voiceKey.startsWith(own)) {
          delete next.voiceKey;
          delete next.voiceFor;
          delete next.voiceSec;
        }
        if (next.syncKey && !next.syncKey.startsWith(own)) {
          delete next.syncKey;
          delete next.syncFor;
        }
        return next;
      }),
    };
    await sql`UPDATE mv_prologues SET plan = ${json(plan)}, updated_at = now() WHERE project_id = ${projectId}`;
    await dropUnusedClips(workspaceId, projectId, plan);
  }
  if (input.enabled !== undefined) await sql`UPDATE mv_prologues SET enabled = ${input.enabled}, updated_at = now() WHERE project_id = ${projectId}`;
  return prologueView(auth, workspaceId, projectId);
}

/** Deletes the shot clips / voice lines no shot of the plan uses any more (removed or re-filmed shots). */
async function dropUnusedClips(workspaceId: string, projectId: string, plan: ProloguePlan): Promise<void> {
  const used = new Set(plan.shots.flatMap((shot) => [shot.clipKey, shot.voiceKey, shot.syncKey].filter((key): key is string => Boolean(key))));
  for (const sub of ['clips', 'voice']) {
    const objects = await listObjects(`${keys.studio(workspaceId, projectId)}/prologue/${sub}/`).catch(() => []);
    for (const object of objects) if (!used.has(object.key)) await deleteObject(object.key).catch(() => undefined);
  }
  // First frames are only engine inputs; older runs left them in the folder root.
  const loose = await listObjects(`${keys.studio(workspaceId, projectId)}/prologue/`).catch(() => []);
  for (const object of loose) if (/\/prologue\/(frames\/|frame-)/.test(object.key)) await deleteObject(object.key).catch(() => undefined);
}

/* ------------------------------------------------------------------ film + render */

const setProgress = (projectId: string, step: string, progress: number): Promise<unknown> =>
  sql`UPDATE mv_prologues SET step = ${step.slice(0, 80)}, progress = ${progress}, updated_at = now() WHERE project_id = ${projectId}`;

/**
 * Films the cold open. Without `only`: everything not made yet, then the final mix. With `only`:
 * just those shots (or, with `voiceOnly`, just their lines), so each can be tried and judged
 * before anything else is paid for; no mix.
 */
export async function filmPrologue(
  auth: AuthContext,
  workspaceId: string,
  projectId: string,
  dryRun: boolean,
  refilm: string[] = [],
  options: { only?: string[] | undefined; voiceOnly?: boolean | undefined } = {},
) {
  await access(auth, workspaceId, true);
  const { project } = await load(workspaceId, projectId);
  const [row] = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE project_id = ${projectId}`;
  const parsed = planSchema.safeParse(row?.plan);
  if (!row || !parsed.success) throw AppError.badRequest('Ask VeloBot for a cold open first.');
  const force = new Set(refilm);
  const only = options.only?.length ? new Set(options.only.filter((id) => parsed.data.shots.some((shot) => shot.id === id))) : null;
  if (only && only.size === 0) throw AppError.badRequest('That shot is not in the plan any more: save the plan first.');
  const scope = { only, voiceOnly: Boolean(only && options.voiceOnly), mix: !only };
  const cast = await castOf(projectId);
  const tokens = await filmCost(parsed.data, cast, force, scope);
  if (dryRun) return { estimate: { tokens } };
  if (row.status === 'FILMING' && !isStale(row)) throw AppError.conflict('The cold open is already being filmed: pause or stop it first.');
  if (row.status === 'FILMING') await closeRun(row, 'PAUSED', 'Interrupted (the server restarted): Continue films only what is left.');
  if (!fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', `Video generation is not switched on yet (the ${ENGINE_NAME} is not connected).`);
  const { reservation } = await reserveTokens(auth, workspaceId, 'STUDIO_TAKES', tokens, { projectId, prologue: true });
  // Every shot starts as kept (unchanged, free), waiting (to be made) or skipped (not in this run).
  const statuses: Record<string, ShotStatus> = Object.fromEntries(
    parsed.data.shots.map((shot) => {
      const inScope = !only || only.has(shot.id);
      return [
        shot.id,
        {
          clip: !inScope || scope.voiceOnly ? 'skipped' : needsClip(parsed.data, shot, force) ? 'waiting' : 'kept',
          voice: !inScope || !hasLine(parsed.data, shot) ? 'skipped' : needsVoice(parsed.data, shot, cast, scope.voiceOnly ? force : NO_FORCE) ? 'waiting' : 'kept',
        } satisfies ShotStatus,
      ];
    }),
  );
  await sql`
    UPDATE mv_prologues SET status = 'FILMING', control = 'RUN', step = 'Starting', progress = 0, error = NULL, reservation_id = ${reservation.unmetered ? null : reservation.id},
      spent = 0, shot_status = ${json(statuses)}, started_at = now(), updated_at = now()
    WHERE project_id = ${projectId}`;
  void (async () => {
    let spent = 0;
    // Proof of life for the stale-run sweep: a long engine call or ffmpeg render reports nothing
    // for minutes, and without this a working run was closed as "interrupted by a restart".
    const heartbeat = setInterval(() => {
      void sql`UPDATE mv_prologues SET updated_at = now() WHERE project_id = ${projectId} AND status = 'FILMING'`.catch(() => undefined);
    }, 30_000);
    heartbeat.unref();
    try {
      spent = await runPrologue(workspaceId, projectId, project.aspect as keyof typeof ASPECTS, project.brief.style ?? '', parsed.data, force, scope, (amount) => {
        spent += amount;
      });
      const what = scope.mix ? 'cold open' : scope.voiceOnly ? 'cold open line' : 'cold open shot';
      await settleSystem(reservation.id, workspaceId, spent, `Music video · ${project.title.slice(0, 50)}: ${what}`);
      if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${spent} WHERE id = ${projectId}`;
      await sql`UPDATE mv_prologues SET tokens = tokens + ${spent}, reservation_id = NULL, spent = 0, control = 'RUN' WHERE project_id = ${projectId}`;
    } catch (error) {
      const halted = error instanceof Halted;
      if (halted && error.kind === 'CLOSED') return;
      if (!halted) logger.error({ err: error, projectId }, 'cold open failed');
      // Only what was really made (finished model calls) is charged; the rest of the hold goes back.
      if (spent > 0) {
        await settleSystem(reservation.id, workspaceId, spent, `Music video · ${project.title.slice(0, 50)}: cold open (${halted ? error.kind.toLowerCase() : 'stopped'})`).catch(() => undefined);
        if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${spent} WHERE id = ${projectId}`.catch(() => undefined);
      } else {
        await releaseSystem(reservation.id, workspaceId).catch(() => undefined);
      }
      const message = halted
        ? error.kind === 'PAUSED'
          ? 'Paused. Continue films only what is left (finished shots are kept).'
          : 'Stopped. Finished shots are kept; nothing was charged for the shot that was cancelled.'
        : (error instanceof Error ? error.message : String(error)).slice(0, 600);
      await sql`
        UPDATE mv_prologues SET status = ${halted ? error.kind : 'FAILED'}, control = 'RUN', reservation_id = NULL, spent = 0, tokens = tokens + ${spent},
          step = ${halted ? (error.kind === 'PAUSED' ? 'Paused' : 'Stopped') : 'Failed'}, error = ${message}, updated_at = now()
        WHERE project_id = ${projectId}`.catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  })();
  return { estimate: { tokens } };
}

/* ------------------------------------------------------------------ pause / stop / recovery */

class Halted extends Error {
  constructor(readonly kind: 'PAUSED' | 'STOPPED' | 'CLOSED') {
    super(kind);
  }
}

/** A run that has not reported for 3 minutes is dead (a live run's heartbeat touches it every 30 s). */
const STALE_MS = 3 * 60_000;
const isStale = (row: Pick<PrologueRow, 'status' | 'updatedAt'>): boolean => row.status === 'FILMING' && Date.now() - row.updatedAt.getTime() > STALE_MS;

/** Ends a run that cannot finish itself: charges what it had made, returns the rest of the hold. */
async function closeRun(row: PrologueRow, status: 'PAUSED' | 'STOPPED', note: string): Promise<void> {
  if (row.reservationId) {
    if (row.spent > 0) await settleSystem(row.reservationId, row.workspaceId, row.spent, 'Music video: cold open (interrupted)').catch(() => undefined);
    else await releaseSystem(row.reservationId, row.workspaceId).catch(() => undefined);
  }
  await sql`
    UPDATE mv_prologues SET status = ${status}, control = 'RUN', reservation_id = NULL, tokens = tokens + ${row.spent}, spent = 0, step = ${status === 'PAUSED' ? 'Paused' : 'Stopped'},
      error = ${note}, updated_at = now()
    WHERE project_id = ${row.projectId}`;
}

/** Pause (after the shot being made, which is already paid for) or stop now (the shot being made is cancelled, not charged). */
export async function controlPrologue(auth: AuthContext, workspaceId: string, projectId: string, action: 'pause' | 'stop') {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const [row] = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE project_id = ${projectId}`;
  if (!row || row.status !== 'FILMING') throw AppError.badRequest('The cold open is not being filmed.');
  if (isStale(row)) await closeRun(row, action === 'pause' ? 'PAUSED' : 'STOPPED', 'Interrupted (the server restarted). Finished shots are kept.');
  else await sql`UPDATE mv_prologues SET control = ${action === 'pause' ? 'PAUSE' : 'STOP'}, updated_at = now() WHERE project_id = ${projectId}`;
  return prologueView(auth, workspaceId, projectId);
}

/** Scheduled (and at start-up): runs left "filming" by a restart are closed, so no hold and no spinner stays forever. */
export async function recoverPrologues(): Promise<string> {
  const rows = await sql<PrologueRow[]>`SELECT * FROM mv_prologues WHERE status = 'FILMING' AND updated_at < now() - make_interval(secs => ${STALE_MS / 1000})`;
  for (const row of rows) await closeRun(row, 'PAUSED', 'Interrupted (the server restarted): Continue films only what is left.');
  return `${rows.length} interrupted cold open(s) closed`;
}

function effectFilters(effect: Effect, seconds: number, size: { width: number; height: number }): string[] {
  switch (effect) {
    case 'film-burn':
      return ['colorbalance=rs=0.12:gs=0.04:bs=-0.1', 'noise=c0s=14:c0f=t+u', 'vignette=angle=PI/4', "eq=brightness='0.035*sin(t*11)':eval=frame", 'fade=t=in:st=0:d=0.5:color=white'];
    case 'slow-push':
      return [`zoompan=z='min(1+0.0018*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size.width}x${size.height}:fps=24`];
    case 'flash-cut':
      return ['fade=t=in:st=0:d=0.25:color=white', `fade=t=out:st=${Math.max(0, seconds - 0.25).toFixed(2)}:d=0.25:color=white`];
    case 'glitch':
      return ['rgbashift=rh=-8:bh=8', 'noise=alls=12:allf=t'];
    case 'light-leak':
      return ['colorbalance=rs=0.18:gs=0.06:bs=-0.12', 'curves=preset=lighter', 'vignette=angle=PI/5'];
    case 'black-white':
      return ['hue=s=0', 'eq=contrast=1.15:brightness=-0.02'];
    case 'vhs':
      return ['noise=alls=18:allf=t', 'eq=saturation=1.35:contrast=1.1', 'rgbashift=rh=3:bh=-3', 'boxblur=1:1'];
    case 'dream-blur':
      return ['gblur=sigma=2.2', 'eq=brightness=0.04:saturation=0.8'];
    case 'letterbox':
      return ['drawbox=x=0:y=0:w=iw:h=ih*0.12:color=black:t=fill', 'drawbox=x=0:y=ih*0.88:w=iw:h=ih*0.12:color=black:t=fill'];
    default:
      return [];
  }
}

function audioUrl(result: unknown): string {
  const body = result as { audio?: { url?: string }; audio_url?: string | { url?: string }; url?: string };
  const url = body.audio?.url ?? (typeof body.audio_url === 'string' ? body.audio_url : body.audio_url?.url) ?? body.url;
  if (!url) throw new Error('The voice engine returned no audio.');
  return url;
}

/** A line as a 48 kHz mono WAV: frame-exact for lip sync (MP3 encoder padding would make the lips late). */
const toWav = (input: string, out: string): Promise<string> => ffmpeg(['-i', input, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out]);

/**
 * The artist's voice sample for cloning: the 15 s of the song's vocal stem with the most
 * singing in it (by the lyric timings), cleaned and levelled. Made once per mix, kept beside the
 * cold open (outside clips/ and voice/, so it is never swept as unused).
 */
async function artistReference(
  projectId: string,
  folder: string,
  dir: string,
  models: Awaited<ReturnType<typeof getStudioSettings>>['models'],
  run: (endpoint: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<string> {
  const [music] = await sql<AssetRow[]>`SELECT a.* FROM studio_assets a JOIN studio_projects p ON p.music_asset_id = a.id WHERE p.id = ${projectId}`;
  if (!music) throw new Error('The artist’s own voice is taken from the song: upload the song first, or pick a library voice for this speaker.');
  const refKey = `${folder}/ref/artist-${digest(music.key).slice(0, 12)}.wav`;
  if (await headObject(refKey).catch(() => null)) return readUrl(refKey);
  const stem = await vocalStem(music.key, models.vocalStem, (_stage, endpoint, input) => run(endpoint, input), dir);
  if (!stem) throw new Error('The artist’s voice could not be separated from the song (vocal separation is off or failed): pick a library voice for this speaker for now.');
  const stemFile = join(dir, 'vocals.wav');
  await downloadToFile(stem.key, stemFile);
  const [song] = await sql<{ lines: { start: number; end: number }[] | null }[]>`SELECT lyrics -> 'lines' AS lines FROM mv_projects WHERE project_id = ${projectId}`;
  const lines = Array.isArray(song?.lines) ? song.lines.filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end)) : [];
  let from = lines[0]?.start ?? 0;
  let best = -1;
  for (const line of lines) {
    const start = Math.max(0, line.start - 0.2);
    const covered = lines.reduce((sum, other) => sum + Math.max(0, Math.min(other.end, start + 15) - Math.max(other.start, start)), 0);
    if (covered > best) {
      best = covered;
      from = start;
    }
  }
  const ref = join(dir, 'artist-ref.wav');
  await ffmpeg(['-ss', from.toFixed(2), '-t', '15', '-i', stemFile, '-vn', '-ac', '1', '-ar', '24000', '-af', 'highpass=f=80,loudnorm=I=-18:TP=-2', '-c:a', 'pcm_s16le', ref]);
  await uploadFile(refKey, ref, 'audio/wav');
  return readUrl(refKey);
}

/** Staging that keeps the scene real: the right people, faces to camera, ordinary actions. */
const NEGATIVE_STAGING = 'extra people, crowd, stranger, person walking into frame, person leaving frame, back to camera, hidden face, absurd action, surreal, objects used the wrong way, ';

/** What the video model is asked to film for a shot, and what to avoid. */
function shotDirection(plan: ProloguePlan, shot: PlanShot, cast: CharacterRow[], speaking: boolean): { scene: string; negative: string } {
  const inFrame = cast.filter((person) => shot.characterIds.includes(person.id));
  const speaker = speaking ? cast.find((person) => person.id === shot.speaker) : undefined;
  const scene = [
    plan.setting?.trim() ? `The scene, the same in every shot: ${plan.setting.trim()}` : '',
    shot.prompt.trim(),
    inFrame.length
      ? `Exactly ${inFrame.length} ${inFrame.length === 1 ? 'person' : 'people'} in frame (${inFrame.map((person) => person.name).join(', ')}); nobody else appears, enters or leaves. Faces visible to the camera (front or three-quarter view), never their backs to the lens.`
      : '',
    'Real life: every object is used the normal way and every action is ordinary and physically real; nothing absurd or surreal.',
    speaker
      ? `${speaker.name} says a short line in a natural, conversational way, to the camera or to the other person: face large enough to read, mouth clearly visible and unobstructed, small natural mouth movement as in everyday speech${inFrame.length > 1 ? '; the others listen without talking' : ''}.`
      : inFrame.length
        ? OFF_SCREEN_VOICE
        : '',
  ]
    .filter(Boolean)
    .join(' ');
  const negative = (speaker ? NEGATIVE_LIP_SYNC : inFrame.length ? NEGATIVE_TALKING : '') + (inFrame.length ? NEGATIVE_STAGING : '') + negativePrompt(false);
  return { scene, negative };
}

/**
 * Makes what the scope asks for and returns the tokens spent. Per shot, in order: the line
 * (first, because a speaking shot is filmed as long as its line), the picture, then the lip sync
 * of a speaking shot. With `mix`, everything is then cut, graded and mixed into the film.
 */
async function runPrologue(
  workspaceId: string,
  projectId: string,
  aspect: keyof typeof ASPECTS,
  style: string,
  plan: ProloguePlan,
  force: Set<string>,
  scope: { only: Set<string> | null; voiceOnly: boolean; mix: boolean },
  onSpend: (amount: number) => void,
): Promise<number> {
  const settings = await getStudioSettings();
  const { models, costs } = settings;
  const size = ASPECTS[aspect];
  const cast = await castOf(projectId);
  const [mv] = await sql<{ direction: unknown; voice: unknown }[]>`SELECT direction, lyrics -> 'voice' AS voice FROM mv_projects WHERE project_id = ${projectId}`;
  const { parseDirection, placeText } = await import('./songmap.js');
  const place = mv ? placeText(parseDirection(mv.direction), (mv.voice ?? null) as Parameters<typeof placeText>[1]) : '';
  const dir = await mkdtemp(join(tmpdir(), 'mv-prologue-'));
  let spent = 0;
  /** Each finished (paid) step is recorded on the row at once, so a crash still settles exactly this. */
  const spend = async (amount: number): Promise<void> => {
    spent += amount;
    await sql`UPDATE mv_prologues SET spent = ${spent}, updated_at = now() WHERE project_id = ${projectId}`;
  };
  const shotState = (id: string, change: ShotStatus): Promise<unknown> =>
    sql`UPDATE mv_prologues SET shot_status = shot_status || jsonb_build_object(${id}::text, COALESCE(shot_status -> ${id}, '{}'::jsonb) || ${json({ ...change, at: new Date().toISOString() })}::jsonb), updated_at = now() WHERE project_id = ${projectId}`;
  /** Between steps: Pause / Stop asked for? */
  const checkpoint = async (): Promise<void> => {
    const [row] = await sql<{ control: string; status: string }[]>`SELECT control, status FROM mv_prologues WHERE project_id = ${projectId}`;
    // Closed under it (stale sweep): that already settled the hold, so this run just ends.
    if (row && row.status !== 'FILMING') throw new Halted('CLOSED');
    if (row?.control === 'STOP') throw new Halted('STOPPED');
    if (row?.control === 'PAUSE') throw new Halted('PAUSED');
  };
  try {
    /**
     * One engine call. While it runs the row is touched every few seconds (it is alive), and a Stop
     * cancels the call at the engine (the unfinished shot is not charged). A Pause lets it finish.
     */
    const run = async (endpoint: string, input: Record<string, unknown>): Promise<unknown> => {
      const handle = await fal.submit(endpoint, input);
      let stopped = false;
      const watch = setInterval(() => {
        void sql<{ control: string }[]>`UPDATE mv_prologues SET updated_at = now() WHERE project_id = ${projectId} RETURNING control`
          .then(([row]) => {
            if (row?.control === 'STOP' && !stopped) {
              stopped = true;
              void fal.cancel(handle).catch(() => undefined);
            }
          })
          .catch(() => undefined);
      }, 4000);
      try {
        const result = await fal.wait(handle, { timeoutMs: 15 * 60_000 });
        if (stopped) throw new Halted('STOPPED');
        return result;
      } catch (error) {
        if (stopped) throw new Halted('STOPPED');
        throw error;
      } finally {
        clearInterval(watch);
      }
    };
    const folder = `${keys.studio(workspaceId, projectId)}/prologue`;
    /** Keeps what was made so far on the plan (a later film, or a retry after a failure, reuses it). */
    const keep = (): Promise<unknown> => sql`UPDATE mv_prologues SET plan = ${json(plan)} WHERE project_id = ${projectId}`;
    const { voices: _mapping, ...ttsExtra } = models.tts.extra as Record<string, unknown>;
    const mapping = voiceMapping(models.tts.extra);
    /** The artist's voice sample (made at most once per run). */
    let reference: string | null = null;
    const pictures: (string | null)[] = [];
    const lineFiles: (string | null)[] = [];
    const count = plan.shots.length;

    for (const [index, shot] of plan.shots.entries()) {
      if (scope.only && !scope.only.has(shot.id)) {
        pictures.push(null);
        lineFiles.push(null);
        continue;
      }
      await checkpoint();
      const label = `Shot ${index + 1} of ${count}`;
      const at = (part: number): number => 0.05 + ((index + part) / count) * (scope.mix ? 0.75 : 0.9);

      // 1. The line.
      let lineFile: string | null = null;
      if (hasLine(plan, shot)) {
        lineFile = join(dir, `line-${index}.wav`);
        if (needsVoice(plan, shot, cast, scope.voiceOnly ? force : NO_FORCE)) {
          const choice = voiceChoice(plan, speakerOf(shot), cast);
          await shotState(shot.id, { voice: 'animating' });
          await setProgress(projectId, `${label}: recording the line${choice === 'artist' ? ' in the artist’s voice' : ''}`, at(0));
          let result: unknown;
          if (choice === 'artist') {
            if (!models.voiceClone.enabled) throw new Error('The artist’s own voice is switched off in the console: pick a library voice for this speaker.');
            reference ??= await artistReference(projectId, folder, dir, models, run);
            result = await run(models.voiceClone.endpoint, { ...models.voiceClone.extra, text: shot.narration.trim(), audio_url: reference });
          } else {
            if (!models.tts.enabled) throw new Error('Voices are switched off in the console.');
            result = await run(models.tts.endpoint, { ...ttsExtra, text: shot.narration.trim(), voice: libraryVoice(choice, plan.accent, mapping).voice });
          }
          const raw = join(dir, `line-${index}-raw`);
          await downloadUrl(audioUrl(result), raw);
          await toWav(raw, lineFile);
          // A line is audio only: probe() demands a video stream.
          const seconds = await mediaDuration(lineFile);
          await spend(Math.max(1, Math.ceil(seconds)) * costs.ttsPerSecond);
          const voiceKey = `${folder}/voice/${shot.id}-${randomUUID().slice(0, 8)}.wav`;
          await uploadFile(voiceKey, lineFile, 'audio/wav');
          shot.voiceKey = voiceKey;
          shot.voiceFor = voiceFor(shot, voiceIdentity(plan, shot, cast));
          shot.voiceSec = +seconds.toFixed(3);
          await keep();
          await shotState(shot.id, { voice: 'done' });
        } else {
          const raw = join(dir, `line-${index}-kept`);
          await downloadToFile(shot.voiceKey!, raw);
          await toWav(raw, lineFile);
          shot.voiceSec ??= +(await mediaDuration(lineFile)).toFixed(3);
        }
      }
      lineFiles.push(lineFile);
      if (scope.voiceOnly) {
        pictures.push(null);
        continue;
      }

      // 2. The picture. A speaking shot runs as long as its line.
      const speaking = isSpeaking(shot) && lineFile !== null;
      const clipFile = join(dir, `shot-${index}.mp4`);
      if (!needsClip(plan, shot, force)) {
        await setProgress(projectId, `${label}: kept (unchanged)`, at(0.1));
        await downloadToFile(shot.clipKey!, clipFile);
        shot.clipSec ??= +(await probe(clipFile)).durationSec.toFixed(3);
      } else {
        await checkpoint();
        await setProgress(projectId, `Filming shot ${index + 1} of ${count}`, at(0.1));
        const people = cast.filter((character) => shot.characterIds.includes(character.id) && character.referenceKeys.length);
        const direction = shotDirection(plan, shot, cast, speaking);
        const input: PromptInput = {
          scene: direction.scene,
          shot: shot.shot as Shot,
          style,
          identity: people.map((person) => `${person.name}: ${person.prompt}`).join(' ').slice(0, 900) || undefined,
          featuresSubject: people.length > 0,
          aspect,
          place: place || undefined,
          musicVideo: false,
        };
        let frameUrl: string | null = null;
        let frameKey: string | null = null;
        if (people.length && models.keyframe.enabled) {
          await shotState(shot.id, { clip: 'frame' });
          await setProgress(projectId, `${label}: first frame (the cast locked to their photos)`, at(0.15));
          const references = people.flatMap((person) => person.referenceKeys.slice(0, people.length > 1 ? 2 : 4)).slice(0, 5);
          const result = await run(models.keyframe.endpoint, { ...models.keyframe.extra, prompt: keyframePrompt(input), image_urls: await Promise.all(references.map((key) => readUrl(key))) });
          await spend(costs.keyframe);
          const raw = join(dir, `frame-${index}-raw`);
          await downloadUrl(fal.outputUrl(result, 'image'), raw);
          const framed = join(dir, `frame-${index}.png`);
          await conformImage(raw, framed, size.width, size.height);
          // Only the engine reads it: removed as soon as the shot's video exists.
          frameKey = `${folder}/frames/${shot.id}-${randomUUID().slice(0, 6)}.png`;
          await uploadFile(frameKey, framed, 'image/png');
          frameUrl = await readUrl(frameKey);
        }
        await shotState(shot.id, { clip: 'animating' });
        await setProgress(projectId, `${label}: animating (usually 1-4 minutes)`, at(0.4));
        const model = frameUrl ? models.imageToVideo : models.textToVideo;
        if (!model.enabled) throw new Error(`The ${frameUrl ? 'image' : 'text'}-to-video model is switched off in the console.`);
        const wanted = speaking ? Math.max(shot.seconds, shot.voiceSec! + SPEECH_LEAD + 0.4) : shot.seconds;
        const duration = pickDuration(model, wanted);
        if (speaking && duration.seconds < shot.voiceSec! + SPEECH_LEAD + 0.2) {
          throw new Error(`Shot ${index + 1}: the line takes ${shot.voiceSec!.toFixed(1)} s, longer than the longest clip the video model makes (${duration.seconds} s). Shorten the line or split it over two shots.`);
        }
        const result = await run(model.endpoint, {
          ...model.extra,
          prompt: motionPrompt(input),
          negative_prompt: direction.negative,
          ...(duration.param ? { duration: duration.param } : {}),
          ...(frameUrl ? { image_url: frameUrl } : { aspect_ratio: size.model }),
        });
        await spend(Math.ceil(duration.seconds) * costs.videoPerSecond);
        if (frameKey) await deleteObject(frameKey).catch(() => undefined);
        await downloadUrl(fal.outputUrl(result, 'video'), clipFile);
        const clipKey = `${folder}/clips/${shot.id}-${randomUUID().slice(0, 8)}.mp4`;
        await uploadFile(clipKey, clipFile, 'video/mp4');
        shot.clipKey = clipKey;
        shot.clipFor = visualFor(shot, plan.setting);
        shot.clipSec = +(await probe(clipFile)).durationSec.toFixed(3);
        await keep();
      }

      // 3. Lip sync: the speaker's mouth matched to their line (the line starts SPEECH_LEAD in).
      let picture = clipFile;
      if (speaking) {
        const synced = join(dir, `sync-${index}.mp4`);
        if (needsSync(shot, force)) {
          await checkpoint();
          if (!models.lipSync.enabled) throw new Error('Lip sync is switched off in the console.');
          await shotState(shot.id, { clip: 'animating' });
          await setProgress(projectId, `${label}: lip sync (the mouth matched to the line)`, at(0.8));
          const clipSec = shot.clipSec ?? (await probe(clipFile)).durationSec;
          const audio = join(dir, `sync-${index}.wav`);
          const lead = Math.round(SPEECH_LEAD * 1000);
          // Exactly the clip's length: cut_off never trims a word or leaves frames without sound.
          await ffmpeg(['-i', lineFile!, '-af', `adelay=${lead},apad`, '-t', clipSec.toFixed(3), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', audio]);
          const audioKey = `${folder}/frames/${shot.id}-line-${randomUUID().slice(0, 6)}.wav`;
          await uploadFile(audioKey, audio, 'audio/wav');
          try {
            const result = await run(models.lipSync.endpoint, lipSyncInput(models.lipSync, await readUrl(shot.clipKey!), await readUrl(audioKey)));
            await spend(Math.ceil(Math.max(1, clipSec)) * costs.lipSyncPerSecond);
            await downloadUrl(fal.outputUrl(result, 'video'), synced);
          } finally {
            await deleteObject(audioKey).catch(() => undefined);
          }
          const syncKey = `${folder}/clips/${shot.id}-sync-${randomUUID().slice(0, 8)}.mp4`;
          await uploadFile(syncKey, synced, 'video/mp4');
          shot.syncKey = syncKey;
          shot.syncFor = syncFor(shot);
          await keep();
        } else {
          await downloadToFile(shot.syncKey!, synced);
        }
        picture = synced;
      }
      await shotState(shot.id, { clip: 'done' });
      pictures.push(picture);
    }

    if (!scope.mix) {
      // Tried on their own: nothing is mixed, and the last film (if any) stays as it was.
      await sql`
        UPDATE mv_prologues SET status = CASE WHEN output_key IS NULL THEN 'DRAFT' ELSE 'READY' END, step = 'Ready', progress = 1, error = NULL, plan = ${json(plan)}, updated_at = now()
        WHERE project_id = ${projectId}`;
      await dropUnusedClips(workspaceId, projectId, plan);
      return spent;
    }

    // The timeline: each shot's length, each line's place.
    const lengths = plan.shots.map(shotLength);
    const lines: { file: string; at: number }[] = [];
    let at = 0;
    // A narrator line never starts before the previous line has finished (an edited line can outrun its
    // shot); a cast line starts exactly where its lip sync was built.
    let voiceFree = 0;
    for (const [index, shot] of plan.shots.entries()) {
      const file = lineFiles[index];
      if (file && !plan.muteAll) {
        const start = isSpeaking(shot) ? at + SPEECH_LEAD : Math.max(at + 0.35, voiceFree + 0.25);
        lines.push({ file, at: start });
        voiceFree = Math.max(voiceFree, start + (shot.voiceSec ?? (await mediaDuration(file).catch(() => 0))));
      }
      at += lengths[index]!;
    }
    // The last line is never cut off: the final shot holds its last frame until the voice ends.
    const hold = Math.max(0, voiceFree + 0.6 - at);
    const total = at + hold;

    // Each shot: cut to length, framed, its effect.
    await checkpoint();
    await setProgress(projectId, 'Cutting and grading', 0.85);
    const parts: string[] = [];
    for (const [index, shot] of plan.shots.entries()) {
      const length = lengths[index]!;
      const part = join(dir, `part-${index}.mp4`);
      const fx = effectFilters(shot.effect, length, size);
      await ffmpeg([
        '-i', pictures[index]!,
        '-t', length.toFixed(3),
        '-vf', [`scale=${size.width}:${size.height}:force_original_aspect_ratio=increase`, `crop=${size.width}:${size.height}`, 'fps=24', 'setsar=1', ...fx, 'format=yuv420p'].join(','),
        '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', part,
      ]);
      // Freeze the last frame when the clip ran short; the last shot also holds for a line that runs past the end.
      const target = length + (index === plan.shots.length - 1 ? hold : 0);
      const made = (await probe(part)).durationSec;
      if (made < target - 0.1) {
        const padded = join(dir, `part-${index}-pad.mp4`);
        await ffmpeg(['-i', part, '-vf', `tpad=stop_mode=clone:stop_duration=${(target - made).toFixed(3)}`, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', padded]);
        parts.push(padded);
      } else {
        parts.push(part);
      }
    }
    const list = join(dir, 'list.txt');
    await writeFile(list, parts.map((part) => `file '${part.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const joined = join(dir, 'joined.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

    // On-screen text, typed in on its shot.
    const ass = join(dir, 'text.ass');
    const look = textLookOf(plan);
    let start = 0;
    const events: string[] = [];
    for (const [index, shot] of plan.shots.entries()) {
      if (shot.text.trim()) events.push(textEvent({ styleName: 'Text', style: look, text: shot.text.trim(), start: start + 0.4, seconds: Math.max(1.5, lengths[index]! - 0.6), frame: size }));
      start += lengths[index]!;
    }
    const withText = events.length > 0 && (await writeFile(ass, [...assHeader(size, [{ name: 'Text', style: look }]), ...events, ''].join('\n'), 'utf8').then(() => canBurnSubtitles(ass).catch(() => false)));

    // Sound: the bed, the lines on top (the bed dips under the voice). Muted: no sound at all.
    await setProgress(projectId, plan.muteAll ? 'Rendering (silent)' : 'Mixing the voices', 0.92);
    const inputs: string[] = ['-i', joined];
    const graph: string[] = [];
    const audioLabels: string[] = [];
    if (!plan.muteAll && plan.bed === 'song-muffled') {
      const [music] = await sql<AssetRow[]>`SELECT a.* FROM studio_assets a JOIN studio_projects p ON p.music_asset_id = a.id WHERE p.id = ${projectId}`;
      if (music) {
        const song = join(dir, 'song');
        await downloadToFile(music.key, song);
        inputs.push('-i', song);
        graph.push(`[${inputs.length / 2 - 1}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,lowpass=f=650,volume=-17dB,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[bed]`);
        audioLabels.push('[bed]');
      }
    } else if (!plan.muteAll && plan.bed === 'room-tone') {
      inputs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anoisesrc=color=brown:amplitude=0.02:sample_rate=48000');
      graph.push(`[${inputs.filter((value) => value === '-i').length - 1}:a]aformat=channel_layouts=stereo,lowpass=f=900,volume=-6dB,afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 1).toFixed(2)}:d=1[bed]`);
      audioLabels.push('[bed]');
    }
    for (const [index, line] of lines.entries()) {
      inputs.push('-i', line.file);
      const input = inputs.filter((value) => value === '-i').length - 1;
      const delay = Math.round(line.at * 1000);
      graph.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,acompressor=threshold=-18dB:ratio=2.5:attack=5:release=120,adelay=${delay}|${delay}[vo${index}]`);
      audioLabels.push(`[vo${index}]`);
    }
    if (audioLabels.length) graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
    else graph.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${total.toFixed(3)}[aout]`);

    // Picture: text, a fade in from black and out to black, the watermark when the project has one.
    const watermark = await projectWatermarked(projectId);
    const picture = [...(withText ? [subtitlesFilter(ass)] : []), 'fade=t=in:st=0:d=0.6', `fade=t=out:st=${Math.max(0, total - 0.6).toFixed(2)}:d=0.6`, 'format=yuv420p'];
    graph.push(`[0:v]${picture.join(',')}[pic]`);
    let videoLabel = '[pic]';
    if (watermark) {
      inputs.push('-loop', '1', '-i', WATERMARK_FILE);
      const mark = watermarkFilters('[pic]', inputs.filter((value) => value === '-i').length - 1, size, 'wm');
      graph.push(...mark.graph);
      videoLabel = mark.label;
    }
    const output = join(dir, 'prologue.mp4');
    await ffmpeg([
      ...inputs,
      '-filter_complex', graph.join(';'),
      '-map', videoLabel, '-map', '[aout]',
      '-t', total.toFixed(3), '-r', '24',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', output,
    ]);
    const thumb = join(dir, 'thumb.jpg');
    await thumbnail(output, thumb, Math.min(1.5, total / 2));

    await setProgress(projectId, 'Saving', 0.98);
    const stamp = randomUUID().slice(0, 8);
    const outputKey = `${keys.studio(workspaceId, projectId)}/prologue/cold-open-${stamp}.mp4`;
    const thumbKey = `${keys.studio(workspaceId, projectId)}/prologue/cold-open-${stamp}.jpg`;
    await uploadFile(outputKey, output, 'video/mp4');
    await uploadFile(thumbKey, thumb, 'image/jpeg');
    plan.mixedFor = mixFor(plan);
    const [previous] = await sql<{ outputKey: string | null; thumbKey: string | null }[]>`SELECT output_key, thumb_key FROM mv_prologues WHERE project_id = ${projectId}`;
    await sql`
      UPDATE mv_prologues SET status = 'READY', step = 'Ready', progress = 1, error = NULL, output_key = ${outputKey}, thumb_key = ${thumbKey}, plan = ${json(plan)},
        duration_sec = ${+total.toFixed(3)}, enabled = true, updated_at = now()
      WHERE project_id = ${projectId}`;
    for (const key of [previous?.outputKey, previous?.thumbKey]) if (key && key !== outputKey && key !== thumbKey) await deleteObject(key).catch(() => undefined);
    await dropUnusedClips(workspaceId, projectId, plan);
    return spent;
  } catch (error) {
    // Let the caller charge what was already made.
    onSpend(spent);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The finished cold open for the master (null when there is none, or it is switched off). */
export async function readyPrologue(projectId: string): Promise<{ key: string; seconds: number } | null> {
  const [row] = await sql<{ outputKey: string | null; durationSec: number | null; enabled: boolean; status: string }[]>`
    SELECT output_key, duration_sec, enabled, status FROM mv_prologues WHERE project_id = ${projectId}`;
  if (!row?.enabled || row.status !== 'READY' || !row.outputKey || !row.durationSec) return null;
  return { key: row.outputKey, seconds: row.durationSec };
}
