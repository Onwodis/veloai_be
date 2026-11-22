/**
 * Auto Director: the artist brings the song and the cast (photos + their permission), presses one
 * button, and the app does everything else, the way a production company would:
 *
 *   lyrics     transcribed (if not yet): the story and the lip sync are built on the words
 *   song       a vision written from the genre when the artist left it short; song + sound approved
 *   cast       every person cast from their photos (casting sheet), then approved
 *   story      the director writes the whole storyboard, timed to the song, every scene approved
 *   director   the director reviews it for the hook and the rhythm of the cuts; its fixes applied
 *   titles     artist and song title in the music-intro look, publishing rights at the end
 *   film       every scene filmed (one take each, picked and locked as it lands) …
 *   master     … and the final cut mastered when the last one is in (auto mode does both)
 *
 * It never skips consent: anyone without recorded permission stops it before a token is spent.
 * The state lives on mv_projects.god_mode; the film / master steps are driven by auto mode, so a
 * server restart there loses nothing (resolveGod() reads how it ended).
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import type { AssetRow } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CharacterRow } from './cast.js';
import {
  access,
  applyAllProposals,
  approveAllScenes,
  approveCharacter,
  autoShoot,
  buildStoryboard,
  castOne,
  load,
  openStage,
  sendMessage,
  setTitles,
  transcribeLyrics,
  view,
} from './service.js';
import { parseTitles } from './titles.js';

export const GOD_STEPS = ['lyrics', 'song', 'cast', 'story', 'director', 'titles', 'film', 'master'] as const;
export type GodStep = (typeof GOD_STEPS)[number];
export type GodStepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

export interface GodState {
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'STOPPED';
  step: GodStep;
  steps: Record<GodStep, GodStepState>;
  error: string | null;
  /** What happened on the step (shown under it). */
  note: string | null;
  estimate: number;
  by: { userId: string; role: AuthContext['role'] };
  startedAt: string;
  finishedAt: string | null;
}

const LEAD_COUNT = { SOLO: 1, DUO: 2, TRIO: 3, GROUP: 4 } as const;

/** What the artist still has to give before Auto Director can run (empty = ready). */
export async function godReadiness(workspaceId: string, projectId: string): Promise<string[]> {
  const { project, mv } = await load(workspaceId, projectId);
  const missing: string[] = [];
  if (!project.musicAssetId && !mv.originalSongId) missing.push('Upload the song (Song & vision).');
  if (!mv.artistName.trim()) missing.push('Enter the artist name (Song & vision).');
  if (!mv.genre.trim()) missing.push('Choose the genre (Song & vision).');
  const cast = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId}`;
  const leads = cast.filter((person) => person.role === 'LEAD' || person.role === 'CO_LEAD');
  const needed = LEAD_COUNT[mv.leadAct];
  if (leads.length < needed) missing.push(`Add ${needed === 1 ? 'the lead artist' : `${needed} lead artists`} with photos (Characters).`);
  for (const person of cast) {
    if (!person.mediaAssetIds.length && !person.likenessUserId && !person.prompt) missing.push(`Add photos of ${person.name} (Characters).`);
    if (!person.consentAt) missing.push(`Record ${person.isArtist ? 'your' : `${person.name}'s`} permission to use their likeness (Characters).`);
  }
  return missing;
}

/** Tokens Auto Director will hold, step by step (the film is an estimate: one take per scene). */
export async function godEstimate(workspaceId: string, projectId: string): Promise<{ total: number; parts: { label: string; tokens: number }[] }> {
  const { project, mv } = await load(workspaceId, projectId);
  const { costs, limits, models } = await getStudioSettings();
  const songId = mv.originalSongId ?? project.musicAssetId;
  const [song] = songId ? await sql<AssetRow[]>`SELECT * FROM studio_assets WHERE id = ${songId}` : [];
  const seconds = song?.meta.durationSec ?? 200;
  const cast = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId}`;
  const scenes = Math.min(limits.maxScenes, Math.max(4, Math.ceil(seconds / 6)));
  const shot = (models.keyframe.enabled ? costs.keyframe : 0) + 7 * costs.videoPerSecond;
  const performances = Math.ceil(scenes / 3);
  const parts = [
    { label: 'Lyrics', tokens: mv.lyrics ? 0 : costs.mvLyricsPerMinute * Math.max(1, Math.ceil(seconds / 60)) },
    { label: `Casting (${cast.filter((person) => !person.prompt).length})`, tokens: cast.filter((person) => !person.prompt).length * costs.mvCasting },
    { label: 'Storyboard', tokens: costs.mvStoryboard },
    { label: "Director's review", tokens: costs.mvChat },
    { label: `Filming ~${scenes} scenes`, tokens: scenes * shot + performances * 7 * costs.lipSyncPerSecond },
    { label: 'Master', tokens: Math.max(1, Math.ceil(seconds / 60)) * costs.assemblyPerMinute },
  ];
  return { total: parts.reduce((sum, part) => sum + part.tokens, 0), parts };
}

const stepsFrom = (state: GodState | null): Record<GodStep, GodStepState> => state?.steps ?? (Object.fromEntries(GOD_STEPS.map((step) => [step, 'waiting'])) as Record<GodStep, GodStepState>);

async function save(projectId: string, state: GodState): Promise<void> {
  await sql`UPDATE mv_projects SET god_mode = ${json(state)}, updated_at = now() WHERE project_id = ${projectId}`;
}
async function current(projectId: string): Promise<GodState | null> {
  const [row] = await sql<{ godMode: GodState | null }[]>`SELECT god_mode FROM mv_projects WHERE project_id = ${projectId}`;
  return row?.godMode ?? null;
}

/**
 * The state as it stands, finishing the film / master steps from how auto mode ended (they run in
 * the take worker, not here): a master newer than the start = done; auto mode handed back with
 * an error = failed (the scenes made so far stay).
 */
export async function resolveGod(projectId: string): Promise<GodState | null> {
  const state = await current(projectId);
  if (!state || state.status !== 'RUNNING' || (state.step !== 'film' && state.step !== 'master')) return state;
  const [row] = await sql<{ autoMode: boolean; stage: string; status: string; outputKey: string | null; finishedAt: Date | null; error: string | null; updatedAt: Date }[]>`
    SELECT m.auto_mode, m.stage, p.status, p.output_key, p.finished_at, p.error, p.updated_at
    FROM mv_projects m JOIN studio_projects p ON p.id = m.project_id WHERE m.project_id = ${projectId}`;
  if (!row) return state;
  const started = new Date(state.startedAt).getTime();
  let next: GodState | null = null;
  if (row.status === 'READY' && row.outputKey && row.finishedAt && row.finishedAt.getTime() > started) {
    next = { ...state, status: 'DONE', step: 'master', steps: { ...state.steps, film: 'done', master: 'done' }, note: 'Your video is mastered. Watch it on the Master stage.', finishedAt: new Date().toISOString() };
  } else if (row.status === 'ASSEMBLING') {
    if (state.step !== 'master') next = { ...state, step: 'master', steps: { ...state.steps, film: 'done', master: 'running' }, note: 'Every scene is filmed: the final cut is being made.' };
  } else if (!row.autoMode && row.error && row.updatedAt.getTime() > started) {
    next = { ...state, status: 'FAILED', steps: { ...state.steps, [state.step]: 'failed' }, error: row.error, finishedAt: new Date().toISOString() };
  }
  if (next) await save(projectId, next);
  return next ?? state;
}

/** Runs Auto Director (or, with dryRun, returns what it needs and what it will cost). */
export async function startGodMode(auth: AuthContext, workspaceId: string, projectId: string, dryRun: boolean) {
  await access(auth, workspaceId, true);
  const missing = await godReadiness(workspaceId, projectId);
  const estimate = await godEstimate(workspaceId, projectId);
  if (dryRun) return { missing, estimate, god: await resolveGod(projectId) };
  if (missing.length) throw AppError.badRequest(`Auto Director needs: ${missing.join(' ')}`);
  const running = await resolveGod(projectId);
  if (running?.status === 'RUNNING') throw AppError.conflict('Auto Director is already running on this video.');

  let state: GodState = {
    status: 'RUNNING',
    step: 'lyrics',
    steps: stepsFrom(null),
    error: null,
    note: null,
    estimate: estimate.total,
    by: { userId: auth.userId, role: auth.role },
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  await save(projectId, state);
  // Every scene the director writes is approved as it lands; no click needed anywhere.
  await sql`UPDATE mv_projects SET auto_approve = true WHERE project_id = ${projectId}`;

  const step = async (name: GodStep, note: string | null = null): Promise<void> => {
    const live = await current(projectId);
    if (live?.status === 'STOPPED') throw new Stopped();
    state = { ...state, step: name, steps: { ...state.steps, [name]: 'running' }, note };
    await save(projectId, state);
  };
  const done = async (name: GodStep, outcome: GodStepState = 'done', note: string | null = null): Promise<void> => {
    state = { ...state, steps: { ...state.steps, [name]: outcome }, note };
    await save(projectId, state);
  };

  void (async () => {
    try {
      /* lyrics */
      await step('lyrics', 'Listening to the song for the words…');
      let { mv } = await load(workspaceId, projectId);
      if (mv.lyrics?.lines.length) {
        await done('lyrics', 'skipped', 'The lyrics were already there.');
      } else {
        await transcribeLyrics(auth, workspaceId, projectId).catch((error: unknown) => {
          if (!(error instanceof AppError && error.statusCode === 409)) throw error;
        });
        for (let waited = 0; waited < 20 * 60; waited += 4) {
          await new Promise((resolve) => setTimeout(resolve, 4000));
          ({ mv } = await load(workspaceId, projectId));
          if (mv.lyricsJob?.status !== 'RUNNING') break;
        }
        if (mv.lyricsJob?.status === 'DONE') await done('lyrics');
        else await done('lyrics', 'skipped', 'The words could not be transcribed; the story follows the music and your vision instead.');
      }

      /* song + sound */
      await step('song');
      ({ mv } = await load(workspaceId, projectId));
      if (mv.vision.trim().length < 20) {
        const vision = `A real, well-made ${mv.genre} music video for this song by ${mv.artistName}: the artist performs with conviction, intercut with a story drawn from the lyrics, in real places with real light; a scroll-stopping opening and bold camera work on the big moments.`;
        await sql`UPDATE mv_projects SET vision = ${vision} WHERE project_id = ${projectId}`;
      }
      await openStage(auth, workspaceId, projectId, 'CHARACTERS');
      await done('song');

      /* cast */
      await step('cast', 'Casting everyone from their photos…');
      const cast = await sql<CharacterRow[]>`SELECT * FROM mv_characters WHERE project_id = ${projectId} ORDER BY position`;
      for (const person of cast) {
        if (!person.prompt && !person.profile) await castOne(auth, workspaceId, projectId, person.id);
        await approveCharacter(auth, workspaceId, projectId, person.id);
      }
      await openStage(auth, workspaceId, projectId, 'SCENES');
      await done('cast', 'done', `${cast.length} cast member${cast.length === 1 ? '' : 's'} ready.`);

      /* story */
      await step('story', `${env.BOT_NAME} is writing the storyboard, timed to the song…`);
      await buildStoryboard(auth, workspaceId, projectId);
      await approveAllScenes(auth, workspaceId, projectId);
      const [{ count: scenes } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_scenes WHERE project_id = ${projectId}`;
      await done('story', 'done', `${scenes} scenes written and approved.`);

      /* director's review: the hook and the rhythm */
      await step('director', `${env.BOT_NAME} is reviewing the storyboard for the hook and the cuts…`);
      await openStage(auth, workspaceId, projectId, 'DISCUSSION');
      await sendMessage(
        auth,
        workspaceId,
        projectId,
        'Auto Director: you are directing this end to end. Review the storyboard like a top music-video director: is the first scene a hook that stops a viewer scrolling within a second? Does every cut change the shot size, angle or move? Are the biggest camera moves on the drops and chorus hits, and are the lip-synced performances face-safe and strong? Propose the fixes as concrete scene changes.',
      );
      await applyAllProposals(auth, workspaceId, projectId).catch((error: unknown) => logger.warn({ err: error, projectId }, 'Auto Director: no proposals applied'));
      await done('director');

      /* titles */
      await step('titles');
      ({ mv } = await load(workspaceId, projectId));
      const { project } = await load(workspaceId, projectId);
      const titles = parseTitles(mv.titles, mv.artistName, project.title);
      if (!titles.enabled) {
        await setTitles(auth, workspaceId, projectId, {
          ...titles,
          enabled: true,
          artist: mv.artistName.slice(0, 80),
          song: project.title.slice(0, 80),
          placement: 'over-intro',
          template: 'music-intro',
          rights: titles.rights || `℗ ${new Date().getFullYear()} ${mv.artistName}. All rights reserved.`.slice(0, 300),
        });
        await done('titles');
      } else {
        await done('titles', 'skipped', 'Your own titles are kept.');
      }

      /* film (+ master): auto mode films one take per scene, picks and locks each, then masters */
      await step('film', 'Filming every scene: each one is picked and locked as it lands.');
      await sql`
        UPDATE mv_projects SET approvals = approvals || ${json({ DISCUSSION: new Date().toISOString(), STORYBOARD: new Date().toISOString() })}, stage = 'SHOOT', updated_at = now()
        WHERE project_id = ${projectId}`;
      await autoShoot(auth, workspaceId, projectId, false);
      // From here the take worker drives it; resolveGod() reads how it ends.
    } catch (error) {
      if (error instanceof Stopped) return;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      logger.error({ err: error, projectId, step: state.step }, 'Auto Director failed');
      state = { ...state, status: 'FAILED', steps: { ...state.steps, [state.step]: 'failed' }, error: message, finishedAt: new Date().toISOString() };
      await save(projectId, state).catch(() => undefined);
    }
  })();
  return { missing: [], estimate, god: state, project: await view(auth, workspaceId, projectId) };
}

class Stopped extends Error {}

/** Stops Auto Director: the step in hand finishes (paid work is kept), nothing new starts; auto filming stops too. */
export async function stopGodMode(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  const state = await current(projectId);
  if (!state || state.status !== 'RUNNING') throw AppError.badRequest('Auto Director is not running.');
  await save(projectId, { ...state, status: 'STOPPED', note: 'Stopped. Everything made so far is kept: carry on by hand from any stage.', finishedAt: new Date().toISOString() });
  await sql`UPDATE mv_projects SET auto_mode = false WHERE project_id = ${projectId}`;
  return { god: await current(projectId), project: await view(auth, workspaceId, projectId) };
}
