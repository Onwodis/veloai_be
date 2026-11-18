/**
 * Commercials: a scene's spoken line, in the speaking character's voice.
 *
 *   voice     admin mapping first (models.tts.extra.voices: a character's name
 *             or accent → voice id), else picked from the engine's stock voices
 *             by the character's gender (stable per name, so a character keeps
 *             one voice in every scene and every re-record)
 *   billing   held from the line's length (≈ 2.5 words / s), charged on the
 *             real speech length (tokens per second, min 1 s)
 *   storage   VOICE asset of the ad project (counts against storage), linked
 *             to its scene; the previous recording of that scene is removed
 * The master mixes each line in at its scene (assemble.ts).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaDuration } from '../media/ffmpeg.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { keys, uploadFile } from '../services/storage.service.js';
import { releaseSystem, reserveTokens, settleSystem } from '../services/token.service.js';
import * as fal from '../studio/fal.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import * as studio from '../studio/service.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { ENGINE_NAME } from '../utils/engineName.js';
import type { AdRules } from './schemas.js';

const FEMALE = ['Aria', 'Sarah', 'Laura', 'Charlotte', 'Alice', 'Matilda', 'Jessica', 'Lily'];
const MALE = ['Roger', 'Charlie', 'George', 'Callum', 'Liam', 'Will', 'Eric', 'Chris', 'Brian', 'Daniel', 'Bill'];
const NARRATOR = 'Brian';

const hash = (text: string): number => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

/** The voice id for a speaker, from the admin mapping or the stock voices. */
export function pickVoice(speaker: string | undefined, rules: AdRules, mapping: Record<string, string>): string {
  const character = rules.characters?.find((item) => item.name.trim().toLowerCase() === speaker?.trim().toLowerCase());
  const mapped = [speaker, character?.voice?.accent, rules.accent].flatMap((key) => (key && mapping[key.trim().toLowerCase()] ? [mapping[key.trim().toLowerCase()]!] : []))[0];
  if (mapped) return mapped;
  if (!character) return NARRATOR;
  const gender = (character.gender ?? '').toLowerCase();
  const pool = /female|woman|girl|lady|she/.test(gender) ? FEMALE : /male|man|boy|guy|he/.test(gender) ? MALE : [...FEMALE, ...MALE];
  return pool[hash(character.name.toLowerCase()) % pool.length]!;
}

function audioUrl(result: unknown): string {
  const body = result as { audio?: { url?: string }; audio_url?: string | { url?: string }; url?: string };
  const url = body.audio?.url ?? (typeof body.audio_url === 'string' ? body.audio_url : body.audio_url?.url) ?? body.url;
  if (!url) throw new Error('The voice engine returned no audio.');
  return url;
}

export async function recordSceneLine(
  auth: AuthContext,
  input: { workspaceId: string; projectId: string; projectTitle: string; sceneId: string; speaker: string | undefined; line: string; seconds: number; rules: AdRules },
): Promise<{ durationSec: number; fits: boolean; voice: string }> {
  if (!fal.falConfigured()) throw new AppError(503, 'INTERNAL_ERROR', `Voices are not switched on yet (the ${ENGINE_NAME} is not connected).`);
  const settings = await getStudioSettings();
  const model = settings.models.tts;
  if (!model.enabled) throw new AppError(503, 'INTERNAL_ERROR', 'Voices are switched off by the platform operator.');
  const { voices: rawMapping, ...extra } = model.extra as Record<string, unknown>;
  const mapping = Object.fromEntries(Object.entries((rawMapping ?? {}) as Record<string, string>).map(([key, value]) => [key.trim().toLowerCase(), value]));
  const voice = pickVoice(input.speaker, input.rules, mapping);

  const estimateSeconds = Math.max(1, Math.ceil(input.line.trim().split(/\s+/).length / 2.5));
  const perSecond = settings.costs.ttsPerSecond;
  const { reservation } = await reserveTokens(auth, input.workspaceId, 'AD_VOICE', Math.max(1, estimateSeconds * perSecond * 2), { projectId: input.projectId, sceneId: input.sceneId });
  const dir = await mkdtemp(join(tmpdir(), 'ad-voice-'));
  try {
    const handle = await fal.submit(model.endpoint, { ...extra, text: input.line.trim(), voice });
    const result = await fal.wait(handle, { timeoutMs: 3 * 60_000 });
    const file = join(dir, 'voice.mp3');
    await downloadUrl(audioUrl(result), file);
    // Audio only: probe() demands a video stream.
    const durationSec = await mediaDuration(file);

    const [asset] = await sql<{ id: string }[]>`
      INSERT INTO studio_assets (project_id, workspace_id, role, key, name, content_type, size, meta, status)
      VALUES (${input.projectId}, ${input.workspaceId}, 'VOICE', '', ${`${input.speaker ?? 'Voice-over'}.mp3`}, 'audio/mpeg', 0,
        ${json({ durationSec: +durationSec.toFixed(3), speaker: input.speaker ?? null, voice })}, 'PENDING') RETURNING id`;
    const key = keys.studioAsset(input.workspaceId, input.projectId, asset!.id, `voice-${randomUUID().slice(0, 8)}.mp3`);
    await uploadFile(key, file, 'audio/mpeg');
    await sql`UPDATE studio_assets SET key = ${key}, status = 'READY' WHERE id = ${asset!.id}`;

    // The scene's previous recording goes (file included).
    const [previous] = await sql<{ voiceAssetId: string | null }[]>`SELECT voice_asset_id FROM studio_scenes WHERE id = ${input.sceneId}`;
    await sql`UPDATE studio_scenes SET voice_asset_id = ${asset!.id}, updated_at = now() WHERE id = ${input.sceneId}`;
    if (previous?.voiceAssetId) await studio.deleteAsset(auth, input.workspaceId, input.projectId, previous.voiceAssetId).catch(() => undefined);

    const charge = Math.max(1, Math.ceil(durationSec)) * perSecond;
    await settleSystem(reservation.id, input.workspaceId, charge, `Ad · ${input.projectTitle.slice(0, 50)}: voice line (${durationSec.toFixed(1)} s)`);
    if (!reservation.unmetered) await sql`UPDATE studio_projects SET tokens_charged = tokens_charged + ${charge} WHERE id = ${input.projectId}`;
    return { durationSec, fits: durationSec <= input.seconds + 0.3, voice };
  } catch (error) {
    await releaseSystem(reservation.id, input.workspaceId).catch(() => undefined);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
