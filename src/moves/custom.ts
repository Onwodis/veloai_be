/**
 * Custom moves: a creator's own moves in the database.
 *
 *   create / update / remove   at most 100 live moves per user
 *   share                      every move has a public move id (CM-XXXXXXXX) and a
 *                              secret key; the owner shares both; rotate the key to
 *                              stop further copies
 *   import                     another creator pastes the id + key and gets their own
 *                              copy; the copy always credits the ORIGINAL creator
 *                              (origin survives re-sharing) and the app reminds them
 *                              to say thank you
 *   favourites                 star library or custom moves
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '../middleware/authenticate.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { libraryMove } from './library.js';
import { MAX_CUSTOM_MOVES, type CustomMoveInput } from './schemas.js';
import type { Move, MoveCategory, MoveDomain } from './types.js';

/** No 0/O, 1/I: ids and keys are read aloud and retyped. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (length: number): string => Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const KEY_ATTEMPTS_PER_HOUR = 15;

export interface Origin {
  moveId: string;
  ownerId: string;
  ownerName: string;
  name: string;
}

interface CustomRow {
  id: string;
  moveId: string;
  shareKey: string;
  ownerId: string;
  domain: MoveDomain;
  category: MoveCategory;
  name: string;
  cue: string;
  detail: string;
  meta: Pick<Move, 'sections' | 'moods' | 'tempo' | 'energy' | 'gender' | 'genres' | 'shot' | 'props' | 'tags'>;
  basedOn: string | null;
  origin: Origin | null;
  copies: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape the app shows (the same fields as a library move, plus sharing). */
export function present(row: CustomRow, viewerId: string) {
  const mine = row.ownerId === viewerId;
  return {
    id: row.moveId,
    name: row.name,
    domain: row.domain,
    category: row.category,
    cue: row.cue,
    detail: row.detail,
    ...row.meta,
    difficulty: 1,
    signature: false,
    custom: true as const,
    basedOn: row.basedOn,
    origin: row.origin,
    copies: row.copies,
    // The key is only ever shown to the owner.
    shareKey: mine ? row.shareKey : null,
    createdAt: row.createdAt.toISOString(),
  };
}
export type CustomMoveView = ReturnType<typeof present>;

async function liveCount(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM custom_moves WHERE owner_id = ${userId} AND deleted_at IS NULL`;
  return row?.count ?? 0;
}

async function assertRoom(userId: string): Promise<void> {
  if ((await liveCount(userId)) >= MAX_CUSTOM_MOVES) throw AppError.badRequest(`You have ${MAX_CUSTOM_MOVES} moves, the most you can keep. Delete one to make room.`);
}

async function uniqueMoveId(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `CM-${randomCode(8)}`;
    const [taken] = await sql<{ id: string }[]>`SELECT id FROM custom_moves WHERE move_id = ${candidate}`;
    if (!taken) return candidate;
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Could not create a move id. Try again.');
}

const metaOf = (input: CustomMoveInput): CustomRow['meta'] => ({
  sections: input.sections,
  moods: input.moods,
  tempo: input.tempo,
  energy: input.energy,
  gender: input.gender,
  genres: input.genres,
  shot: input.shot,
  props: input.props,
  tags: input.tags,
});

export async function listMine(auth: AuthContext) {
  const rows = await sql<CustomRow[]>`SELECT * FROM custom_moves WHERE owner_id = ${auth.userId} AND deleted_at IS NULL ORDER BY created_at DESC`;
  return { items: rows.map((row) => present(row, auth.userId)), limit: MAX_CUSTOM_MOVES };
}

export async function ownCustom(userId: string, moveId: string): Promise<CustomRow | null> {
  const [row] = await sql<CustomRow[]>`SELECT * FROM custom_moves WHERE move_id = ${moveId} AND owner_id = ${userId} AND deleted_at IS NULL`;
  return row ?? null;
}

export async function createMove(auth: AuthContext, input: CustomMoveInput) {
  await assertRoom(auth.userId);
  if (input.basedOn && !libraryMove(input.basedOn)) throw AppError.badRequest('That library move does not exist.');
  const [row] = await sql<CustomRow[]>`
    INSERT INTO custom_moves (move_id, share_key, owner_id, domain, category, name, cue, detail, meta, based_on)
    VALUES (${await uniqueMoveId()}, ${randomCode(20)}, ${auth.userId}, ${input.domain}, ${input.category}, ${input.name}, ${input.cue}, ${input.detail ?? ''}, ${json(metaOf(input))}, ${input.basedOn ?? null})
    RETURNING *`;
  return present(row!, auth.userId);
}

export async function updateMove(auth: AuthContext, moveId: string, input: CustomMoveInput) {
  const row = await ownCustom(auth.userId, moveId);
  if (!row) throw AppError.notFound('Move');
  const [updated] = await sql<CustomRow[]>`
    UPDATE custom_moves SET domain = ${input.domain}, category = ${input.category}, name = ${input.name}, cue = ${input.cue}, detail = ${input.detail ?? ''},
      meta = ${json(metaOf(input))}, updated_at = now()
    WHERE id = ${row.id} RETURNING *`;
  return present(updated!, auth.userId);
}

/** Deletes the move. Copies other creators already made stay theirs; scenes keep their frozen copy. */
export async function removeMove(auth: AuthContext, moveId: string): Promise<void> {
  const row = await ownCustom(auth.userId, moveId);
  if (!row) throw AppError.notFound('Move');
  await sql`UPDATE custom_moves SET deleted_at = now() WHERE id = ${row.id}`;
}

/** A new key: the old one stops working for anyone who has not copied the move yet. */
export async function rotateKey(auth: AuthContext, moveId: string) {
  const row = await ownCustom(auth.userId, moveId);
  if (!row) throw AppError.notFound('Move');
  const [updated] = await sql<CustomRow[]>`UPDATE custom_moves SET share_key = ${randomCode(20)}, updated_at = now() WHERE id = ${row.id} RETURNING *`;
  return present(updated!, auth.userId);
}

const sameKey = (given: string, real: string): boolean => {
  const a = Buffer.from(given.toUpperCase());
  const b = Buffer.from(real);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Copies a shared move into the caller's moves (move id + key). */
export async function importMove(auth: AuthContext, moveId: string, key: string) {
  const [{ failures } = { failures: 0 }] = await sql<{ failures: number }[]>`
    SELECT count(*)::int AS failures FROM move_key_failures WHERE user_id = ${auth.userId} AND at > now() - interval '1 hour'`;
  if (failures >= KEY_ATTEMPTS_PER_HOUR) throw AppError.badRequest('Too many wrong move keys. Try again in an hour.');
  const [source] = await sql<(CustomRow & { ownerName: string | null })[]>`
    SELECT m.*, u.display_name AS owner_name FROM custom_moves m JOIN users u ON u.id = m.owner_id
    WHERE m.move_id = ${moveId} AND m.deleted_at IS NULL`;
  if (!source || !sameKey(key, source.shareKey)) {
    await sql`INSERT INTO move_key_failures (user_id) VALUES (${auth.userId})`;
    throw AppError.badRequest('That move id and key do not match. Check both with the creator.');
  }
  if (source.ownerId === auth.userId) throw AppError.badRequest('This is already your move.');
  // The original creator is credited forever, even when a copy is shared again.
  const origin: Origin = source.origin ?? { moveId: source.moveId, ownerId: source.ownerId, ownerName: source.ownerName ?? 'the creator', name: source.name };
  const [existing] = await sql<CustomRow[]>`
    SELECT * FROM custom_moves WHERE owner_id = ${auth.userId} AND deleted_at IS NULL AND origin->>'moveId' = ${origin.moveId}`;
  if (existing) return { move: present(existing, auth.userId), thanks: origin, already: true };
  await assertRoom(auth.userId);
  const [row] = await sql<CustomRow[]>`
    INSERT INTO custom_moves (move_id, share_key, owner_id, domain, category, name, cue, detail, meta, based_on, origin)
    VALUES (${await uniqueMoveId()}, ${randomCode(20)}, ${auth.userId}, ${source.domain}, ${source.category}, ${source.name}, ${source.cue}, ${source.detail},
      ${json(source.meta)}, ${source.basedOn}, ${json(origin)})
    RETURNING *`;
  await sql`UPDATE custom_moves SET copies = copies + 1 WHERE id = ${source.id}`;
  if (source.origin) await sql`UPDATE custom_moves SET copies = copies + 1 WHERE move_id = ${source.origin.moveId}`;
  return { move: present(row!, auth.userId), thanks: origin, already: false };
}

/* ------------------------------------------------------------------ favourites */

export async function favourites(userId: string): Promise<string[]> {
  const rows = await sql<{ moveRef: string }[]>`SELECT move_ref FROM move_favourites WHERE user_id = ${userId} ORDER BY created_at DESC`;
  return rows.map((row) => row.moveRef);
}

export async function setFavourite(userId: string, ref: string, on: boolean): Promise<string[]> {
  if (on) await sql`INSERT INTO move_favourites (user_id, move_ref) VALUES (${userId}, ${ref}) ON CONFLICT DO NOTHING`;
  else await sql`DELETE FROM move_favourites WHERE user_id = ${userId} AND move_ref = ${ref}`;
  return favourites(userId);
}
