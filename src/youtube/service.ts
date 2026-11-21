/**
 * YouTube films: shows, their films, and the schedule.
 *
 * A show (niche, kind, look, cast, length, publish days + times, channel) plans its films two weeks
 * ahead. Each film moves PLANNED → SCRIPTED (written a day ahead, free; editable) → MAKING (paid:
 * the price is held from the wallet when making starts, charged only when the film is finished,
 * released if it fails) → READY → PUBLISHED. In REVIEW mode a READY film waits for the creator's
 * approval; in AUTOPILOT it publishes on time. Films that can't go ahead (no funds, no channel)
 * are BLOCKED with the reason, and retried on the next run.
 */
import { z } from 'zod';
import type { AuthContext } from '../middleware/authenticate.js';
import { readUrl } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import { requireMembership } from '../services/workspace.service.js';
import { VISUAL_STYLE_IDS } from '../studio/cinema.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { rm } from 'node:fs/promises';
import { FILM_KIND_IDS, MOOD_IDS, NARRATORS, type FilmKind, type Mood } from './catalog.js';
import { uploadVideo, youtubeConfigured } from './channels.js';
import { fetchForUpload, makeFilm, type MakerShow } from './maker.js';
import { filmPrice, getYoutubeSettings, upcomingSlots, validTimeZone } from './settings.js';
import { filmScriptSchema, fitScenes, writeFilm, type FilmScript, type ShowCharacter } from './writer.js';

/* ------------------------------------------------------------------ schemas */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use a 24-hour time such as 17:00' });

export const showSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  niche: z.string().trim().min(2).max(300),
  filmKind: z.enum(FILM_KIND_IDS),
  visualStyle: z.enum(VISUAL_STYLE_IDS),
  mood: z.enum(MOOD_IDS),
  format: z.enum(['16:9', '9:16']),
  lengthSeconds: z.number().int().min(10).max(1800),
  language: z.string().trim().min(2).max(40),
  narrator: z.enum(NARRATORS),
  audience: z.string().trim().max(300).default(''),
  notes: z.string().trim().max(1500).default(''),
  characters: z.array(z.strictObject({ name: z.string().trim().min(1).max(40), description: z.string().trim().min(3).max(400) })).max(4).default([]),
  publishDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  publishTimes: z.array(time).min(1).max(3),
  timezone: z.string().trim().max(64).refine(validTimeZone, { error: 'Unknown time zone' }),
  privacy: z.enum(['private', 'unlisted', 'public']),
  mode: z.enum(['AUTOPILOT', 'REVIEW']),
  channelId: z.uuid().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED']).default('ACTIVE'),
});
export type ShowInput = z.infer<typeof showSchema>;

export const filmEditSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(4900),
  tags: z.array(z.string().trim().min(1).max(60)).max(15),
  thumbnailText: z.string().trim().max(40),
  scenes: z
    .array(z.strictObject({ seconds: z.union([z.literal(5), z.literal(10)]), visual: z.string().trim().min(3).max(1200), camera: z.string().trim().max(200), characters: z.array(z.string().max(40)).max(4), narration: z.string().trim().max(600) }))
    .min(1)
    .max(200),
});

/* ------------------------------------------------------------------ rows */

interface ShowRow {
  id: string;
  workspaceId: string;
  createdBy: string;
  channelId: string | null;
  name: string;
  niche: string;
  filmKind: FilmKind;
  visualStyle: string;
  mood: Mood;
  format: '16:9' | '9:16';
  lengthSeconds: number;
  language: string;
  narrator: string;
  audience: string;
  notes: string;
  characters: (ShowCharacter & { stillKey?: string })[];
  publishDays: number[];
  publishTimes: string[];
  timezone: string;
  privacy: 'private' | 'unlisted' | 'public';
  mode: 'AUTOPILOT' | 'REVIEW';
  status: 'ACTIVE' | 'PAUSED';
  createdAt: Date;
}

interface FilmRow {
  id: string;
  showId: string;
  workspaceId: string;
  status: string;
  publishAt: Date;
  idea: string;
  title: string;
  description: string;
  tags: string[];
  script: FilmScript | null;
  lengthSeconds: number;
  priceTokens: number;
  reservationId: string | null;
  chargedTokens: number;
  progress: number;
  stage: string;
  videoKey: string | null;
  thumbnailKey: string | null;
  approvedAt: Date | null;
  youtubeVideoId: string | null;
  publishedAt: Date | null;
  error: string | null;
  attempts: number;
  updatedAt: Date;
}

const UNMADE = ['PLANNED', 'SCRIPTED', 'BLOCKED'];

async function member(auth: AuthContext, workspaceId: string, write = false): Promise<void> {
  if (auth.role === 'SUPER_ADMIN') return;
  await requireMembership(auth.userId, workspaceId, write ? ['OWNER', 'EDITOR'] : undefined);
}

async function showOf(workspaceId: string, showId: string): Promise<ShowRow> {
  const [row] = await sql<ShowRow[]>`SELECT * FROM yt_shows WHERE id = ${showId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!row) throw AppError.notFound('Show');
  return row;
}

async function filmOf(workspaceId: string, filmId: string): Promise<FilmRow> {
  const [row] = await sql<FilmRow[]>`SELECT * FROM yt_films WHERE id = ${filmId} AND workspace_id = ${workspaceId}`;
  if (!row) throw AppError.notFound('Film');
  return row;
}

/* ------------------------------------------------------------------ views */

async function filmView(film: FilmRow, settingsRate: { nairaPerToken: number }) {
  const [videoUrl, thumbnailUrl] = await Promise.all([film.videoKey ? readUrl(film.videoKey).catch(() => null) : null, film.thumbnailKey ? readUrl(film.thumbnailKey).catch(() => null) : null]);
  return {
    id: film.id,
    showId: film.showId,
    status: film.status,
    publishAt: film.publishAt,
    idea: film.idea,
    title: film.title,
    description: film.description,
    tags: film.tags,
    script: film.script,
    lengthSeconds: film.lengthSeconds,
    priceTokens: film.priceTokens,
    priceNaira: Math.round(film.priceTokens * settingsRate.nairaPerToken),
    chargedTokens: film.chargedTokens,
    progress: film.progress,
    stage: film.stage,
    videoUrl,
    thumbnailUrl,
    approvedAt: film.approvedAt,
    youtubeVideoId: film.youtubeVideoId,
    youtubeUrl: film.youtubeVideoId ? `https://www.youtube.com/watch?v=${film.youtubeVideoId}` : null,
    publishedAt: film.publishedAt,
    error: film.error,
  };
}
export type FilmView = Awaited<ReturnType<typeof filmView>>;

const showView = (show: ShowRow) => ({
  id: show.id,
  channelId: show.channelId,
  name: show.name,
  niche: show.niche,
  filmKind: show.filmKind,
  visualStyle: show.visualStyle,
  mood: show.mood,
  format: show.format,
  lengthSeconds: show.lengthSeconds,
  language: show.language,
  narrator: show.narrator,
  audience: show.audience,
  notes: show.notes,
  characters: show.characters.map(({ name, description }) => ({ name, description })),
  publishDays: show.publishDays,
  publishTimes: show.publishTimes,
  timezone: show.timezone,
  privacy: show.privacy,
  mode: show.mode,
  status: show.status,
  createdAt: show.createdAt,
});

/* ------------------------------------------------------------------ pricing */

export async function pricing() {
  const settings = await getYoutubeSettings();
  return {
    enabled: settings.enabled,
    nairaPer30s: settings.nairaPer30s,
    nairaPerToken: settings.nairaPerToken,
    minSeconds: settings.minSeconds,
    maxSeconds: settings.maxSeconds,
    leadHours: settings.leadHours,
    maxPerWeek: settings.maxPerWeek,
    youtubeConnected: youtubeConfigured(),
  };
}

/* ------------------------------------------------------------------ shows */

async function checkShow(workspaceId: string, input: ShowInput): Promise<void> {
  const settings = await getYoutubeSettings();
  if (!settings.enabled) throw new AppError(503, 'INTERNAL_ERROR', 'YouTube films are switched off by the platform operator.');
  if (input.lengthSeconds < settings.minSeconds || input.lengthSeconds > settings.maxSeconds) throw AppError.badRequest(`Films are ${settings.minSeconds}–${settings.maxSeconds} seconds long.`);
  const perWeek = new Set(input.publishDays).size * new Set(input.publishTimes).size;
  if (perWeek > settings.maxPerWeek) throw AppError.badRequest(`At most ${settings.maxPerWeek} films a week per show.`);
  if (input.channelId) {
    const [channel] = await sql`SELECT 1 FROM yt_channels WHERE id = ${input.channelId} AND workspace_id = ${workspaceId}`;
    if (!channel) throw AppError.badRequest('That channel is not connected to this workspace.');
  }
}

export async function listShows(auth: AuthContext, workspaceId: string) {
  await member(auth, workspaceId);
  const shows = await sql<ShowRow[]>`SELECT * FROM yt_shows WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY created_at DESC`;
  const counts = await sql<{ showId: string; published: number; upcoming: number; nextAt: Date | null; review: number }[]>`
    SELECT show_id, count(*) FILTER (WHERE status = 'PUBLISHED')::int AS published,
      count(*) FILTER (WHERE status <> 'PUBLISHED' AND status <> 'FAILED')::int AS upcoming,
      min(publish_at) FILTER (WHERE status <> 'PUBLISHED' AND publish_at > now()) AS next_at,
      count(*) FILTER (WHERE status = 'READY' AND approved_at IS NULL)::int AS review
    FROM yt_films WHERE workspace_id = ${workspaceId} GROUP BY show_id`;
  const byShow = new Map(counts.map((row) => [row.showId, row]));
  const settings = await getYoutubeSettings();
  return shows.map((show) => {
    const count = byShow.get(show.id);
    return {
      ...showView(show),
      perWeek: new Set(show.publishDays).size * new Set(show.publishTimes).size,
      price: filmPrice(settings, show.lengthSeconds),
      published: count?.published ?? 0,
      upcoming: count?.upcoming ?? 0,
      awaitingReview: count?.review ?? 0,
      nextAt: count?.nextAt ?? null,
    };
  });
}

export async function getShow(auth: AuthContext, workspaceId: string, showId: string) {
  await member(auth, workspaceId);
  const show = await showOf(workspaceId, showId);
  const settings = await getYoutubeSettings();
  const films = await sql<FilmRow[]>`
    (SELECT * FROM yt_films WHERE show_id = ${showId} AND status <> 'PUBLISHED' ORDER BY publish_at LIMIT 40)
    UNION ALL
    (SELECT * FROM yt_films WHERE show_id = ${showId} AND status = 'PUBLISHED' ORDER BY publish_at DESC LIMIT 30)`;
  return { show: { ...showView(show), price: filmPrice(settings, show.lengthSeconds) }, films: await Promise.all(films.map((film) => filmView(film, settings))) };
}

export async function createShow(auth: AuthContext, workspaceId: string, input: ShowInput) {
  await member(auth, workspaceId, true);
  await checkShow(workspaceId, input);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO yt_shows (workspace_id, created_by, channel_id, name, niche, film_kind, visual_style, mood, format, length_seconds, language, narrator,
      audience, notes, characters, publish_days, publish_times, timezone, privacy, mode, status)
    VALUES (${workspaceId}, ${auth.userId}, ${input.channelId}, ${input.name}, ${input.niche}, ${input.filmKind}, ${input.visualStyle}, ${input.mood}, ${input.format},
      ${input.lengthSeconds}, ${input.language}, ${input.narrator}, ${input.audience}, ${input.notes}, ${json(input.characters)}, ${json([...new Set(input.publishDays)].sort())},
      ${json([...new Set(input.publishTimes)].sort())}, ${input.timezone}, ${input.privacy}, ${input.mode}, ${input.status})
    RETURNING id`;
  await planShow(row!.id);
  return getShow(auth, workspaceId, row!.id);
}

export async function updateShow(auth: AuthContext, workspaceId: string, showId: string, input: ShowInput) {
  await member(auth, workspaceId, true);
  const before = await showOf(workspaceId, showId);
  await checkShow(workspaceId, input);
  // Cast changes keep the stills of people whose description is unchanged.
  const characters = input.characters.map((person) => {
    const kept = before.characters.find((old) => old.name === person.name && old.description === person.description);
    return kept?.stillKey ? { ...person, stillKey: kept.stillKey } : person;
  });
  await sql`
    UPDATE yt_shows SET channel_id = ${input.channelId}, name = ${input.name}, niche = ${input.niche}, film_kind = ${input.filmKind}, visual_style = ${input.visualStyle},
      mood = ${input.mood}, format = ${input.format}, length_seconds = ${input.lengthSeconds}, language = ${input.language}, narrator = ${input.narrator},
      audience = ${input.audience}, notes = ${input.notes}, characters = ${json(characters)}, publish_days = ${json([...new Set(input.publishDays)].sort())},
      publish_times = ${json([...new Set(input.publishTimes)].sort())}, timezone = ${input.timezone}, privacy = ${input.privacy}, mode = ${input.mode},
      status = ${input.status}, updated_at = now()
    WHERE id = ${showId}`;
  const scheduleChanged =
    JSON.stringify([...before.publishDays].sort()) !== JSON.stringify([...new Set(input.publishDays)].sort()) ||
    JSON.stringify([...before.publishTimes].sort()) !== JSON.stringify([...new Set(input.publishTimes)].sort()) ||
    before.timezone !== input.timezone;
  const storyChanged = before.lengthSeconds !== input.lengthSeconds || before.filmKind !== input.filmKind || before.niche !== input.niche || before.format !== input.format || before.language !== input.language;
  // Films not made yet follow the new plan: a new schedule replans them; a new story re-writes them.
  if (scheduleChanged || input.status === 'PAUSED') await sql`DELETE FROM yt_films WHERE show_id = ${showId} AND status IN ${sql(UNMADE)}`;
  else if (storyChanged) await sql`UPDATE yt_films SET status = 'PLANNED', script = NULL, title = '', length_seconds = ${input.lengthSeconds}, updated_at = now() WHERE show_id = ${showId} AND status IN ${sql(UNMADE)}`;
  if (input.status === 'ACTIVE') await planShow(showId);
  return getShow(auth, workspaceId, showId);
}

export async function deleteShow(auth: AuthContext, workspaceId: string, showId: string): Promise<void> {
  await member(auth, workspaceId, true);
  await showOf(workspaceId, showId);
  const [making] = await sql`SELECT 1 FROM yt_films WHERE show_id = ${showId} AND status IN ('MAKING', 'PUBLISHING')`;
  if (making) throw AppError.conflict('A film of this show is being made or published right now. Try again when it is done.');
  await sql`UPDATE yt_shows SET deleted_at = now(), status = 'PAUSED' WHERE id = ${showId}`;
  await sql`DELETE FROM yt_films WHERE show_id = ${showId} AND status IN ${sql(UNMADE)}`;
}

/** Adds PLANNED films for the show's publish times over the next two weeks. */
export async function planShow(showId: string): Promise<number> {
  const [show] = await sql<ShowRow[]>`SELECT * FROM yt_shows WHERE id = ${showId} AND deleted_at IS NULL AND status = 'ACTIVE'`;
  if (!show) return 0;
  const now = new Date();
  const slots = show.publishTimes.flatMap((at) => upcomingSlots({ days: show.publishDays, time: at, timeZone: show.timezone }, now, 14));
  if (!slots.length) return 0;
  const existing = await sql<{ publishAt: Date }[]>`SELECT publish_at FROM yt_films WHERE show_id = ${showId} AND publish_at > now()`;
  const taken = new Set(existing.map((row) => row.publishAt.getTime()));
  const settings = await getYoutubeSettings();
  const price = filmPrice(settings, show.lengthSeconds);
  let added = 0;
  for (const slot of slots.sort((a, b) => a.getTime() - b.getTime())) {
    if (taken.has(slot.getTime())) continue;
    await sql`INSERT INTO yt_films (show_id, workspace_id, publish_at, length_seconds, price_tokens) VALUES (${showId}, ${show.workspaceId}, ${slot}, ${show.lengthSeconds}, ${price.tokens})`;
    added += 1;
  }
  return added;
}

/* ------------------------------------------------------------------ films */

async function writeScript(film: FilmRow, show: ShowRow, idea = film.idea): Promise<void> {
  const earlier = await sql<{ title: string }[]>`SELECT title FROM yt_films WHERE show_id = ${show.id} AND title <> '' AND id <> ${film.id} ORDER BY publish_at DESC LIMIT 30`;
  const script = await writeFilm({
    show: { name: show.name, niche: show.niche, filmKind: show.filmKind, visualStyle: show.visualStyle, mood: show.mood, format: show.format, language: show.language, audience: show.audience, notes: show.notes, characters: show.characters },
    lengthSeconds: film.lengthSeconds,
    idea,
    earlierTitles: earlier.map((row) => row.title),
  });
  const { engine: _engine, ...stored } = script;
  await sql`
    UPDATE yt_films SET status = 'SCRIPTED', script = ${json(stored)}, title = ${script.title}, description = ${script.description}, tags = ${json(script.tags)},
      idea = ${idea}, error = NULL, updated_at = now()
    WHERE id = ${film.id} AND status IN ${sql(UNMADE)}`;
}

export async function rewriteFilm(auth: AuthContext, workspaceId: string, filmId: string, idea: string) {
  await member(auth, workspaceId, true);
  const film = await filmOf(workspaceId, filmId);
  if (!UNMADE.includes(film.status) && film.status !== 'FAILED') throw AppError.conflict('This film is already made. Make a new one from the show instead.');
  if (film.status === 'FAILED') await sql`UPDATE yt_films SET status = 'PLANNED' WHERE id = ${film.id}`;
  await writeScript({ ...film, status: 'PLANNED' }, await showOf(workspaceId, film.showId), idea.trim());
  return filmView(await filmOf(workspaceId, filmId), await getYoutubeSettings());
}

export async function editFilm(auth: AuthContext, workspaceId: string, filmId: string, input: z.infer<typeof filmEditSchema>) {
  await member(auth, workspaceId, true);
  const film = await filmOf(workspaceId, filmId);
  if (!film.script) throw AppError.conflict('This film has no script yet: write it first.');
  const ready = film.status === 'READY';
  if (!UNMADE.includes(film.status) && !ready) throw AppError.conflict('The film is being made or is out already.');
  // Once made, only the YouTube details (title, description, tags) can change without re-making it.
  const script: FilmScript = ready
    ? { ...film.script, title: input.title }
    : filmScriptSchema.parse({ ...film.script, title: input.title, description: input.description, tags: input.tags, thumbnail: { ...film.script.thumbnail, text: input.thumbnailText }, scenes: fitScenes(input.scenes, film.lengthSeconds) });
  await sql`UPDATE yt_films SET title = ${input.title}, description = ${input.description}, tags = ${json(input.tags)}, script = ${json(script)}, updated_at = now() WHERE id = ${film.id}`;
  return filmView(await filmOf(workspaceId, filmId), await getYoutubeSettings());
}

export async function approveFilm(auth: AuthContext, workspaceId: string, filmId: string, approved: boolean) {
  await member(auth, workspaceId, true);
  const film = await filmOf(workspaceId, filmId);
  if (film.status !== 'READY') throw AppError.conflict('Only a finished film can be approved.');
  await sql`UPDATE yt_films SET approved_at = ${approved ? new Date() : null}, updated_at = now() WHERE id = ${film.id}`;
  return filmView(await filmOf(workspaceId, filmId), await getYoutubeSettings());
}

export async function skipFilm(auth: AuthContext, workspaceId: string, filmId: string): Promise<void> {
  await member(auth, workspaceId, true);
  const film = await filmOf(workspaceId, filmId);
  if (film.status === 'MAKING' || film.status === 'PUBLISHING') throw AppError.conflict('This film is being made or published right now.');
  if (film.status === 'PUBLISHED') throw AppError.conflict('This film is already on YouTube: remove it there.');
  // A skipped slot stays skipped (FAILED rows are kept so the planner doesn't refill the slot).
  await sql`UPDATE yt_films SET status = 'FAILED', error = 'Skipped', updated_at = now() WHERE id = ${film.id}`;
}

/** "Make it now": writes the script if needed, then makes the film straight away (charged). */
export async function makeNow(auth: AuthContext, workspaceId: string, filmId: string) {
  await member(auth, workspaceId, true);
  let film = await filmOf(workspaceId, filmId);
  const show = await showOf(workspaceId, film.showId);
  if (film.status === 'FAILED') {
    await sql`UPDATE yt_films SET status = 'PLANNED', error = NULL WHERE id = ${film.id}`;
    film = { ...film, status: 'PLANNED' };
  }
  if (!film.script || film.status === 'PLANNED') {
    await writeScript(film, show);
    film = await filmOf(workspaceId, filmId);
  }
  if (film.status !== 'SCRIPTED' && film.status !== 'BLOCKED') throw AppError.conflict('This film is already made or being made.');
  await startMaking(film, show, auth);
  return filmView(await filmOf(workspaceId, filmId), await getYoutubeSettings());
}

export async function publishNow(auth: AuthContext, workspaceId: string, filmId: string) {
  await member(auth, workspaceId, true);
  const film = await filmOf(workspaceId, filmId);
  if (film.status !== 'READY') throw AppError.conflict('Only a finished film can be published.');
  const show = await showOf(workspaceId, film.showId);
  await sql`UPDATE yt_films SET approved_at = coalesce(approved_at, now()) WHERE id = ${film.id}`;
  await publish({ ...film, approvedAt: film.approvedAt ?? new Date() }, show);
  return filmView(await filmOf(workspaceId, filmId), await getYoutubeSettings());
}

/* ------------------------------------------------------------------ making + publishing */

const making = new Set<string>();
const MAX_PARALLEL = 2;

/** The show creator's identity, for charging scheduled work to the workspace. */
async function ownerAuth(show: ShowRow): Promise<AuthContext> {
  const [user] = await sql<{ role: AuthContext['role'] }[]>`SELECT role FROM users WHERE id = ${show.createdBy}`;
  return { userId: show.createdBy, role: user?.role ?? 'CREATOR', sessionId: 'youtube-scheduler' } as AuthContext;
}

async function startMaking(film: FilmRow, show: ShowRow, actor?: AuthContext): Promise<void> {
  if (making.size >= MAX_PARALLEL && !actor) return;
  const auth = actor ?? (await ownerAuth(show));
  const settings = await getYoutubeSettings();
  const price = filmPrice(settings, film.lengthSeconds);
  let reservation: Awaited<ReturnType<typeof reserveTokens>>['reservation'];
  try {
    ({ reservation } = await reserveTokens(auth, show.workspaceId, 'YOUTUBE_FILM', price.tokens, { filmId: film.id, showId: show.id }));
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'The price could not be held.';
    await sql`UPDATE yt_films SET status = 'BLOCKED', error = ${message}, updated_at = now() WHERE id = ${film.id}`;
    if (actor) throw error;
    return;
  }
  const [claimed] = await sql`
    UPDATE yt_films SET status = 'MAKING', reservation_id = ${reservation.id}, price_tokens = ${price.tokens}, progress = 1, stage = 'Starting', error = NULL,
      attempts = attempts + 1, updated_at = now()
    WHERE id = ${film.id} AND status IN ('SCRIPTED', 'BLOCKED') RETURNING id`;
  if (!claimed) {
    await releaseSystem(reservation.id, show.workspaceId).catch(() => undefined);
    return;
  }
  making.add(film.id);
  const script = filmScriptSchema.parse(film.script);
  const makerShow: MakerShow = { id: show.id, workspaceId: show.workspaceId, visualStyle: show.visualStyle, mood: show.mood, format: show.format, narrator: show.narrator, characters: show.characters };
  void makeFilm(makerShow, film.id, script, async (percent, stage) => {
    await sql`UPDATE yt_films SET progress = ${percent}, stage = ${stage}, updated_at = now() WHERE id = ${film.id}`;
  })
    .then(async (made) => {
      await settleSystem(reservation.id, show.workspaceId, price.tokens, `YouTube film · ${(film.title || show.name).slice(0, 60)} (${price.seconds} s)`);
      await sql`
        UPDATE yt_films SET status = 'READY', video_key = ${made.videoKey}, thumbnail_key = ${made.thumbnailKey}, progress = 100, stage = 'Ready',
          charged_tokens = ${reservation.unmetered ? 0 : price.tokens}, updated_at = now()
        WHERE id = ${film.id}`;
      logger.info({ filmId: film.id, seconds: made.seconds }, 'youtube film made');
    })
    .catch(async (error: unknown) => {
      await releaseSystem(reservation.id, show.workspaceId).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ filmId: film.id, err: message }, 'youtube film failed');
      await sql`UPDATE yt_films SET status = 'BLOCKED', error = ${`Making failed: ${message}`.slice(0, 500)}, stage = '', progress = 0, updated_at = now() WHERE id = ${film.id}`;
    })
    .finally(() => making.delete(film.id));
}

async function publish(film: FilmRow, show: ShowRow): Promise<void> {
  if (!show.channelId) {
    await sql`UPDATE yt_films SET error = 'Connect a YouTube channel to this show to publish.', updated_at = now() WHERE id = ${film.id}`;
    throw new AppError(409, 'CONFLICT', 'Connect a YouTube channel to this show to publish.');
  }
  const [claimed] = await sql`UPDATE yt_films SET status = 'PUBLISHING', stage = 'Uploading to YouTube', error = NULL, updated_at = now() WHERE id = ${film.id} AND status = 'READY' RETURNING id`;
  if (!claimed || !film.videoKey) return;
  let dir: string | null = null;
  try {
    const files = await fetchForUpload(film.videoKey, film.thumbnailKey);
    dir = files.dir;
    const { videoId } = await uploadVideo({
      channelRowId: show.channelId,
      file: files.video,
      thumbnail: files.thumb,
      title: film.title,
      description: film.description,
      tags: film.tags,
      privacy: show.privacy,
      language: show.language,
    });
    await sql`UPDATE yt_films SET status = 'PUBLISHED', youtube_video_id = ${videoId}, published_at = now(), stage = 'On YouTube', updated_at = now() WHERE id = ${film.id}`;
    logger.info({ filmId: film.id, videoId }, 'youtube film published');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`UPDATE yt_films SET status = 'READY', error = ${`Publishing failed: ${message}`.slice(0, 500)}, stage = 'Ready', updated_at = now() WHERE id = ${film.id}`;
    throw error;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ the scheduler */

/**
 * One run (every few minutes): plan two weeks ahead, write tomorrow's scripts, make the films due
 * within the lead time, publish the ones due now, and recover films a restart left "making".
 */
export async function runSchedule(): Promise<string> {
  const settings = await getYoutubeSettings();
  if (!settings.enabled) return 'switched off';
  const shows = await sql<ShowRow[]>`SELECT * FROM yt_shows WHERE deleted_at IS NULL`;
  const byId = new Map(shows.map((show) => [show.id, show]));
  let planned = 0;
  let written = 0;
  let started = 0;
  let published = 0;
  let recovered = 0;

  for (const show of shows.filter((item) => item.status === 'ACTIVE')) planned += await planShow(show.id).catch(() => 0);

  // Films left MAKING by a restart: free the hold and try again (three tries).
  const stale = await sql<FilmRow[]>`SELECT * FROM yt_films WHERE status IN ('MAKING', 'PUBLISHING') AND updated_at < now() - interval '45 minutes'`;
  for (const film of stale.filter((item) => !making.has(item.id))) {
    if (film.status === 'MAKING' && film.reservationId) await releaseSystem(film.reservationId, film.workspaceId).catch(() => undefined);
    const next = film.status === 'PUBLISHING' ? 'READY' : film.attempts >= 3 ? 'FAILED' : 'SCRIPTED';
    await sql`UPDATE yt_films SET status = ${next}, error = 'Interrupted (server restart); picked up again.', progress = 0, updated_at = now() WHERE id = ${film.id}`;
    recovered += 1;
  }

  const lead = settings.leadHours * 3_600_000;
  const due = await sql<FilmRow[]>`
    SELECT f.* FROM yt_films f JOIN yt_shows s ON s.id = f.show_id
    WHERE s.deleted_at IS NULL AND s.status = 'ACTIVE' AND f.status IN ('PLANNED', 'SCRIPTED', 'BLOCKED', 'READY')
      AND f.publish_at < now() + make_interval(secs => ${(lead + 24 * 3_600_000) / 1000})
    ORDER BY f.publish_at LIMIT 50`;
  for (const film of due) {
    const show = byId.get(film.showId);
    if (!show) continue;
    const untilPublish = film.publishAt.getTime() - Date.now();
    try {
      if (film.status === 'PLANNED') {
        await writeScript(film, show);
        written += 1;
      } else if ((film.status === 'SCRIPTED' || film.status === 'BLOCKED') && untilPublish < lead) {
        // A slot long past (more than a day late) is dropped rather than published late.
        if (untilPublish < -24 * 3_600_000) {
          await sql`UPDATE yt_films SET status = 'FAILED', error = 'Missed its slot.', updated_at = now() WHERE id = ${film.id}`;
          continue;
        }
        const fresh = (await sql<FilmRow[]>`SELECT * FROM yt_films WHERE id = ${film.id}`)[0];
        if (fresh && making.size < MAX_PARALLEL) {
          await startMaking(fresh, show);
          started += 1;
        }
      } else if (film.status === 'READY' && untilPublish <= 0 && (show.mode === 'AUTOPILOT' || film.approvedAt) && show.channelId && youtubeConfigured()) {
        await publish(film, show);
        published += 1;
      }
    } catch (error) {
      logger.warn({ filmId: film.id, err: (error as Error).message }, 'youtube schedule step failed');
    }
  }
  return `${planned} planned, ${written} written, ${started} started, ${published} published, ${recovered} recovered`;
}

/* ------------------------------------------------------------------ overview */

export async function overview(auth: AuthContext, workspaceId: string) {
  await member(auth, workspaceId);
  const [stats] = await sql<{ shows: number; published: number; upcoming: number; review: number; making: number; blocked: number }[]>`
    SELECT (SELECT count(*)::int FROM yt_shows WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL) AS shows,
      count(*) FILTER (WHERE status = 'PUBLISHED')::int AS published,
      count(*) FILTER (WHERE status IN ('PLANNED', 'SCRIPTED') AND publish_at > now())::int AS upcoming,
      count(*) FILTER (WHERE status = 'READY' AND approved_at IS NULL)::int AS review,
      count(*) FILTER (WHERE status IN ('MAKING', 'PUBLISHING'))::int AS making,
      count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked
    FROM yt_films WHERE workspace_id = ${workspaceId}`;
  return stats ?? { shows: 0, published: 0, upcoming: 0, review: 0, making: 0, blocked: 0 };
}
