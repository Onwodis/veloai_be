/**
 * Artist upload link for a music video.
 *
 * The creator makes a public link for the project and sends it to the artist. On it, with no
 * account, the artist uploads the song and photos and fills in the notes and details the video
 * needs (story idea, mood, references, wardrobe, locations, people in it, dos and don'ts,
 * contacts). Submitting is one-time:
 *
 *   OPEN       the link takes uploads and one submission
 *   SUBMITTED  the creator has been emailed; the link shows "already sent" and takes nothing
 *
 * The creator can reopen it (same address), which wipes what was sent (files included), or delete
 * it. From the project they use what came in: the song becomes the project's song and the photos
 * join the project photos (copied into the project, counted against the creator's storage).
 *
 * Files the artist uploads live under the project's folder in intake/<link id>/ and are only ever
 * accepted at that prefix; each upload is a size-capped one-shot grant (at most UPLOAD_GRANTS per
 * opening of the link).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { sendMail } from '../services/mail/mail.service.js';
import { artistIntakeMail } from '../services/mail/templates.js';
import { copyObject, deleteObject, deletePrefix, headObject, keys, listObjects, presignPut, readUrl } from '../services/storage.service.js';
import { trackUpload } from '../storage/ledger.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { access, load, touch, view } from './service.js';

const UPLOAD_GRANTS = 60;
const MAX_PHOTOS = 20;
const AUDIO_MAX = 200 * 1024 ** 2;
const PHOTO_MAX = 25 * 1024 ** 2;
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/x-flac', 'audio/ogg'];
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

interface FileRef {
  key: string;
  name: string;
  size: number;
  contentType: string;
}

interface IntakeRow {
  id: string;
  projectId: string;
  workspaceId: string;
  createdBy: string;
  token: string;
  status: 'OPEN' | 'SUBMITTED';
  asks: { song: boolean; photos: boolean; details: boolean };
  message: string;
  submission: Submission | null;
  audio: FileRef | null;
  photos: FileRef[];
  uploadGrants: number;
  submittedAt: Date | null;
  reopenedAt: Date | null;
  createdAt: Date;
}

/* ------------------------------------------------------------------ schemas */

const text = (max: number) => z.string().trim().max(max).optional();

export const intakeSettingsSchema = z.strictObject({
  message: z.string().trim().max(1000).default(''),
  asks: z.strictObject({ song: z.boolean(), photos: z.boolean(), details: z.boolean() }).default({ song: true, photos: true, details: true }),
});

const fileRefSchema = z.strictObject({
  key: z.string().min(1).max(600),
  name: z.string().trim().min(1).max(200),
  size: z.number().int().positive(),
  contentType: z.string().min(1).max(100),
});

export const submissionSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(200).optional().or(z.literal('')),
  phone: text(40),
  artistName: text(120),
  songTitle: text(160),
  featuring: text(160),
  label: text(160),
  genre: text(80),
  releaseDate: text(40),
  story: text(3000),
  mood: text(600),
  references: text(1500),
  locations: text(1000),
  wardrobe: text(1000),
  people: text(1500),
  avoid: text(1000),
  notes: text(4000),
  audio: fileRefSchema.nullable().optional(),
  photos: z.array(fileRefSchema).max(MAX_PHOTOS).default([]),
});
export type Submission = Omit<z.infer<typeof submissionSchema>, 'audio' | 'photos'>;

export const uploadRequestSchema = z.strictObject({
  kind: z.enum(['audio', 'photo']),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});

/* ------------------------------------------------------------------ helpers */

const linkUrl = (token: string): string => `${env.WEB_APP_URL}/artist-upload/${token}`;
const folder = (row: Pick<IntakeRow, 'workspaceId' | 'projectId' | 'id'>): string => `${keys.studio(row.workspaceId, row.projectId)}/intake/${row.id}/`;

async function byProject(projectId: string): Promise<IntakeRow | null> {
  const [row] = await sql<IntakeRow[]>`SELECT * FROM mv_intake_links WHERE project_id = ${projectId}`;
  return row ?? null;
}

async function byToken(token: string): Promise<IntakeRow> {
  const [row] = await sql<IntakeRow[]>`SELECT * FROM mv_intake_links WHERE token = ${token}`;
  if (!row) throw AppError.notFound('Upload link');
  return row;
}

async function fileView(file: FileRef) {
  return { name: file.name, size: file.size, contentType: file.contentType, url: await readUrl(file.key) };
}

/** What the creator sees in the project. */
async function ownerView(row: IntakeRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    url: linkUrl(row.token),
    status: row.status,
    asks: row.asks,
    message: row.message,
    submission: row.submission,
    audio: row.audio ? await fileView(row.audio) : null,
    photos: await Promise.all(row.photos.map(fileView)),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reopenedAt: row.reopenedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ creator */

export async function getIntake(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, false);
  await load(workspaceId, projectId);
  return ownerView(await byProject(projectId));
}

/** Makes the link (or updates its note / what it asks for). */
export async function saveIntake(auth: AuthContext, workspaceId: string, projectId: string, input: z.infer<typeof intakeSettingsSchema>) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const existing = await byProject(projectId);
  if (existing) {
    await sql`UPDATE mv_intake_links SET message = ${input.message}, asks = ${json(input.asks)}, updated_at = now() WHERE id = ${existing.id}`;
  } else {
    await sql`
      INSERT INTO mv_intake_links (project_id, workspace_id, created_by, token, message, asks)
      VALUES (${projectId}, ${workspaceId}, ${auth.userId}, ${randomBytes(24).toString('base64url')}, ${input.message}, ${json(input.asks)})`;
  }
  return ownerView(await byProject(projectId));
}

/** Makes the link usable again: everything the artist sent is deleted (files too). Same address. */
export async function reopenIntake(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const row = await byProject(projectId);
  if (!row) throw AppError.notFound('Upload link');
  await deletePrefix(folder(row)).catch((error: unknown) => logger.warn({ err: error, projectId }, 'intake files not deleted'));
  await sql`
    UPDATE mv_intake_links SET status = 'OPEN', submission = NULL, audio = NULL, photos = '[]'::jsonb, upload_grants = 0,
      submitted_at = NULL, reopened_at = now(), updated_at = now()
    WHERE id = ${row.id}`;
  return ownerView(await byProject(projectId));
}

export async function deleteIntake(auth: AuthContext, workspaceId: string, projectId: string) {
  await access(auth, workspaceId, true);
  await load(workspaceId, projectId);
  const row = await byProject(projectId);
  if (!row) return null;
  await deletePrefix(folder(row)).catch(() => undefined);
  await sql`DELETE FROM mv_intake_links WHERE id = ${row.id}`;
  return null;
}

/**
 * Copies what the artist sent into the project: the song becomes the project's song, the photos
 * join the project photos. Counted against the creator's storage.
 */
export async function useIntake(auth: AuthContext, workspaceId: string, projectId: string, what: { song: boolean; photos: boolean }) {
  await access(auth, workspaceId, true);
  const { project } = await load(workspaceId, projectId);
  const row = await byProject(projectId);
  if (!row || row.status !== 'SUBMITTED') throw AppError.badRequest('Nothing has been sent on the upload link yet.');
  const copy = async (file: FileRef, role: 'MUSIC' | 'PHOTO'): Promise<string> => {
    const meta = role === 'PHOTO' ? { subject: true, fromArtist: true } : { fromArtist: true };
    const [asset] = await sql<{ id: string }[]>`
      INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta)
      VALUES (${projectId}, ${workspaceId}, ${role}, '', ${file.name.slice(0, 200)}, ${file.contentType}, ${file.size}, ${json(meta)}) RETURNING id`;
    const key = keys.studioAsset(workspaceId, projectId, asset!.id, file.name);
    await copyObject(file.key, key);
    await sql`UPDATE studio_assets SET key = ${key} WHERE id = ${asset!.id}`;
    await trackUpload(key, file.size, async () => {
      await sql`DELETE FROM studio_assets WHERE id = ${asset!.id}`;
    });
    await sql`UPDATE studio_assets SET status = 'READY' WHERE id = ${asset!.id}`;
    return asset!.id;
  };
  if (what.song && row.audio) {
    const id = await copy(row.audio, 'MUSIC');
    const previous = project.musicAssetId;
    await sql`UPDATE studio_projects SET music_asset_id = ${id}, updated_at = now() WHERE id = ${projectId}`;
    if (previous && previous !== id) await sql`UPDATE studio_assets SET meta = meta || '{"replaced": true}'::jsonb WHERE id = ${previous}`;
  }
  if (what.photos && row.photos.length) {
    const { limits } = await getStudioSettings();
    const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_assets WHERE project_id = ${projectId} AND role = 'PHOTO'`;
    const room = Math.max(0, limits.maxPhotos - count);
    if (room === 0) throw AppError.badRequest(`The project already holds ${limits.maxPhotos} photos. Remove some first.`);
    for (const photo of row.photos.slice(0, room)) await copy(photo, 'PHOTO');
  }
  await touch(projectId);
  return view(auth, workspaceId, projectId);
}

/* ------------------------------------------------------------------ public (the artist) */

/** What the artist's page shows. */
export async function publicIntake(token: string) {
  const row = await byToken(token);
  const [project] = await sql<{ title: string; artistName: string | null }[]>`
    SELECT p.title, m.artist_name FROM studio_projects p LEFT JOIN mv_projects m ON m.project_id = p.id WHERE p.id = ${row.projectId}`;
  const owner = await prisma.user.findUnique({ where: { id: row.createdBy }, select: { displayName: true } });
  return {
    status: row.status,
    project: { title: project?.title ?? 'Music video', artist: project?.artistName ?? '' },
    from: owner?.displayName ?? env.APP_NAME,
    message: row.message,
    asks: row.asks,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    limits: { photos: MAX_PHOTOS, audioMb: AUDIO_MAX / 1024 ** 2, photoMb: PHOTO_MAX / 1024 ** 2, audioTypes: AUDIO_TYPES, photoTypes: PHOTO_TYPES },
  };
}

/** A one-shot upload address for one file (only while the link is open). */
export async function intakeUpload(token: string, input: z.infer<typeof uploadRequestSchema>) {
  const row = await byToken(token);
  if (row.status !== 'OPEN') throw AppError.conflict('This link has already been used. Ask for a new one.');
  const type = input.contentType.toLowerCase();
  if (input.kind === 'audio') {
    if (!row.asks.song) throw AppError.badRequest('This link does not ask for the song.');
    if (!AUDIO_TYPES.includes(type)) throw AppError.badRequest('Send the song as MP3, WAV, M4A, AAC, FLAC or OGG.');
    if (input.size > AUDIO_MAX) throw AppError.badRequest(`The song can be up to ${AUDIO_MAX / 1024 ** 2} MB.`);
  } else {
    if (!row.asks.photos) throw AppError.badRequest('This link does not ask for photos.');
    if (!PHOTO_TYPES.includes(type)) throw AppError.badRequest('Send photos as JPG, PNG, WEBP or HEIC.');
    if (input.size > PHOTO_MAX) throw AppError.badRequest(`Each photo can be up to ${PHOTO_MAX / 1024 ** 2} MB.`);
  }
  // One counter per opening of the link: a cap on how many files can be pushed through it.
  const [granted] = await sql<{ uploadGrants: number }[]>`
    UPDATE mv_intake_links SET upload_grants = upload_grants + 1 WHERE id = ${row.id} AND status = 'OPEN' AND upload_grants < ${UPLOAD_GRANTS} RETURNING upload_grants`;
  if (!granted) throw AppError.badRequest('Too many uploads on this link. Send what you have, or ask for the link to be reopened.');
  const safe = input.fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const key = `${folder(row)}${input.kind}/${randomUUID().slice(0, 8)}-${safe}`;
  return { key, uploadUrl: await presignPut(key, type, input.kind === 'audio' ? AUDIO_MAX : PHOTO_MAX) };
}

/** The one submission: checks every file really arrived under this link, closes it, emails the creator. */
export async function submitIntake(token: string, input: z.infer<typeof submissionSchema>) {
  const row = await byToken(token);
  if (row.status !== 'OPEN') throw AppError.conflict('This link has already been used. Ask for a new one.');
  const prefix = folder(row);
  const check = async (file: FileRef, kind: 'audio' | 'photo'): Promise<FileRef> => {
    if (!file.key.startsWith(`${prefix}${kind}/`)) throw AppError.badRequest('A file does not belong to this link. Upload it again.');
    const head = await headObject(file.key);
    if (!head) throw AppError.badRequest(`“${file.name}” has not finished uploading.`);
    return { ...file, size: head.size, contentType: head.contentType ?? file.contentType };
  };
  const audio = input.audio ? await check(input.audio, 'audio') : null;
  const photos = await Promise.all(input.photos.map((photo) => check(photo, 'photo')));
  if (row.asks.song && !audio && photos.length === 0 && !input.notes && !input.story) throw AppError.badRequest('Add the song, photos or some notes before sending.');
  const { audio: _audio, photos: _photos, ...details } = input;
  const submission: Submission = { ...details, email: details.email || undefined };
  // One-time: only an OPEN link takes it (two tabs sending at once: the second is refused).
  const [closed] = await sql<{ id: string }[]>`
    UPDATE mv_intake_links SET status = 'SUBMITTED', submission = ${json(submission)}, audio = ${audio ? json(audio) : null}, photos = ${json(photos)},
      submitted_at = now(), updated_at = now()
    WHERE id = ${row.id} AND status = 'OPEN' RETURNING id`;
  if (!closed) throw AppError.conflict('This link has already been used. Ask for a new one.');

  // Files uploaded but not sent are dropped (only what was submitted stays).
  const kept = new Set([audio?.key, ...photos.map((photo) => photo.key)].filter(Boolean));
  void (async () => {
    for (const object of await listObjects(prefix)) if (!kept.has(object.key)) await deleteObject(object.key).catch(() => undefined);
  })().catch(() => undefined);

  void notifyCreator(row, submission, Boolean(audio), photos.length).catch((error: unknown) => logger.warn({ err: error, projectId: row.projectId }, 'intake email not sent'));
  return { status: 'SUBMITTED' as const };
}

async function notifyCreator(row: IntakeRow, submission: Submission, song: boolean, photos: number): Promise<void> {
  const owner = await prisma.user.findUnique({ where: { id: row.createdBy }, select: { email: true } });
  if (!owner?.email) return;
  const [project] = await sql<{ title: string }[]>`SELECT title FROM studio_projects WHERE id = ${row.projectId}`;
  const from = submission.artistName?.trim() || submission.name;
  await sendMail(
    owner.email,
    artistIntakeMail({
      project: project?.title ?? 'your music video',
      from,
      song,
      photos,
      notes: Boolean(submission.notes || submission.story || submission.mood),
      url: `${env.WEB_APP_URL}/dashboard/music-video/${row.projectId}#artist-link`,
    }),
  );
}
