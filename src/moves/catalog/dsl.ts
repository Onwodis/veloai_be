/**
 * Compact authoring format for the move catalog (expanded by build.ts).
 *
 *   [name, cue, detail, sections, moods, tempo, energy, options?]
 *
 *   sections  i intro · v verse · p pre-chorus · c chorus · b bridge · d drop · k breakdown
 *             n instrumental · a ad-lib · o outro · * any
 *   moods     h happy · r romantic · x sensual · s sad · d defiant · c confident · g spiritual
 *             p playful · n nostalgic · t triumphant · y mysterious · m calm · * any
 *   tempo     S slow · M mid · F fast · A any
 *   energy    1 (still, subtle) … 5 (all-out)
 *   options   g: 'F' | 'M' (who it suits; default any) · shot (MoveShot) · x difficulty 1-3 · props · sig · genres · tags
 *
 * IDs come from the position in each list: ONLY APPEND to a list (never reorder or
 * delete), so ids already placed on scenes and shared stay valid.
 */
import type { MoveCategory, MoveShot } from '../types.js';

export interface Opts {
  g?: 'F' | 'M';
  shot?: MoveShot;
  x?: 1 | 2 | 3;
  props?: string[];
  sig?: boolean;
  genres?: string[];
  tags?: string[];
  /** Variant codes this move must not get (see variants.ts). */
  no?: string[];
}

export type Row = [name: string, cue: string, detail: string, sections: string, moods: string, tempo: 'S' | 'M' | 'F' | 'A', energy: number, options?: Opts];

export interface CategoryBlock {
  category: MoveCategory;
  /** Short code in the id: MV-<code>-001. */
  code: string;
  defaultShot: MoveShot;
  defaultDifficulty: 1 | 2 | 3;
  rows: Row[];
}

export const block = (category: MoveCategory, code: string, defaultShot: MoveShot, defaultDifficulty: 1 | 2 | 3, rows: Row[]): CategoryBlock => ({ category, code, defaultShot, defaultDifficulty, rows });
