/**
 * The move library at runtime: loaded once from be/data/moves/*.json (built by
 * `pnpm moves:build`), then filtered, sorted and paginated in memory, plus
 * VeloBot's suggestions for a scene (free: a scored match on section, mood,
 * tempo, energy, who it suits, genre and the kind of shot, spread across
 * categories so it never offers ten dance steps in a row).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Move, MoveCategory, MoveDomain, MoveGender, Mood, SceneTemplate, SongSection, Tempo } from './types.js';

let cache: { moves: Move[]; byId: Map<string, Move>; templates: SceneTemplate[] } | null = null;

function load(): NonNullable<typeof cache> {
  if (cache) return cache;
  const read = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../data/moves/${name}`, import.meta.url)), 'utf8')) as T;
  const moves = read<{ moves: Move[] }>('library.json').moves;
  const templates = read<{ templates: SceneTemplate[] }>('templates.json').templates;
  cache = { moves, byId: new Map(moves.map((move) => [move.id, move])), templates };
  return cache;
}

export const libraryMove = (id: string): Move | undefined => load().byId.get(id);
export const librarySize = (): number => load().moves.length;

export interface MoveFilters {
  domain?: MoveDomain | undefined;
  category?: MoveCategory | undefined;
  section?: SongSection | undefined;
  mood?: Mood | undefined;
  tempo?: Tempo | undefined;
  gender?: MoveGender | undefined;
  energy?: number | undefined;
  signature?: boolean | undefined;
  /** Only the base moves (hide variants). */
  baseOnly?: boolean | undefined;
  q?: string | undefined;
  sort?: 'category' | 'name' | 'energy' | undefined;
  page: number;
  pageSize: number;
}

const matchesAny = <T extends string>(list: T[], value: T | undefined): boolean => !value || list.includes(value) || list.includes('ANY' as T);

export function listMoves(filters: MoveFilters) {
  const needle = filters.q?.trim().toLowerCase();
  const order = new Map(Object.keys(categoryCounts(load().moves)).map((category, index) => [category, index]));
  const matched = load().moves.filter(
    (move) =>
      (!filters.domain || move.domain === filters.domain) &&
      (!filters.category || move.category === filters.category) &&
      matchesAny(move.sections, filters.section) &&
      matchesAny(move.moods, filters.mood) &&
      (!filters.tempo || move.tempo === filters.tempo || move.tempo === 'ANY') &&
      (!filters.gender || filters.gender === 'ANY' || move.gender === 'ANY' || move.gender === filters.gender) &&
      (!filters.energy || Math.abs(move.energy - filters.energy) <= 1) &&
      (!filters.signature || move.signature) &&
      (!filters.baseOnly || !move.baseId) &&
      (!needle || `${move.name} ${move.cue} ${move.tags.join(' ')} ${move.genres.join(' ')} ${move.props.join(' ')}`.toLowerCase().includes(needle)),
  );
  const sorted =
    filters.sort === 'name'
      ? [...matched].sort((a, b) => a.name.localeCompare(b.name))
      : filters.sort === 'energy'
        ? [...matched].sort((a, b) => b.energy - a.energy || a.name.localeCompare(b.name))
        : // Catalog order: by category, every base move before the variants, so a page is never five versions of one move.
          matched.sort((a, b) => (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0) || Number(Boolean(a.baseId)) - Number(Boolean(b.baseId)));
  const start = (filters.page - 1) * filters.pageSize;
  // Facets over the domain only, so the category chips always show what exists.
  const facets = categoryCounts(load().moves.filter((move) => !filters.domain || move.domain === filters.domain));
  return { items: sorted.slice(start, start + filters.pageSize), total: sorted.length, page: filters.page, pages: Math.max(1, Math.ceil(sorted.length / filters.pageSize)), facets };
}

function categoryCounts(moves: Move[]): Record<string, number> {
  return moves.reduce<Record<string, number>>((counts, move) => ({ ...counts, [move.category]: (counts[move.category] ?? 0) + 1 }), {});
}

export function listTemplates(filters: { domain?: MoveDomain | undefined; kind?: SceneTemplate['kind'] | undefined; q?: string | undefined }) {
  const needle = filters.q?.trim().toLowerCase();
  return load().templates.filter(
    (template) =>
      (!filters.domain || template.domain === filters.domain) &&
      (!filters.kind || template.kind === filters.kind) &&
      (!needle || `${template.name} ${template.direction} ${template.whenToUse}`.toLowerCase().includes(needle)),
  );
}

export const libraryTemplate = (id: string): SceneTemplate | undefined => load().templates.find((template) => template.id === id);

/* ------------------------------------------------------------------ suggestions */

export interface SuggestContext {
  domain: MoveDomain;
  section?: SongSection | undefined;
  moods: Mood[];
  tempo?: Tempo | undefined;
  energy?: number | undefined;
  gender?: MoveGender | undefined;
  genres: string[];
  /** Music video scene mode: what kind of shot it is. */
  mode?: 'PERFORMANCE' | 'NARRATIVE' | 'BROLL' | null | undefined;
  lipSync?: boolean | undefined;
  exclude: string[];
}

const MODE_FAVOURS: Record<string, MoveCategory[]> = {
  PERFORMANCE: ['MIC', 'VOCAL', 'FACE', 'STANCE', 'HANDS', 'CROWD'],
  NARRATIVE: ['WALK', 'EMOTION', 'DUET', 'PROP', 'FACE', 'EXIT'],
  BROLL: ['WALK', 'DANCE', 'GROUP', 'PROP'],
};

const label = (value: string): string => value.toLowerCase().replace(/_/g, '-');

export function suggestMoves(context: SuggestContext, limit = 12): { move: Move; score: number; reasons: string[] }[] {
  const scored = load()
    .moves.filter((move) => move.domain === context.domain && !context.exclude.includes(move.id))
    .filter((move) => !context.gender || context.gender === 'ANY' || move.gender === 'ANY' || move.gender === context.gender)
    .map((move) => {
      let score = 0;
      const reasons: string[] = [];
      if (context.section && move.sections.includes(context.section)) {
        score += 3;
        reasons.push(`made for the ${label(context.section)}`);
      } else if (move.sections.includes('ANY')) score += 1;
      const moods = move.moods.filter((mood) => context.moods.includes(mood));
      if (moods.length) {
        score += Math.min(4, moods.length * 2);
        reasons.push(`${moods.map(label).join(' / ')} mood`);
      }
      if (context.tempo && (move.tempo === context.tempo || move.tempo === 'ANY')) {
        score += move.tempo === context.tempo ? 2 : 1;
        if (move.tempo === context.tempo) reasons.push(`${label(context.tempo)} tempo`);
      }
      if (context.energy) score += Math.max(0, 2 - Math.abs(move.energy - context.energy) * 0.75);
      if (context.gender && context.gender !== 'ANY' && move.gender === context.gender) {
        score += 1;
        reasons.push(context.gender === 'FEMALE' ? 'suits a female lead' : 'suits a male lead');
      }
      const genres = move.genres.filter((genre) => context.genres.includes(genre));
      if (genres.length) {
        score += 1.5;
        reasons.push(genres.join(' / '));
      }
      if (context.mode && MODE_FAVOURS[context.mode]?.includes(move.category)) score += 1.5;
      if (context.lipSync && (move.category === 'VOCAL' || move.category === 'FACE')) score += 1;
      if (context.lipSync && move.difficulty === 3) score -= 2; // Big stunts fight a lip-synced face.
      if (move.signature) {
        score += 0.5;
        reasons.push('signature move');
      }
      return { move, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
  // Spread across categories (the best of each first, then the rest), and one version of a move at most.
  const picked: typeof scored = [];
  const used = new Map<string, number>();
  const root = (move: Move): string => move.baseId ?? move.id;
  for (const round of [1, 2, 3]) {
    for (const item of scored) {
      if (picked.length >= limit) break;
      if (picked.includes(item) || (used.get(item.move.category) ?? 0) >= round || picked.some((other) => root(other.move) === root(item.move))) continue;
      picked.push(item);
      used.set(item.move.category, (used.get(item.move.category) ?? 0) + 1);
    }
  }
  return picked;
}
