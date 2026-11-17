/**
 * Snapshots of a project's editable state, their diffs, and restoring them.
 *
 * What is captured (never media bytes; takes, songs and uploads are shared assets):
 *   project      title, finish (grade, loudness, desk)
 *   scenes       plan text, shot, timing, cast, wardrobe, place, lyric, delivery, moves,
 *                approval (in / out of the video)
 *   music video  genre, vision, mood, artist, lyrics, titles, direction, options
 *   cast         names, roles, written attributes, costumes, profile, performance notes
 *   ad           objective, platform, length, goal, call to action, rules, script, summary, end card
 *
 * Restoring is non-destructive: scenes made since the snapshot are kept but left out
 * of the video (their paid takes stay); locked (shot-approved) scenes are not touched.
 */
import { json, sql } from '../studio/sql.js';

type Json = unknown;

export interface SceneState {
  id: string;
  position: number;
  kind: string;
  description: string;
  prompt: string | null;
  shot: string;
  transition: string;
  transitionMode: string;
  durationSec: number;
  characterIds: string[];
  costume: string | null;
  location: string | null;
  timeOfDay: string | null;
  lyric: string | null;
  mode: string | null;
  emotion: string | null;
  intensity: number | null;
  subtitles: boolean | null;
  featuresSubject: boolean;
  lipSync: boolean;
  edits: Json;
  moves: Json;
  approved: boolean;
}

export interface CharacterState {
  id: string;
  name: string;
  role: string;
  attributes: Json;
  costumes: Json;
  profile: string | null;
  performance: string | null;
}

export interface Snapshot {
  version: 1;
  kind: string;
  project: { title: string; finish: Json };
  scenes: SceneState[];
  musicVideo?: Record<string, Json>;
  characters?: CharacterState[];
  ad?: Record<string, Json>;
}

const MV_FIELDS = ['genre', 'vision', 'mood', 'lead_act', 'artist_name', 'lyrics', 'titles', 'direction', 'subtitles', 'creative_mode', 'foley', 'loudness_lufs'] as const;
const AD_FIELDS = ['objective', 'platform', 'length_sec', 'goal', 'call_to_action', 'rules', 'script', 'summary', 'end_card'] as const;
const camel = (name: string): string => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export async function takeSnapshot(projectId: string): Promise<Snapshot> {
  const [project] = await sql<{ kind: string; title: string; finish: Json }[]>`SELECT kind, title, finish FROM studio_projects WHERE id = ${projectId}`;
  if (!project) throw new Error('project not found');
  const scenes = await sql<(Omit<SceneState, 'approved'> & { approvedAt: Date | null })[]>`
    SELECT id, position, kind, description, prompt, shot, transition, transition_mode, duration_sec, character_ids, costume, location, time_of_day,
      lyric, mode, emotion, intensity, subtitles, features_subject, lip_sync, edits, moves, approved_at
    FROM studio_scenes WHERE project_id = ${projectId} ORDER BY position`;
  const snapshot: Snapshot = {
    version: 1,
    kind: project.kind,
    project: { title: project.title, finish: project.finish ?? {} },
    scenes: scenes.map(({ approvedAt, ...scene }) => ({ ...scene, durationSec: Number(scene.durationSec), approved: Boolean(approvedAt) })),
  };
  if (project.kind === 'MUSIC_VIDEO') {
    const [mv] = await sql<Record<string, Json>[]>`SELECT ${sql(MV_FIELDS as unknown as string[])} FROM mv_projects WHERE project_id = ${projectId}`;
    snapshot.musicVideo = mv ?? {};
    snapshot.characters = await sql<CharacterState[]>`
      SELECT id, name, role, attributes, costumes, profile, performance FROM mv_characters WHERE project_id = ${projectId} ORDER BY position`;
  }
  if (project.kind === 'COMMERCIAL') {
    const [ad] = await sql<Record<string, Json>[]>`SELECT ${sql(AD_FIELDS as unknown as string[])} FROM ad_projects WHERE project_id = ${projectId}`;
    snapshot.ad = ad ?? {};
  }
  return snapshot;
}

/* ------------------------------------------------------------------ diff */

export interface Change {
  area: 'project' | 'scene' | 'cast' | 'song' | 'ad';
  label: string;
  /** Present for scene / cast changes. */
  ref?: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

const text = (value: Json): string => (value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
const same = (a: Json, b: Json): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const short = (value: Json): string => {
  const out = text(value);
  return out.length > 600 ? `${out.slice(0, 600)}…` : out;
};

const SCENE_LABELS: Partial<Record<keyof SceneState, string>> = {
  description: 'what happens',
  prompt: 'shot prompt',
  shot: 'shot',
  durationSec: 'length',
  characterIds: 'cast',
  costume: 'wardrobe',
  location: 'location',
  timeOfDay: 'time of day',
  lyric: 'lyric',
  mode: 'scene type',
  emotion: 'delivery',
  intensity: 'intensity',
  transition: 'transition',
  edits: 'clip edits',
  moves: 'moves',
  approved: 'in the video',
};

export function diffSnapshots(before: Snapshot | null, after: Snapshot): Change[] {
  const changes: Change[] = [];
  if (before && !same(before.project.title, after.project.title)) changes.push({ area: 'project', label: 'Title', kind: 'changed', before: before.project.title, after: after.project.title });
  if (before && !same(before.project.finish, after.project.finish)) changes.push({ area: 'project', label: 'Master settings', kind: 'changed', before: short(before.project.finish), after: short(after.project.finish) });

  const old = new Map((before?.scenes ?? []).map((scene) => [scene.id, scene]));
  for (const scene of after.scenes) {
    const previous = old.get(scene.id);
    const name = `Scene ${scene.position + 1}`;
    if (!previous) {
      changes.push({ area: 'scene', ref: scene.id, label: name, kind: 'added', after: scene.description });
      continue;
    }
    for (const [field, label] of Object.entries(SCENE_LABELS) as [keyof SceneState, string][]) {
      if (!same(previous[field], scene[field])) changes.push({ area: 'scene', ref: scene.id, label: `${name}: ${label}`, kind: 'changed', before: short(previous[field]), after: short(scene[field]) });
    }
  }
  const now = new Set(after.scenes.map((scene) => scene.id));
  for (const scene of before?.scenes ?? []) if (!now.has(scene.id)) changes.push({ area: 'scene', ref: scene.id, label: `Scene ${scene.position + 1}`, kind: 'removed', before: scene.description });

  const oldCast = new Map((before?.characters ?? []).map((member) => [member.id, member]));
  for (const member of after.characters ?? []) {
    const previous = oldCast.get(member.id);
    if (!previous) changes.push({ area: 'cast', ref: member.id, label: member.name, kind: 'added' });
    else if (!same(previous, member)) changes.push({ area: 'cast', ref: member.id, label: member.name, kind: 'changed', before: short({ ...previous, id: undefined }), after: short({ ...member, id: undefined }) });
  }
  const castNow = new Set((after.characters ?? []).map((member) => member.id));
  for (const member of before?.characters ?? []) if (!castNow.has(member.id)) changes.push({ area: 'cast', ref: member.id, label: member.name, kind: 'removed' });

  for (const [area, a, b] of [['song', before?.musicVideo, after.musicVideo] as const, ['ad', before?.ad, after.ad] as const]) {
    if (!b) continue;
    for (const key of Object.keys(b)) {
      if (before && !same(a?.[key], b[key])) changes.push({ area, label: key.replace(/([A-Z])/g, ' $1').toLowerCase(), kind: 'changed', before: short(a?.[key]), after: short(b[key]) });
    }
  }
  return changes;
}

/** "3 scenes rewritten, 1 scene added, cast updated, master settings changed". */
export function summarise(changes: Change[], first: boolean): string {
  if (first) return 'First checkpoint of the project';
  if (!changes.length) return 'No changes';
  const scenes = (kind: Change['kind']) => new Set(changes.filter((change) => change.area === 'scene' && change.kind === kind).map((change) => change.ref)).size;
  const rewritten = new Set(changes.filter((change) => change.area === 'scene' && change.kind === 'changed' && /what happens|shot prompt|lyric/.test(change.label)).map((change) => change.ref)).size;
  const restaged = scenes('changed') - rewritten;
  const moves = new Set(changes.filter((change) => change.label.endsWith(': moves')).map((change) => change.ref)).size;
  const parts = [
    rewritten && `${rewritten} scene${rewritten === 1 ? '' : 's'} rewritten`,
    restaged > 0 && `${restaged} scene${restaged === 1 ? '' : 's'} adjusted`,
    moves && `moves changed in ${moves} scene${moves === 1 ? '' : 's'}`,
    scenes('added') && `${scenes('added')} scene${scenes('added') === 1 ? '' : 's'} added`,
    scenes('removed') && `${scenes('removed')} scene${scenes('removed') === 1 ? '' : 's'} removed`,
    changes.some((change) => change.area === 'cast') && 'cast updated',
    changes.some((change) => change.area === 'song') && 'song & vision changed',
    changes.some((change) => change.area === 'ad') && 'brief or script changed',
    changes.some((change) => change.area === 'project') && 'title or master settings changed',
  ].filter(Boolean);
  return parts.join(', ').replace(/^./, (letter) => letter.toUpperCase());
}

/* ------------------------------------------------------------------ restore */

export interface RestoreReport {
  scenesRestored: number;
  scenesRecreated: number;
  scenesLeftOut: number;
  lockedSkipped: number;
}

export async function restoreSnapshot(projectId: string, snapshot: Snapshot): Promise<RestoreReport> {
  const report: RestoreReport = { scenesRestored: 0, scenesRecreated: 0, scenesLeftOut: 0, lockedSkipped: 0 };
  await sql.begin(async (tx) => {
    await tx`UPDATE studio_projects SET title = ${snapshot.project.title}, finish = ${json(snapshot.project.finish)}, updated_at = now() WHERE id = ${projectId}`;
    const current = await tx<{ id: string; shotApprovedAt: Date | null }[]>`SELECT id, shot_approved_at FROM studio_scenes WHERE project_id = ${projectId}`;
    const byId = new Map(current.map((scene) => [scene.id, scene]));
    const wanted = new Set(snapshot.scenes.map((scene) => scene.id));
    // Positions are reassigned at the end; park everything out of the way of the unique order first.
    await tx`UPDATE studio_scenes SET position = position + 10000 WHERE project_id = ${projectId}`;
    for (const scene of snapshot.scenes) {
      const live = byId.get(scene.id);
      if (live?.shotApprovedAt) {
        report.lockedSkipped += 1;
        await tx`UPDATE studio_scenes SET position = ${scene.position} WHERE id = ${scene.id}`;
        continue;
      }
      const fields = {
        position: scene.position,
        kind: scene.kind,
        description: scene.description,
        prompt: scene.prompt,
        shot: scene.shot,
        transition: scene.transition,
        transition_mode: scene.transitionMode,
        duration_sec: scene.durationSec,
        character_ids: scene.characterIds,
        costume: scene.costume,
        location: scene.location,
        time_of_day: scene.timeOfDay,
        lyric: scene.lyric,
        mode: scene.mode,
        emotion: scene.emotion,
        intensity: scene.intensity,
        subtitles: scene.subtitles,
        features_subject: scene.featuresSubject,
        lip_sync: scene.lipSync,
      };
      if (live) {
        await tx`
          UPDATE studio_scenes SET ${tx(fields)}, edits = ${json(scene.edits ?? null)}, moves = ${json(scene.moves ?? [])},
            approved_at = ${scene.approved ? tx`COALESCE(approved_at, now())` : null}, updated_at = now()
          WHERE id = ${scene.id}`;
        report.scenesRestored += 1;
      } else {
        await tx`
          INSERT INTO studio_scenes ${tx({ id: scene.id, project_id: projectId, ...fields })}`;
        await tx`UPDATE studio_scenes SET edits = ${json(scene.edits ?? null)}, moves = ${json(scene.moves ?? [])}, approved_at = ${scene.approved ? new Date() : null} WHERE id = ${scene.id}`;
        report.scenesRecreated += 1;
      }
    }
    // Scenes made after the checkpoint: kept (their takes are paid for) but left out of the video, at the end.
    let tail = snapshot.scenes.length;
    for (const scene of current) {
      if (wanted.has(scene.id)) continue;
      await tx`UPDATE studio_scenes SET position = ${tail}, approved_at = ${scene.shotApprovedAt ? tx`approved_at` : null} WHERE id = ${scene.id}`;
      tail += 1;
      report.scenesLeftOut += 1;
    }

    if (snapshot.musicVideo && Object.keys(snapshot.musicVideo).length) {
      const values = Object.fromEntries(MV_FIELDS.filter((field) => camel(field) in snapshot.musicVideo!).map((field) => [field, snapshot.musicVideo![camel(field)]]));
      const jsonFields = new Set(['lyrics', 'titles', 'direction']);
      for (const [field, value] of Object.entries(values)) {
        await tx`UPDATE mv_projects SET ${tx(field)} = ${jsonFields.has(field) ? json(value ?? null) : (value as string | number | boolean | null)} WHERE project_id = ${projectId}`;
      }
    }
    for (const member of snapshot.characters ?? []) {
      await tx`
        UPDATE mv_characters SET name = ${member.name}, role = ${member.role}, attributes = ${json(member.attributes)}, costumes = ${json(member.costumes)},
          profile = ${member.profile}, performance = ${member.performance}, updated_at = now()
        WHERE id = ${member.id} AND project_id = ${projectId}`;
    }
    if (snapshot.ad && Object.keys(snapshot.ad).length) {
      const jsonFields = new Set(['rules', 'script', 'summary', 'end_card']);
      for (const field of AD_FIELDS) {
        if (!(camel(field) in snapshot.ad)) continue;
        const value = snapshot.ad[camel(field)];
        await tx`UPDATE ad_projects SET ${tx(field)} = ${jsonFields.has(field) ? json(value ?? null) : (value as string | number | null)} WHERE project_id = ${projectId}`;
      }
    }
  });
  return report;
}
