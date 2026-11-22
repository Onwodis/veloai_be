/**
 * /api/v1/workspaces/:workspaceId/music-videos  (music video director)
 *
 *   GET    /                                   list
 *   POST   /                                   { title, aspect } create
 *   GET    /:projectId                         everything (studio view + director state)
 *   PATCH  /:projectId/song                    title, aspect, genre, vision, mood, leadAct   [SONG]
 *   POST   /:projectId/lyrics                  { hint? } transcribe sung lyrics (token-gated) [SONG, SOUND]
 *   POST   /:projectId/lyrics/polish           { lines, samples } artist's lines → fix the rest, detect languages
 *   DELETE /:projectId/characters/:id/media/:assetId  remove one photo / video
 *   POST   /:projectId/characters/detect    { assetIds } find people, estimate looks + roles (token-gated)
 *   POST   /:projectId/characters/bulk      { people } add several characters at once
 *   PUT    /:projectId/lyrics                  { lines } artist corrections
 *   PUT    /:projectId/audio                   { edits, loudnessLufs } DAW edit list          [SOUND; MASTER: loudness]
 *   POST   /:projectId/audio/render            render the mix (token-gated)                   [SOUND]
 *   PUT    /:projectId/audio/clips             { clips } storyboard events → render mix       [STORYBOARD, SHOOT]
 *   GET    /:projectId/audio/source            ?assetId — the original song's (or an imported track's) bytes (Web Audio editing)
 *   POST   /:projectId/characters              add                                            [CHARACTERS]
 *   PATCH  /:projectId/characters/:id          edit (re-opens its approval)
 *   DELETE /:projectId/characters/:id
 *   POST   /:projectId/characters/:id/consent  the artist's permission record
 *   POST   /:projectId/characters/:id/cast     AI casting sheet (token-gated)
 *   POST   /:projectId/characters/:id/approve
 *   POST   /:projectId/scenes                  add a scene idea                               [SCENES, STORYBOARD]
 *   PUT    /:projectId/scenes/order            { order: sceneIds }
 *   PATCH  /:projectId/scenes/:sceneId         edit (re-opens its approval)
 *   DELETE /:projectId/scenes/:sceneId         (intro / outro can't be deleted)
 *   POST   /:projectId/scenes/:sceneId/expand  director plans it ({ notes } to steer) (token-gated)
 *   POST   /:projectId/scenes/:sceneId/approve
 *   POST   /:projectId/scenes/approve-all      every planned scene at once
 *   POST   /:projectId/messages                { message } director's room (token-gated)    [DISCUSSION]
 *   POST   /:projectId/messages/:messageId/proposals/:proposalId/apply
 *   POST   /:projectId/messages/:messageId/titles/apply   use the director's proposed opening titles
 *   PUT    /:projectId/titles                  opening titles (credits, label, story cards)   [any stage]
 *   PUT    /:projectId/direction               performance share, pace, lyric approach        [any stage]
 *   POST   /:projectId/scenes/lock-to-song     re-time scenes to bars + real lyrics (free)
 *   POST   /:projectId/storyboard              { sceneCount } final timeline (token-gated)   [STORYBOARD]
 *   POST   /:projectId/stages/:stage/approve   approve the current stage → next unlocks
 *   POST   /:projectId/stages/:stage/open      jump to any stage (completes the ones in between when they're ready)
 *   POST   /:projectId/stages/:stage/reopen    go back (clears later approvals)
 *   POST   /:projectId/scenes/:sceneId/shoot   { takes, dryRun } any scene, any order           [SHOOT]
 *   POST   /:projectId/scenes/:sceneId/approve-shot
 *   POST   /:projectId/auto                    { dryRun } "I trust your judgement"
 *   POST   /:projectId/master                  { finish, dryRun } final cut                   [MASTER]
 *
 * Uploads (song, photos, videos, effect audio), take picking, cancel and
 * delete use the studio routes: /workspaces/:workspaceId/studio/:projectId/…
 */
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { categorySchema } from '../config/categories.js';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams, validQuery } from '../middleware/validate.js';
import { PERFORMANCE_EMOTION_IDS, SHOT_IDS, TRANSITION_IDS, VISUAL_STYLE_IDS } from '../studio/cinema.js';
import { finishSchema } from '../studio/schemas.js';
import { titleCase } from '../utils/names.js';
import * as characterLook from './characterLook.js';
import * as photos from './photos.js';
import * as quickClip from './quickClip.js';
import * as prologue from './prologue.js';
import * as god from './godMode.js';
import * as remix from './remix.js';
import * as sceneTools from './sceneTools.js';
import * as textCard from './textCard.js';
import * as intake from './intake.js';
import * as director from './service.js';
import { projectVersion } from '../studio/version.js';
import { directionSchema } from './songmap.js';
import { titlesSchema } from './titles.js';

const uuid = z.uuid();
const text = (max: number) => z.string().trim().max(max);
/** Song titles, artist and character names: always capitalised. */
const named = (max: number, message = 'Required') => text(max).min(1, { error: message }).transform(titleCase);
const workspaceParams = z.strictObject({ workspaceId: uuid });
const projectParams = workspaceParams.extend({ projectId: uuid });
const characterParams = projectParams.extend({ characterId: uuid });
const sceneParams = projectParams.extend({ sceneId: uuid });
const stageParams = projectParams.extend({ stage: z.enum(director.STAGES) });
const proposalParams = projectParams.extend({ messageId: uuid, proposalId: uuid });
const ASPECT = z.enum(['16:9', '9:16', '1:1']);

const createSchema = z.strictObject({
  title: named(120, 'Enter the song title'),
  artistName: named(120, 'Enter the artist or band name'),
  aspect: ASPECT.default('16:9'),
  /** Industry focus: chosen before the project exists (filters on the projects page). */
  category: categorySchema,
  /** The look, chosen at the start: real people or an animated style (changeable later in the options). */
  visualStyle: z.enum(VISUAL_STYLE_IDS).default('human'),
});
/** Projects page filters: category, whose work, and the order. */
const listQuery = z.strictObject({
  category: categorySchema.optional(),
  scope: z.enum(['all', 'mine', 'shared']).default('all'),
  sort: z.enum(['updated', 'created', 'size', 'title']).default('updated'),
});
const songSchema = z.strictObject({
  title: named(120, 'Enter the song title').optional(),
  artistName: named(120, 'Enter the artist or band name').optional(),
  aspect: ASPECT.optional(),
  genre: text(60).optional(),
  vision: text(4000).optional(),
  mood: text(200).optional(),
  leadAct: z.enum(['SOLO', 'DUO', 'TRIO', 'GROUP']).optional(),
});
const lyricsSchema = z.strictObject({ lines: z.array(z.strictObject({ start: z.number().min(0).max(1200), end: z.number().min(0).max(1200), text: text(300) })).max(600) });
const range = { start: z.number().min(0).max(1200), end: z.number().min(0).max(1200) };
/** A channel strip (see TrackFx in audio.ts). */
const fxSchema = z.strictObject({
  pan: z.number().min(-1).max(1).optional(),
  width: z.number().min(0).max(2).optional(),
  lowDb: z.number().min(-12).max(12).optional(),
  midDb: z.number().min(-12).max(12).optional(),
  midHz: z.number().min(200).max(6000).optional(),
  highDb: z.number().min(-12).max(12).optional(),
  highpassHz: z.number().min(0).max(2000).optional(),
  lowpassHz: z.number().min(0).max(20000).optional(),
  denoise: z.number().min(0).max(1).optional(),
});
const trackSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  gainDb: z.number().min(-60).max(12),
  muted: z.boolean().optional(),
  fx: fxSchema.optional(),
});
const audioSchema = z.strictObject({
  edits: z.strictObject({
    regions: z
      .array(
        z
          .strictObject({
            id: text(64),
            op: z.enum(['gain', 'cut', 'swap', 'fadein', 'fadeout']),
            ...range,
            gainDb: z.number().min(-60).max(12).optional(),
            swapWith: z.strictObject(range).optional(),
          })
          .refine((region) => region.end > region.start, { error: 'A region must end after it starts' }),
      )
      .max(60),
    layers: z
      .array(
        z.strictObject({
          id: text(64),
          assetId: uuid,
          at: z.number().min(0).max(1200),
          gainDb: z.number().min(-60).max(12).default(-6),
          trimStart: z.number().min(0).max(1200).default(0),
          trimEnd: z.number().min(0).max(1200).default(0),
          fadeIn: z.number().min(0).max(30).default(0.5),
          fadeOut: z.number().min(0).max(30).default(0.5),
          track: text(64).optional(),
          muted: z.boolean().optional(),
        }),
      )
      .max(200),
    gainDb: z.number().min(-24).max(12).optional(),
    // The storyboard arrangement / imported tracks ride along unchanged (a Sound-stage save drops the clips).
    clips: z.array(z.unknown()).optional(),
    tracks: z.array(trackSchema).max(16).optional(),
    musicFx: fxSchema.optional(),
    overlayFx: fxSchema.optional(),
  }),
  loudnessLufs: z.number().min(-30).max(-6).optional(),
});
const attributes = z.strictObject({
  gender: text(40).optional(),
  ageRange: text(40).optional(),
  heightCm: z.number().int().min(50, { error: 'Height is in centimetres (e.g. 178)' }).max(272, { error: 'Height is in centimetres (e.g. 178)' }).optional(),
  build: text(80).optional(),
  skinTone: text(80).optional(),
  hairStyle: text(120).optional(),
  hairColor: text(60).optional(),
  hairLength: text(60).optional(),
  bald: z.boolean().optional(),
  facialHair: text(120).optional(),
  eyes: text(80).optional(),
  marks: text(300).optional(),
  glamLevel: z.number().int().min(0).max(5).optional(),
  persona: text(400).optional(),
  signatureMoves: text(400).optional(),
  accessories: text(300).optional(),
  notes: text(1000).optional(),
});
const costume = z.strictObject({ id: text(64).optional(), name: text(80).min(1), description: text(800).min(3), palette: text(120).optional(), accessories: text(300).optional(), footwear: text(120).optional() });
const ROLE = z.enum(['LEAD', 'CO_LEAD', 'SECOND_LEAD', 'VIXEN', 'SUPPORTING', 'DANCER', 'EXTRA']);
const characterSchema = z.strictObject({
  role: ROLE.optional(),
  name: named(80, 'Give the character a name').optional(),
  isArtist: z.boolean().optional(),
  attributes: attributes.optional(),
  costumes: z.array(costume).max(12).optional(),
  mediaAssetIds: z.array(uuid).max(30).optional(),
  profile: text(director.PROFILE_MAX).optional(),
  prompt: text(director.PROMPT_MAX).optional(),
});
const newCharacterSchema = characterSchema.extend({ role: ROLE, name: named(80, 'Give the character a name') });
const sceneSchema = z.strictObject({
  title: z.string().trim().max(80).optional(),
  subtitle: z.string().trim().max(120).optional(),
  description: text(1000).min(3).optional(),
  prompt: text(2000).optional(),
  shot: z.enum(SHOT_IDS).optional(),
  transition: z.enum(TRANSITION_IDS).optional(),
  durationSec: z.number().min(2).max(10).optional(),
  characterIds: z.array(uuid).max(8).optional(),
  costume: text(500).optional(),
  location: text(200).optional(),
  timeOfDay: text(24).optional(),
  lyric: text(300).optional(),
  lipSync: z.boolean().optional(),
  transitionMode: z.enum(['MANUAL', 'AI']).optional(),
  mode: z.enum(['PERFORMANCE', 'NARRATIVE', 'BROLL']).optional(),
  emotion: z.enum(PERFORMANCE_EMOTION_IDS).nullable().optional(),
  intensity: z.number().int().min(1).max(3).optional(),
});
const messageTitlesParams = projectParams.extend({ messageId: uuid });
const directionBody = directionSchema.partial().strict();
const newSceneSchema = sceneSchema.extend({ description: text(1000).min(3), afterSceneId: uuid.optional() });
const orderSchema = z.strictObject({ order: z.array(uuid).max(120) });
const expandSchema = z.strictObject({ notes: text(1000).optional() });
const messageSchema = z.strictObject({ message: text(3000).min(2) });
const storyboardSchema = z.strictObject({ sceneCount: z.number().int().min(3).max(60).optional() });
const shootSchema = z.strictObject({ takes: z.number().int().min(1).max(4).default(2), dryRun: z.boolean().default(false) });
const autoSchema = z.strictObject({ dryRun: z.boolean().default(false) });
const masterSchema = z.strictObject({ finish: finishSchema.optional(), dryRun: z.boolean().default(false), ignoreFlops: z.boolean().default(false) });

export const musicVideoRouter: Router = Router({ mergeParams: true });
musicVideoRouter.use(authenticate);

type Handler = (req: Request, res: Response) => Promise<unknown>;
const send = (handler: Handler) => async (req: Request, res: Response) => {
  res.json(await handler(req, res));
};
const p = <S extends z.ZodType>(res: Response, schema: S) => validParams(res, schema);

musicVideoRouter.get('/', validate({ params: workspaceParams, query: listQuery }), send(async (req, res) => ({
  items: await director.list(requireAuth(req), p(res, workspaceParams).workspaceId, validQuery(res, listQuery)),
})));
musicVideoRouter.post('/', validate({ params: workspaceParams, body: createSchema }), send(async (req, res) => ({ project: await director.create(requireAuth(req), p(res, workspaceParams).workspaceId, validBody(req, createSchema)) })));

/** The change fingerprint: pages poll this and reload the project only when it changes. */
musicVideoRouter.get('/:projectId/version', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  await director.access(requireAuth(req), workspaceId, false);
  return { version: await projectVersion(workspaceId, projectId) };
}));
musicVideoRouter.get('/:projectId', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.view(requireAuth(req), workspaceId, projectId) };
}));
musicVideoRouter.patch('/:projectId/song', validate({ params: projectParams, body: songSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.updateSong(requireAuth(req), workspaceId, projectId, validBody(req, songSchema)) };
}));
// The artist's lines: a few samples (spelling hints) or the full lyrics (kept word for word, timed to the song).
const transcribeSchema = z.strictObject({ hint: text(8000).optional() }).optional();
musicVideoRouter.post('/:projectId/lyrics', validate({ params: projectParams, body: transcribeSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.transcribeLyrics(requireAuth(req), workspaceId, projectId, validBody(req, transcribeSchema)?.hint) };
}));
const polishSchema = lyricsSchema.extend({ samples: text(4000).min(3, { error: 'Write at least one line of the lyrics yourself' }) });
musicVideoRouter.post('/:projectId/lyrics/polish', validate({ params: projectParams, body: polishSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, polishSchema);
  return director.polishWithSamples(requireAuth(req), workspaceId, projectId, body.lines, body.samples);
}));
const smartLyricsSchema = z.strictObject({ corrections: z.array(z.strictObject({ index: z.number().int().min(0), text: text(300).min(1) })).min(1).max(100) });
musicVideoRouter.post('/:projectId/lyrics/proofread', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return director.proofread(requireAuth(req), workspaceId, projectId);
}));
musicVideoRouter.post('/:projectId/lyrics/smart-correct', validate({ params: projectParams, body: smartLyricsSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return director.smartCorrectLyrics(requireAuth(req), workspaceId, projectId, validBody(req, smartLyricsSchema).corrections);
}));
const smartSaveSchema = lyricsSchema.extend({ pairs: z.array(z.strictObject({ index: z.number().int().min(0), before: text(300), after: text(300).min(1) })).max(100).default([]), ai: z.boolean().default(false) });
musicVideoRouter.post('/:projectId/lyrics/smart-save', validate({ params: projectParams, body: smartSaveSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, smartSaveSchema);
  return director.smartSaveLyrics(requireAuth(req), workspaceId, projectId, body.lines, body.pairs, body.ai);
}));
const subtitlesSchema = z.strictObject({ on: z.boolean() });
musicVideoRouter.put('/:projectId/scenes/:sceneId/subtitles', validate({ params: sceneParams, body: subtitlesSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.setSceneSubtitles(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, subtitlesSchema).on) };
}));
musicVideoRouter.put('/:projectId/lyrics', validate({ params: projectParams, body: lyricsSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.updateLyrics(requireAuth(req), workspaceId, projectId, validBody(req, lyricsSchema).lines) };
}));
musicVideoRouter.put('/:projectId/audio', validate({ params: projectParams, body: audioSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, audioSchema);
  return { project: await director.saveAudio(requireAuth(req), workspaceId, projectId, { ...body.edits, clips: undefined }, body.loudnessLufs) };
}));
musicVideoRouter.post('/:projectId/audio/render', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.renderAudio(requireAuth(req), workspaceId, projectId) };
}));

musicVideoRouter.post('/:projectId/characters', validate({ params: projectParams, body: newCharacterSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.addCharacter(requireAuth(req), workspaceId, projectId, validBody(req, newCharacterSchema)) };
}));
musicVideoRouter.patch('/:projectId/characters/:characterId', validate({ params: characterParams, body: characterSchema }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return { project: await director.updateCharacter(requireAuth(req), workspaceId, projectId, characterId, validBody(req, characterSchema)) };
}));
musicVideoRouter.delete('/:projectId/characters/:characterId', validate({ params: characterParams }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return { project: await director.deleteCharacter(requireAuth(req), workspaceId, projectId, characterId) };
}));
const detectSchema = z.strictObject({ assetIds: z.array(uuid).min(1).max(40) });
musicVideoRouter.post('/:projectId/characters/detect', validate({ params: projectParams, body: detectSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return director.detectCast(requireAuth(req), workspaceId, projectId, validBody(req, detectSchema).assetIds);
}));
const bulkSchema = z.strictObject({ people: z.array(newCharacterSchema).min(1).max(24) });
musicVideoRouter.post('/:projectId/characters/bulk', validate({ params: projectParams, body: bulkSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.addCharacters(requireAuth(req), workspaceId, projectId, validBody(req, bulkSchema).people) };
}));
const mediaParams = characterParams.extend({ assetId: uuid });
musicVideoRouter.delete('/:projectId/characters/:characterId/media/:assetId', validate({ params: mediaParams }), send(async (req, res) => {
  const { workspaceId, projectId, characterId, assetId } = p(res, mediaParams);
  return { project: await director.removeCharacterMedia(requireAuth(req), workspaceId, projectId, characterId, assetId) };
}));
/* No real photo: create the character's look (portrait + full body) from the description, then the casting sheet. */
const lookBody = z.strictObject({ dryRun: z.boolean().default(false) });
musicVideoRouter.post('/:projectId/characters/:characterId/create-look', validate({ params: characterParams, body: lookBody }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return characterLook.createCharacterLook(requireAuth(req), workspaceId, projectId, characterId, validBody(req, lookBody), req.ip ?? null);
}));
musicVideoRouter.post('/:projectId/characters/:characterId/consent', validate({ params: characterParams }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return { project: await director.consentCharacter(requireAuth(req), workspaceId, projectId, characterId, req.ip ?? null) };
}));
const meSchema = z.strictObject({ on: z.boolean() });
musicVideoRouter.put('/:projectId/characters/:characterId/me', validate({ params: characterParams, body: meSchema }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return { project: await director.setCharacterMe(requireAuth(req), workspaceId, projectId, characterId, validBody(req, meSchema).on, req.ip ?? null) };
}));
const optionsSchema = z.strictObject({ creativeMode: z.boolean().optional(), cameraEnergy: z.enum(['natural', 'bold', 'wild']).optional(), visualStyle: z.enum(VISUAL_STYLE_IDS).optional(), subtitles: z.boolean().optional(), foley: z.boolean().optional(), autoApprove: z.boolean().optional() });
musicVideoRouter.put('/:projectId/options', validate({ params: projectParams, body: optionsSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.setOptions(requireAuth(req), workspaceId, projectId, validBody(req, optionsSchema)) };
}));
musicVideoRouter.post('/:projectId/characters/:characterId/cast', validate({ params: characterParams }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return { project: await director.castOne(requireAuth(req), workspaceId, projectId, characterId) };
}));
musicVideoRouter.post('/:projectId/characters/:characterId/approve', validate({ params: characterParams }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return { project: await director.approveCharacter(requireAuth(req), workspaceId, projectId, characterId) };
}));

musicVideoRouter.post('/:projectId/scenes', validate({ params: projectParams, body: newSceneSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.addScene(requireAuth(req), workspaceId, projectId, validBody(req, newSceneSchema)) };
}));
// Artist upload link (musicvideo/intake.ts): the public link the artist fills in once.
musicVideoRouter.get('/:projectId/intake', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { intake: await intake.getIntake(requireAuth(req), workspaceId, projectId) };
}));
musicVideoRouter.put('/:projectId/intake', validate({ params: projectParams, body: intake.intakeSettingsSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { intake: await intake.saveIntake(requireAuth(req), workspaceId, projectId, validBody(req, intake.intakeSettingsSchema)) };
}));
musicVideoRouter.post('/:projectId/intake/reopen', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { intake: await intake.reopenIntake(requireAuth(req), workspaceId, projectId) };
}));
musicVideoRouter.delete('/:projectId/intake', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { intake: await intake.deleteIntake(requireAuth(req), workspaceId, projectId) };
}));
const intakeUseSchema = z.strictObject({ song: z.boolean(), photos: z.boolean() });
musicVideoRouter.post('/:projectId/intake/use', validate({ params: projectParams, body: intakeUseSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await intake.useIntake(requireAuth(req), workspaceId, projectId, validBody(req, intakeUseSchema)) };
}));

// Text cards: a blank screen (colour / gradient / vignette) with styled text, as a scene. Free.
musicVideoRouter.post('/:projectId/scenes/text-card', validate({ params: projectParams, body: textCard.newTextCardSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await textCard.addTextCard(requireAuth(req), workspaceId, projectId, validBody(req, textCard.newTextCardSchema)) };
}));
musicVideoRouter.put('/:projectId/scenes/:sceneId/card-background', validate({ params: sceneParams, body: textCard.cardBackgroundSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await textCard.setCardBackground(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, textCard.cardBackgroundSchema)) };
}));
musicVideoRouter.put('/:projectId/scenes/order', validate({ params: projectParams, body: orderSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.reorderScenes(requireAuth(req), workspaceId, projectId, validBody(req, orderSchema).order) };
}));
musicVideoRouter.post('/:projectId/scenes/approve-all', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return director.approveAllScenes(requireAuth(req), workspaceId, projectId);
}));
musicVideoRouter.post('/:projectId/scenes/:sceneId/unapprove', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.unapproveScene(requireAuth(req), workspaceId, projectId, sceneId) };
}));
musicVideoRouter.patch('/:projectId/scenes/:sceneId', validate({ params: sceneParams, body: sceneSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.updateScene(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, sceneSchema)) };
}));
musicVideoRouter.delete('/:projectId/scenes/:sceneId', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.deleteScene(requireAuth(req), workspaceId, projectId, sceneId) };
}));
musicVideoRouter.post('/:projectId/scenes/:sceneId/expand', validate({ params: sceneParams, body: expandSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return director.expand(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, expandSchema).notes);
}));
musicVideoRouter.post('/:projectId/scenes/:sceneId/approve', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.approveScene(requireAuth(req), workspaceId, projectId, sceneId) };
}));

musicVideoRouter.post('/:projectId/messages', validate({ params: projectParams, body: messageSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.sendMessage(requireAuth(req), workspaceId, projectId, validBody(req, messageSchema).message) };
}));
musicVideoRouter.post('/:projectId/messages/apply-all', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.applyAllProposals(requireAuth(req), workspaceId, projectId) };
}));
musicVideoRouter.post('/:projectId/messages/:messageId/proposals/:proposalId/apply', validate({ params: proposalParams }), send(async (req, res) => {
  const { workspaceId, projectId, messageId, proposalId } = p(res, proposalParams);
  return { project: await director.applyProposal(requireAuth(req), workspaceId, projectId, messageId, proposalId) };
}));
musicVideoRouter.post('/:projectId/messages/:messageId/titles/apply', validate({ params: messageTitlesParams }), send(async (req, res) => {
  const { workspaceId, projectId, messageId } = p(res, messageTitlesParams);
  return { project: await director.applyTitles(requireAuth(req), workspaceId, projectId, messageId) };
}));
musicVideoRouter.put('/:projectId/titles', validate({ params: projectParams, body: titlesSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.setTitles(requireAuth(req), workspaceId, projectId, validBody(req, titlesSchema)) };
}));
musicVideoRouter.put('/:projectId/direction', validate({ params: projectParams, body: directionBody }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.setDirection(requireAuth(req), workspaceId, projectId, validBody(req, directionBody)) };
}));
musicVideoRouter.post('/:projectId/scenes/lock-to-song', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.lockScenesToSong(requireAuth(req), workspaceId, projectId) };
}));
musicVideoRouter.post('/:projectId/storyboard', validate({ params: projectParams, body: storyboardSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.buildStoryboard(requireAuth(req), workspaceId, projectId, validBody(req, storyboardSchema).sceneCount) };
}));

musicVideoRouter.post('/:projectId/stages/:stage/approve', validate({ params: stageParams }), send(async (req, res) => {
  const { workspaceId, projectId, stage } = p(res, stageParams);
  return { project: await director.approveStage(requireAuth(req), workspaceId, projectId, stage) };
}));
musicVideoRouter.post('/:projectId/stages/:stage/open', validate({ params: stageParams }), send(async (req, res) => {
  const { workspaceId, projectId, stage } = p(res, stageParams);
  return { project: await director.openStage(requireAuth(req), workspaceId, projectId, stage) };
}));
musicVideoRouter.post('/:projectId/stages/:stage/reopen', validate({ params: stageParams }), send(async (req, res) => {
  const { workspaceId, projectId, stage } = p(res, stageParams);
  return { project: await director.reopenStage(requireAuth(req), workspaceId, projectId, stage) };
}));

musicVideoRouter.post('/:projectId/scenes/:sceneId/shoot', validate({ params: sceneParams, body: shootSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  const body = validBody(req, shootSchema);
  return director.shoot(requireAuth(req), workspaceId, projectId, sceneId, body.takes, body.dryRun);
}));
musicVideoRouter.post('/:projectId/scenes/:sceneId/approve-shot', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.approveShot(requireAuth(req), workspaceId, projectId, sceneId) };
}));
musicVideoRouter.post('/:projectId/auto', validate({ params: projectParams, body: autoSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return director.autoShoot(requireAuth(req), workspaceId, projectId, validBody(req, autoSchema).dryRun);
}));
/* Auto Director: song + cast in, the finished video out (godMode.ts). */
musicVideoRouter.get('/:projectId/god', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return god.startGodMode(requireAuth(req), workspaceId, projectId, true);
}));
musicVideoRouter.post('/:projectId/god', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return god.startGodMode(requireAuth(req), workspaceId, projectId, false);
}));
musicVideoRouter.post('/:projectId/god/stop', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return god.stopGodMode(requireAuth(req), workspaceId, projectId);
}));
musicVideoRouter.post('/:projectId/master', validate({ params: projectParams, body: masterSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, masterSchema);
  return director.master(requireAuth(req), workspaceId, projectId, body.finish, body.dryRun, body.ignoreFlops);
}));
musicVideoRouter.post('/:projectId/master/ai', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return director.aiMasterProject(requireAuth(req), workspaceId, projectId);
}));
/** keep = stop the cut and publish what's done so far as a playable preview. */
const stopMasterSchema = z.strictObject({ keep: z.boolean().default(true) }).optional();
musicVideoRouter.post('/:projectId/master/stop', validate({ params: projectParams, body: stopMasterSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.stopMaster(requireAuth(req), workspaceId, projectId, validBody(req, stopMasterSchema)?.keep ?? true) };
}));
musicVideoRouter.post('/:projectId/scenes/:sceneId/unlock-shot', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.unlockShot(requireAuth(req), workspaceId, projectId, sceneId) };
}));
const mixRangeSchema = z.strictObject({
  start: z.number().min(0).max(1200),
  end: z.number().min(0).max(1200),
  op: z.enum(['cut', 'mute', 'gain', 'fadein', 'fadeout']),
  gainDb: z.number().min(-24).max(12).optional(),
});
const gainSchema = z.strictObject({ gainDb: z.number().min(-24).max(12) });
const layersSchema = z.strictObject({
  layers: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(64),
        assetId: z.uuid(),
        at: z.number().min(0).max(1200),
        gainDb: z.number().min(-60).max(12),
        trimStart: z.number().min(0).max(1200),
        trimEnd: z.number().min(0).max(1200),
        fadeIn: z.number().min(0).max(30),
        fadeOut: z.number().min(0).max(30),
        // The imported track the event sits on (none = the overlay lane).
        track: z.string().trim().min(1).max(64).optional(),
        muted: z.boolean().optional(),
      }),
    )
    .max(60),
});
const mixerSchema = z.strictObject({
  tracks: z.array(trackSchema).max(16),
  layers: layersSchema.shape.layers,
  musicFx: fxSchema.optional(),
  overlayFx: fxSchema.optional(),
});
const analysisQuery = z.strictObject({ which: z.enum(['mix', 'original']).default('mix') });
musicVideoRouter.get('/:projectId/audio/analysis', validate({ params: projectParams, query: analysisQuery }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return director.audioAnalysis(requireAuth(req), workspaceId, projectId, validQuery(res, analysisQuery).which);
}));
musicVideoRouter.put('/:projectId/audio/gain', validate({ params: projectParams, body: gainSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.setTrackGain(requireAuth(req), workspaceId, projectId, validBody(req, gainSchema).gainDb) };
}));
const clipsSchema = z.strictObject({
  clips: z
    .array(
      z
        .strictObject({
          id: z.string().trim().min(1).max(64),
          src: z.number().min(0).max(1200),
          len: z.number().min(0.02).max(1200),
          at: z.number().min(0).max(1800),
          gainDb: z.number().min(-60).max(12),
          fadeIn: z.number().min(0).max(600),
          fadeOut: z.number().min(0).max(600),
          muted: z.boolean().optional(),
        })
        .refine((clip) => clip.fadeIn + clip.fadeOut <= clip.len + 0.001, { error: 'Fades can not be longer than the event' }),
    )
    .min(1)
    .max(400),
  /** Whole-track level of the song (the gain knob). */
  gainDb: z.number().min(-24).max(12).optional(),
  /** Imported audio tracks + their events. */
  tracks: z.array(trackSchema).max(16).optional(),
  layers: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(64),
        assetId: z.uuid(),
        at: z.number().min(0).max(1800),
        gainDb: z.number().min(-60).max(12),
        trimStart: z.number().min(0).max(1800),
        trimEnd: z.number().min(0).max(1800),
        fadeIn: z.number().min(0).max(600),
        fadeOut: z.number().min(0).max(600),
        track: z.string().trim().min(1).max(64).optional(),
        muted: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
});
musicVideoRouter.put('/:projectId/audio/clips', validate({ params: projectParams, body: clipsSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, clipsSchema);
  return { project: await director.saveClips(requireAuth(req), workspaceId, projectId, body.clips, { gainDb: body.gainDb, layers: body.layers, tracks: body.tracks }) };
}));
const sourceQuery = z.strictObject({ assetId: z.uuid().optional() });
musicVideoRouter.get('/:projectId/audio/source', validate({ params: projectParams, query: sourceQuery }), async (req: Request, res: Response) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const source = await director.songSource(requireAuth(req), workspaceId, projectId, validQuery(res, sourceQuery).assetId);
  res.setHeader('Content-Type', source.contentType);
  if (source.size !== undefined) res.setHeader('Content-Length', String(source.size));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  await pipeline(source.body, res);
});
/* Cold open: a short narrated film VeloBot directs to play before the song (prologue.ts). */
const prologuePlanBody = z.strictObject({ idea: z.string().trim().max(4000).optional(), seconds: z.number().min(10).max(45).default(20) });
const prologueSaveBody = z.strictObject({ plan: prologue.planSchema.optional(), enabled: z.boolean().optional() });
const prologueFilmBody = z.strictObject({
  dryRun: z.boolean().default(false),
  refilm: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  /** Just these shots (tried one by one before the mix); empty = everything, then the mix. */
  only: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  /** With `only`: just record their lines (hear them before filming). */
  voiceOnly: z.boolean().default(false),
});
musicVideoRouter.get('/:projectId/prologue', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return prologue.prologueView(requireAuth(req), workspaceId, projectId);
}));
musicVideoRouter.post('/:projectId/prologue/plan', validate({ params: projectParams, body: prologuePlanBody }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, prologuePlanBody);
  return prologue.planPrologue(requireAuth(req), workspaceId, projectId, { idea: body.idea, seconds: body.seconds });
}));
musicVideoRouter.put('/:projectId/prologue', validate({ params: projectParams, body: prologueSaveBody }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, prologueSaveBody);
  return prologue.savePrologue(requireAuth(req), workspaceId, projectId, { plan: body.plan, enabled: body.enabled });
}));
/** Deletes the cold open (filmOnly: keeps the plan, drops every clip, line and the film). */
const prologueDeleteBody = z.strictObject({ filmOnly: z.boolean().default(false) });
musicVideoRouter.post('/:projectId/prologue/delete', validate({ params: projectParams, body: prologueDeleteBody }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return prologue.deletePrologue(requireAuth(req), workspaceId, projectId, validBody(req, prologueDeleteBody).filmOnly);
}));
const prologueControlBody = z.strictObject({ action: z.enum(['pause', 'stop']) });
musicVideoRouter.post('/:projectId/prologue/control', validate({ params: projectParams, body: prologueControlBody }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return prologue.controlPrologue(requireAuth(req), workspaceId, projectId, validBody(req, prologueControlBody).action);
}));
musicVideoRouter.post('/:projectId/prologue/film', validate({ params: projectParams, body: prologueFilmBody }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, prologueFilmBody);
  return prologue.filmPrologue(requireAuth(req), workspaceId, projectId, body.dryRun, body.refilm, { only: body.only, voiceOnly: body.voiceOnly });
}));

/* Remix studio: a music video clip → a new short clip of its main character (remix.ts). */
const remixSchema = z.strictObject({
  mode: z.enum(['NEW', 'REFINE']),
  script: z.string().trim().min(20).max(4000),
  sourceAssetId: z.uuid(),
  audioAssetId: z.uuid().nullable().optional(),
  windowStart: z.number().min(0).max(1200),
  windowLength: z.number().min(remix.WINDOW_MIN).max(remix.WINDOW_MAX),
  artistName: z.string().trim().min(1).max(80),
  genre: z.string().trim().max(60).optional(),
  shootNow: z.boolean().optional(),
  consent: z.boolean(),
});
const remixEstimateQuery = z.strictObject({
  mode: z.enum(['NEW', 'REFINE']),
  windowLength: z.coerce.number().min(remix.WINDOW_MIN).max(remix.WINDOW_MAX),
  songSeconds: z.coerce.number().min(0).max(3600),
  shootNow: z.enum(['true', 'false']).default('false'),
});
musicVideoRouter.get('/:projectId/remix', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return remix.remixView(requireAuth(req), workspaceId, projectId);
}));
musicVideoRouter.get('/:projectId/remix/estimate', validate({ params: projectParams, query: remixEstimateQuery }), send(async (_req, res) => {
  const query = validQuery(res, remixEstimateQuery);
  return remix.remixEstimate({ mode: query.mode, windowLength: query.windowLength, songSeconds: query.songSeconds, shootNow: query.shootNow === 'true' });
}));
musicVideoRouter.post('/:projectId/remix', validate({ params: projectParams, body: remixSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return remix.startRemix(requireAuth(req), workspaceId, projectId, validBody(req, remixSchema), req.ip ?? null);
}));
musicVideoRouter.put('/:projectId/audio/mixer', validate({ params: projectParams, body: mixerSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  const body = validBody(req, mixerSchema);
  return { project: await director.saveMixer(requireAuth(req), workspaceId, projectId, { tracks: body.tracks, layers: body.layers, musicFx: body.musicFx, overlayFx: body.overlayFx }) };
}));
musicVideoRouter.put('/:projectId/audio/layers', validate({ params: projectParams, body: layersSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.saveLayers(requireAuth(req), workspaceId, projectId, validBody(req, layersSchema).layers) };
}));
/** Batch sizes in order ([2, 4] = first 2 scenes, then 4 at a time); pauseBetween = stop for review after each batch. */
const sequenceSchema = z.strictObject({ sizes: z.array(z.number().int().min(1).max(8)).min(1).max(12).optional(), pauseBetween: z.boolean().optional() }).optional();
musicVideoRouter.post('/:projectId/sequence/start', validate({ params: projectParams, body: sequenceSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.startSequence(requireAuth(req), workspaceId, projectId, validBody(req, sequenceSchema) ?? {}) };
}));
/** now = also cancel the shot(s) being filmed (default: let them finish, start nothing else). */
const stopSchema = z.strictObject({ now: z.boolean().optional() }).optional();
musicVideoRouter.post('/:projectId/sequence/stop', validate({ params: projectParams, body: stopSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.stopSequence(requireAuth(req), workspaceId, projectId, validBody(req, stopSchema)?.now ?? false) };
}));
musicVideoRouter.post('/:projectId/scenes/:sceneId/review', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.reviewScene(requireAuth(req), workspaceId, projectId, sceneId) };
}));
const takeReviewParams = projectParams.extend({ takeId: uuid });
musicVideoRouter.post('/:projectId/takes/:takeId/review/dismiss', validate({ params: takeReviewParams }), send(async (req, res) => {
  const { workspaceId, projectId, takeId } = p(res, takeReviewParams);
  return { project: await director.dismissSceneReview(requireAuth(req), workspaceId, projectId, takeId) };
}));
musicVideoRouter.post('/:projectId/scenes/:sceneId/stop', validate({ params: sceneParams }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await director.stopScene(requireAuth(req), workspaceId, projectId, sceneId) };
}));
musicVideoRouter.post('/:projectId/audio/range', validate({ params: projectParams, body: mixRangeSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.editMixRange(requireAuth(req), workspaceId, projectId, validBody(req, mixRangeSchema)) };
}));
musicVideoRouter.post('/:projectId/polish', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { project: await director.polish(requireAuth(req), workspaceId, projectId) };
}));

/* Character photo shoots: stills of a cast member in a scripted scene (any stage after casting). */
const photoParams = projectParams.extend({ photoId: uuid });
const shootPhotosSchema = z.strictObject({
  sceneId: uuid.optional(),
  brief: text(2000).optional(),
  count: z.number().int().min(1).max(4).default(2),
  aspect: ASPECT.optional(),
  dryRun: z.boolean().default(false),
});
musicVideoRouter.get('/:projectId/photos', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return { items: await photos.listPhotos(requireAuth(req), workspaceId, projectId) };
}));
musicVideoRouter.post('/:projectId/characters/:characterId/photos', validate({ params: characterParams, body: shootPhotosSchema }), send(async (req, res) => {
  const { workspaceId, projectId, characterId } = p(res, characterParams);
  return photos.shootPhotos(requireAuth(req), workspaceId, projectId, characterId, validBody(req, shootPhotosSchema));
}));
musicVideoRouter.delete('/:projectId/photos/:photoId', validate({ params: photoParams }), send(async (req, res) => {
  const { workspaceId, projectId, photoId } = p(res, photoParams);
  return { project: await photos.deletePhoto(requireAuth(req), workspaceId, projectId, photoId) };
}));
const firstFrameSchema = z.strictObject({ sceneId: uuid });
musicVideoRouter.post('/:projectId/photos/:photoId/first-frame', validate({ params: photoParams, body: firstFrameSchema }), send(async (req, res) => {
  const { workspaceId, projectId, photoId } = p(res, photoParams);
  return { project: await photos.useAsFirstFrame(requireAuth(req), workspaceId, projectId, photoId, validBody(req, firstFrameSchema).sceneId) };
}));

/*
 * Quick mix & master (1–3 consecutive scenes → a named, mastered teaser):
 *   POST /:projectId/clips/preview          { sceneIds } price, length, suggested name, review warnings (free)
 *   POST /:projectId/clips                  { sceneIds, name } start (token-gated)
 *   GET  /:projectId/clips                  this video's clips, newest first
 *   GET  /:projectId/clips/:clipId          one clip (progress while rendering)
 *   GET  /:projectId/clips/:clipId/download a short-lived link that saves under the clip's name
 */
const clipParams = projectParams.extend({ clipId: uuid });
const clipScenes = z.array(uuid).min(1, { error: 'Select at least one scene' }).max(quickClip.MAX_CLIP_SCENES, { error: `Select up to ${quickClip.MAX_CLIP_SCENES} scenes` });
const clipPreviewSchema = z.strictObject({ sceneIds: clipScenes });
const clipCreateSchema = z.strictObject({ sceneIds: clipScenes, name: text(100).min(2, { error: 'Give the clip a name' }) });
musicVideoRouter.post('/:projectId/clips/preview', validate({ params: projectParams, body: clipPreviewSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return quickClip.previewClip(requireAuth(req), workspaceId, projectId, validBody(req, clipPreviewSchema).sceneIds);
}));
musicVideoRouter.post('/:projectId/clips', validate({ params: projectParams, body: clipCreateSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return quickClip.createClip(requireAuth(req), workspaceId, projectId, validBody(req, clipCreateSchema));
}));
musicVideoRouter.get('/:projectId/clips', validate({ params: projectParams }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return quickClip.listClips(requireAuth(req), workspaceId, projectId);
}));
musicVideoRouter.get('/:projectId/clips/:clipId', validate({ params: clipParams }), send(async (req, res) => {
  const { workspaceId, projectId, clipId } = p(res, clipParams);
  return quickClip.getClip(requireAuth(req), workspaceId, projectId, clipId);
}));
musicVideoRouter.get('/:projectId/clips/:clipId/download', validate({ params: clipParams }), send(async (req, res) => {
  const { workspaceId, projectId, clipId } = p(res, clipParams);
  return quickClip.clipDownload(requireAuth(req), workspaceId, projectId, clipId);
}));

/*
 * Scene tools:
 *   POST /:projectId/scenes/:sceneId/duplicate  { withVideo, afterSceneId? } copy (paste after another scene with afterSceneId)
 *   POST /:projectId/scenes/:sceneId/tweak      { instruction, lipSync, frameAt? } a new scene from a frame of this one's video
 */
/* Every generated video of the project (scene takes; optionally the master, quick clips, the cold-open film). Scenes stay. */
const deleteVideosSchema = z.strictObject({ master: z.boolean().default(false), clips: z.boolean().default(false), coldOpen: z.boolean().default(false) });
musicVideoRouter.post('/:projectId/videos/delete-all', validate({ params: projectParams, body: deleteVideosSchema }), send(async (req, res) => {
  const { workspaceId, projectId } = p(res, projectParams);
  return sceneTools.deleteAllVideos(requireAuth(req), workspaceId, projectId, validBody(req, deleteVideosSchema));
}));
const duplicateSchema = z.strictObject({ withVideo: z.boolean().default(true), afterSceneId: uuid.optional() });
musicVideoRouter.post('/:projectId/scenes/:sceneId/duplicate', validate({ params: sceneParams, body: duplicateSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await sceneTools.duplicateScene(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, duplicateSchema)) };
}));
const tweakSchema = z.strictObject({
  instruction: text(600).min(4, { error: 'Describe what should change (an expression, a motion…)' }),
  lipSync: z.boolean().default(false),
  frameAt: z.number().min(0).max(60).optional(),
});
musicVideoRouter.post('/:projectId/scenes/:sceneId/tweak', validate({ params: sceneParams, body: tweakSchema }), send(async (req, res) => {
  const { workspaceId, projectId, sceneId } = p(res, sceneParams);
  return { project: await sceneTools.tweakScene(requireAuth(req), workspaceId, projectId, sceneId, validBody(req, tweakSchema)) };
}));
