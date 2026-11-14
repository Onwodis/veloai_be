/**
 * Moves on characters in a scene (music videos and ads), templates on scenes,
 * and VeloBot's suggestions for a character in a scene.
 *
 * Only human characters can get moves: music-video cast members placed in
 * the scene, or an ad's cast. A placed move is a frozen copy (studio_scenes.moves),
 * so later edits or deletes of a custom move never change a scene behind the
 * creator's back. Limits: 3 moves per character per scene, 8 per scene.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../middleware/authenticate.js';
import { companyAccess, workspaceAccess } from '../commercials/companies.js';
import type { CharacterAttributes } from '../musicvideo/cast.js';
import { json, sql } from '../studio/sql.js';
import type { ProjectRow, SceneRow } from '../studio/types.js';
import { AppError } from '../utils/AppError.js';
import { ownCustom, present } from './custom.js';
import { libraryMove, libraryTemplate, suggestMoves, type SuggestContext } from './library.js';
import type { Mood, MoveGender, SceneMove, SongSection, Tempo } from './types.js';

const PER_CHARACTER = 3;
const PER_SCENE = 8;
const MV_EDITABLE = ['SCENES', 'DISCUSSION', 'STORYBOARD', 'SHOOT'];
const AD_EDITABLE = ['SCRIPT', 'SHOOT'];

interface Character {
  id: string | null;
  name: string;
  role: string | null;
  gender: MoveGender;
}

interface Loaded {
  project: ProjectRow;
  scene: SceneRow & { moves: SceneMove[] };
  characters: Character[];
  stage: string;
  context: Omit<SuggestContext, 'gender' | 'exclude'>;
}

const genderOf = (value: string | undefined | null): MoveGender => {
  const text = (value ?? '').toLowerCase();
  if (/\b(female|woman|girl|f)\b/.test(text)) return 'FEMALE';
  if (/\b(male|man|boy|m)\b/.test(text)) return 'MALE';
  return 'ANY';
};

const MOOD_WORDS: [RegExp, Mood][] = [
  [/happy|joy|fun|upbeat|feel.?good|bright/, 'HAPPY'],
  [/love|romant|tender|sweet/, 'ROMANTIC'],
  [/sensual|sexy|seduct|sultry|steamy/, 'SENSUAL'],
  [/sad|heartbreak|melanch|grief|pain|lonely|cry/, 'SAD'],
  [/angry|anger|defian|rebel|fierce|aggress/, 'DEFIANT'],
  [/confiden|boss|swag|bold|power/, 'CONFIDENT'],
  [/worship|gospel|spirit|praise|faith|prayer/, 'SPIRITUAL'],
  [/playful|cheek|flirt|party|groovy/, 'PLAYFUL'],
  [/nostalg|memory|throwback|reflect/, 'NOSTALGIC'],
  [/triumph|victory|celebr|anthem|win|epic/, 'TRIUMPHANT'],
  [/myster|dark|moody|haunt/, 'MYSTERIOUS'],
  [/calm|chill|peace|mellow|soft|relax/, 'CALM'],
];
const moodsIn = (...texts: (string | null | undefined)[]): Mood[] => {
  const text = texts.filter(Boolean).join(' ').toLowerCase();
  return [...new Set(MOOD_WORDS.filter(([pattern]) => pattern.test(text)).map(([, mood]) => mood))];
};

const sectionOf = (raw: string | null | undefined): SongSection | undefined => {
  const text = (raw ?? '').toLowerCase();
  if (/pre.?chorus|build/.test(text)) return 'PRE_CHORUS';
  if (/chorus|hook|refrain/.test(text)) return 'CHORUS';
  if (/verse/.test(text)) return 'VERSE';
  if (/bridge/.test(text)) return 'BRIDGE';
  if (/drop/.test(text)) return 'DROP';
  if (/break/.test(text)) return 'BREAKDOWN';
  if (/intro/.test(text)) return 'INTRO';
  if (/outro|end/.test(text)) return 'OUTRO';
  if (/instrument|solo/.test(text)) return 'INSTRUMENTAL';
  return undefined;
};

const tempoOf = (bpm: number | null | undefined): Tempo | undefined => (!bpm ? undefined : bpm < 85 ? 'SLOW' : bpm <= 115 ? 'MID' : 'FAST');

async function loadScene(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, write: boolean): Promise<Loaded> {
  await workspaceAccess(auth, workspaceId, write);
  const [project] = await sql<ProjectRow[]>`SELECT * FROM studio_projects WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!project || (project.kind !== 'MUSIC_VIDEO' && project.kind !== 'COMMERCIAL')) throw AppError.notFound('Project');
  const [scene] = await sql<(SceneRow & { moves: SceneMove[] })[]>`SELECT * FROM studio_scenes WHERE id = ${sceneId} AND project_id = ${projectId}`;
  if (!scene) throw AppError.notFound('Scene');
  const [take] = await sql<{ rhythm: { bpm: number | null; section: string; energy: number } | null }[]>`
    SELECT spec->'rhythm' AS rhythm FROM studio_takes WHERE scene_id = ${sceneId} ORDER BY created_at DESC LIMIT 1`;
  const rhythm = take?.rhythm ?? null;

  if (project.kind === 'MUSIC_VIDEO') {
    const [mv] = await sql<{ stage: string; genre: string; mood: string | null; vision: string }[]>`SELECT stage, genre, mood, vision FROM mv_projects WHERE project_id = ${projectId}`;
    const cast = scene.characterIds.length
      ? await sql<{ id: string; name: string; role: string; attributes: CharacterAttributes }[]>`SELECT id, name, role, attributes FROM mv_characters WHERE id = ANY(${scene.characterIds}::uuid[]) ORDER BY position`
      : [];
    const section = scene.kind === 'INTRO' ? 'INTRO' : scene.kind === 'OUTRO' ? 'OUTRO' : (sectionOf(rhythm?.section) ?? (scene.lyric ? 'VERSE' : 'INSTRUMENTAL'));
    return {
      project,
      scene,
      stage: mv?.stage ?? '',
      characters: cast.map((member) => ({ id: member.id, name: member.name, role: member.role.toLowerCase().replace('_', ' '), gender: genderOf(member.attributes.gender) })),
      context: {
        domain: 'MUSIC',
        section,
        moods: moodsIn(mv?.mood, scene.emotion, mv?.genre, scene.description),
        tempo: tempoOf(rhythm?.bpm),
        energy: rhythm ? Math.max(1, Math.min(5, Math.round(1 + rhythm.energy * 4))) : (scene.intensity ?? undefined) ? Math.min(5, (scene.intensity ?? 2) + 1) : undefined,
        genres: (mv?.genre ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean),
        mode: scene.mode ?? null,
        lipSync: scene.lipSync,
      },
    };
  }

  const [ad] = await sql<{ stage: string; companyId: string; objective: string; rules: { characters?: { name: string; role?: string; gender?: string }[] } }[]>`
    SELECT stage, company_id, objective, rules FROM ad_projects WHERE project_id = ${projectId}`;
  if (!ad) throw AppError.notFound('Ad');
  if (write) await companyAccess(auth, workspaceId, ad.companyId, true);
  const [{ count } = { count: 1 }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_scenes WHERE project_id = ${projectId}`;
  const objectiveMoods: Record<string, Mood[]> = { LAUNCH: ['TRIUMPHANT', 'CONFIDENT'], SALES: ['HAPPY', 'CONFIDENT'], AWARENESS: ['CONFIDENT', 'CALM'], APP_INSTALL: ['PLAYFUL', 'HAPPY'], EVENT: ['HAPPY', 'TRIUMPHANT'], RECRUITMENT: ['CONFIDENT', 'CALM'] };
  return {
    project,
    scene,
    stage: ad.stage,
    characters: (ad.rules.characters ?? []).map((member) => ({ id: null, name: member.name, role: member.role ?? null, gender: genderOf(member.gender) })),
    context: {
      domain: 'AD',
      section: scene.position === 0 ? 'INTRO' : scene.position === count - 1 ? 'OUTRO' : 'VERSE',
      moods: [...new Set([...(objectiveMoods[ad.objective] ?? []), ...moodsIn(scene.description)])],
      tempo: undefined,
      energy: undefined,
      genres: [],
      mode: null,
      lipSync: false,
    },
  };
}

function assertEditable(loaded: Loaded): void {
  if (loaded.project.status === 'ASSEMBLING') throw AppError.conflict('Wait for the master to finish (or pause it) first.');
  const allowed = loaded.project.kind === 'MUSIC_VIDEO' ? MV_EDITABLE : AD_EDITABLE;
  if (!allowed.includes(loaded.stage)) throw AppError.conflict(loaded.project.kind === 'MUSIC_VIDEO' ? 'Moves are set from the Scene ideas stage to the Shoot.' : 'Moves are set on the Script and Shoot stages.');
}

function findCharacter(loaded: Loaded, input: { characterId?: string | undefined; characterName?: string | undefined }): Character {
  const match = loaded.characters.find((member) => (input.characterId ? member.id === input.characterId : member.name.toLowerCase() === input.characterName?.trim().toLowerCase()));
  if (!match) {
    throw AppError.badRequest(
      loaded.project.kind === 'MUSIC_VIDEO' ? 'Moves go on a person in this scene: add the character to the scene first.' : 'Moves go on a cast member: add them on the Cast & voices stage first.',
    );
  }
  return match;
}

/** Everything the "Add a move" page needs for one scene (and suggestions for one character). */
export async function sceneMoveContext(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, character?: { characterId?: string | undefined; characterName?: string | undefined }) {
  const loaded = await loadScene(auth, workspaceId, projectId, sceneId, false);
  const chosen = character && (character.characterId || character.characterName) ? findCharacter(loaded, character) : (loaded.characters[0] ?? null);
  const suggestions = chosen
    ? suggestMoves({ ...loaded.context, gender: chosen.gender, exclude: loaded.scene.moves.filter((move) => move.characterName === chosen.name).map((move) => move.ref) }, 12).map(({ move, reasons }) => ({ move, reasons }))
    : [];
  return {
    project: { id: loaded.project.id, title: loaded.project.title, kind: loaded.project.kind },
    scene: { id: loaded.scene.id, position: loaded.scene.position, description: loaded.scene.description, lyric: loaded.scene.lyric, durationSec: Number(loaded.scene.durationSec) },
    characters: loaded.characters,
    character: chosen,
    moves: loaded.scene.moves,
    context: loaded.context,
    suggestions,
    editable: (() => {
      try {
        assertEditable(loaded);
        return true;
      } catch {
        return false;
      }
    })(),
  };
}

export async function addSceneMove(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, input: { ref: string; characterId?: string | undefined; characterName?: string | undefined }) {
  const loaded = await loadScene(auth, workspaceId, projectId, sceneId, true);
  assertEditable(loaded);
  const character = findCharacter(loaded, input);
  let entry: SceneMove;
  let thanks: { ownerName: string; name: string } | null = null;
  if (input.ref.startsWith('CM-')) {
    const row = await ownCustom(auth.userId, input.ref);
    if (!row) throw AppError.badRequest('Only your own moves can be added. Copy a shared move first (move id + key).');
    const move = present(row, auth.userId);
    entry = { id: randomUUID(), ref: move.id, name: move.name, cue: move.cue, category: move.category, characterId: character.id, characterName: character.name, source: 'CUSTOM', creditTo: move.origin?.ownerName ?? null, addedAt: new Date().toISOString() };
    if (move.origin) thanks = { ownerName: move.origin.ownerName, name: move.origin.name };
  } else {
    const move = libraryMove(input.ref);
    if (!move) throw AppError.badRequest('That move is not in the library.');
    entry = { id: randomUUID(), ref: move.id, name: move.name, cue: move.cue, category: move.category, characterId: character.id, characterName: character.name, source: 'LIBRARY', addedAt: new Date().toISOString() };
  }
  if (loaded.project.kind === 'MUSIC_VIDEO' && entry.ref.startsWith('AD-')) throw AppError.badRequest('That is a commercial move: pick a music move for a music video.');
  const mine = loaded.scene.moves.filter((move) => move.characterName === character.name);
  if (mine.some((move) => move.ref === entry.ref)) throw AppError.conflict(`${character.name} already has “${entry.name}” in this scene.`);
  if (mine.length >= PER_CHARACTER) throw AppError.badRequest(`${character.name} already has ${PER_CHARACTER} moves in this scene. Remove one first: more than that reads as choreography soup.`);
  if (loaded.scene.moves.length >= PER_SCENE) throw AppError.badRequest(`A scene holds up to ${PER_SCENE} moves.`);
  const moves = [...loaded.scene.moves, entry];
  await sql`UPDATE studio_scenes SET moves = ${json(moves)}, updated_at = now() WHERE id = ${sceneId}`;
  return { moves, added: entry, thanks };
}

export async function removeSceneMove(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, entryId: string) {
  const loaded = await loadScene(auth, workspaceId, projectId, sceneId, true);
  assertEditable(loaded);
  const moves = loaded.scene.moves.filter((move) => move.id !== entryId);
  if (moves.length === loaded.scene.moves.length) throw AppError.notFound('Move');
  await sql`UPDATE studio_scenes SET moves = ${json(moves)}, updated_at = now() WHERE id = ${sceneId}`;
  return { moves };
}

/** Stages the scene from a template: the description takes the template's direction (and the shot prompt gains it). */
export async function applyTemplate(auth: AuthContext, workspaceId: string, projectId: string, sceneId: string, templateId: string, mode: 'replace' | 'append') {
  const loaded = await loadScene(auth, workspaceId, projectId, sceneId, true);
  assertEditable(loaded);
  const template = libraryTemplate(templateId);
  if (!template) throw AppError.notFound('Template');
  if ((loaded.project.kind === 'MUSIC_VIDEO') !== (template.domain === 'MUSIC')) throw AppError.badRequest('That template is for the other kind of project.');
  const staging = `${template.direction} Camera: ${template.camera}. Light: ${template.light}.`;
  const description = (mode === 'replace' ? staging : `${loaded.scene.description.trim()} ${staging}`).slice(0, 1000).trim();
  const appended = loaded.scene.prompt ? `${loaded.scene.prompt.trim()} Staging: ${staging}`.slice(0, 2000) : null;
  // Ads: the prompt also carries the brief's rules (setting, cast, wardrobe), so it is always kept and extended.
  // Music videos: "replace" re-stages the scene from its new description.
  const prompt = mode === 'replace' && loaded.project.kind === 'MUSIC_VIDEO' ? null : appended;
  await sql`UPDATE studio_scenes SET description = ${description}, prompt = ${prompt}, updated_at = now() WHERE id = ${sceneId}`;
  return { description };
}
