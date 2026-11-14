/**
 * Builds the move library files from the catalog:
 *   be/data/moves/library.json    every library move (base + variants)
 *   be/data/moves/templates.json  intro / scene / outro templates
 *
 *   pnpm moves:build
 *
 * Fails (exit 1) on a duplicate id or name, an unknown code, or a cue too long
 * for a prompt. The server only reads the JSON files (library.ts).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callsToAction, lifestyle, presenter, product, reactions, testimonials } from './catalog/ads.js';
import type { CategoryBlock, Row } from './catalog/dsl.js';
import { dances, footwork } from './catalog/musicDance.js';
import { crowd, emotions, faces, mics, vocals } from './catalog/musicExpression.js';
import { entrances, hands, stances, walks } from './catalog/musicPresence.js';
import { duets, exits, groups, props, stunts } from './catalog/musicStage.js';
import { templateBlocks } from './catalog/templates.js';
import { VARIANTS } from './catalog/variants.js';
import { CATEGORY_INFO, type Mood, type Move, type SceneTemplate, type SongSection, type Tempo } from './types.js';

const SECTION: Record<string, SongSection> = { i: 'INTRO', v: 'VERSE', p: 'PRE_CHORUS', c: 'CHORUS', b: 'BRIDGE', d: 'DROP', k: 'BREAKDOWN', n: 'INSTRUMENTAL', a: 'AD_LIB', o: 'OUTRO', '*': 'ANY' };
const MOOD: Record<string, Mood> = { h: 'HAPPY', r: 'ROMANTIC', x: 'SENSUAL', s: 'SAD', d: 'DEFIANT', c: 'CONFIDENT', g: 'SPIRITUAL', p: 'PLAYFUL', n: 'NOSTALGIC', t: 'TRIUMPHANT', y: 'MYSTERIOUS', m: 'CALM', '*': 'ANY' };
const TEMPO: Record<string, Tempo> = { S: 'SLOW', M: 'MID', F: 'FAST', A: 'ANY' };
const MAX_CUE = 420;

const BLOCKS: CategoryBlock[] = [
  entrances, walks, stances, hands, faces, vocals, mics, emotions, crowd, dances, footwork, props, duets, groups, stunts, exits,
  presenter, product, reactions, testimonials, lifestyle, callsToAction,
];

const decode = <T>(codes: string, table: Record<string, T>, where: string): T[] =>
  [...new Set([...codes].map((code) => {
    const value = table[code];
    if (!value) throw new Error(`${where}: unknown code "${code}"`);
    return value;
  }))];

function expand(block: CategoryBlock, row: Row, index: number): Move {
  const [name, cue, detail, sections, moods, tempo, energy, options = {}] = row;
  const domain = CATEGORY_INFO[block.category].domain;
  const id = `${domain === 'AD' ? 'AD' : 'MV'}-${block.code}-${String(index + 1).padStart(3, '0')}`;
  return {
    id,
    name,
    domain,
    category: block.category,
    cue,
    detail,
    sections: decode(sections, SECTION, id),
    moods: decode(moods, MOOD, id),
    tempo: TEMPO[tempo]!,
    energy,
    gender: options.g === 'F' ? 'FEMALE' : options.g === 'M' ? 'MALE' : 'ANY',
    genres: options.genres ?? [],
    shot: options.shot ?? block.defaultShot,
    difficulty: options.x ?? block.defaultDifficulty,
    props: options.props ?? [],
    signature: options.sig ?? false,
    tags: options.tags ?? [],
  };
}

export function buildLibrary(): { moves: Move[]; templates: SceneTemplate[] } {
  const moves: Move[] = [];
  for (const block of BLOCKS) {
    block.rows.forEach((row, index) => {
      const base = expand(block, row, index);
      moves.push(base);
      for (const variant of VARIANTS) {
        if (!variant.categories.includes(base.category) || !variant.applies(base)) continue;
        if (row[7]?.no?.includes(variant.code)) continue;
        moves.push({
          ...base,
          ...variant.change(base),
          id: `${base.id}-${variant.code}`,
          name: `${base.name} · ${variant.label}`,
          cue: `${base.cue}, ${variant.clause}`,
          detail: `${base.detail} ${variant.note}`,
          baseId: base.id,
        });
      }
    });
  }
  const templates: SceneTemplate[] = templateBlocks.flatMap((block) =>
    block.rows.map(([name, direction, camera, light, seconds, moods, whenToUse, tags], index) => ({
      id: `TP-${block.code}-${String(index + 1).padStart(3, '0')}`,
      name,
      domain: block.domain,
      kind: block.kind,
      direction,
      camera,
      light,
      seconds,
      moods: decode(moods, MOOD, name),
      whenToUse,
      tags: tags ?? [],
    })),
  );
  return { moves, templates };
}

function check(moves: Move[], templates: SceneTemplate[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const move of moves) {
    if (seen.has(move.id)) problems.push(`duplicate id ${move.id}`);
    if (names.has(move.name.toLowerCase())) problems.push(`duplicate name "${move.name}"`);
    seen.add(move.id);
    names.add(move.name.toLowerCase());
    if (move.cue.length > MAX_CUE) problems.push(`${move.id}: cue is ${move.cue.length} characters (max ${MAX_CUE})`);
    if (move.energy < 1 || move.energy > 5) problems.push(`${move.id}: energy ${move.energy}`);
  }
  const templateIds = new Set<string>();
  for (const template of templates) {
    if (templateIds.has(template.id)) problems.push(`duplicate template ${template.id}`);
    templateIds.add(template.id);
  }
  return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { moves, templates } = buildLibrary();
  const problems = check(moves, templates);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'moves');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'library.json'), `${JSON.stringify({ version: 1, builtAt: new Date().toISOString(), moves }, null, 0)}\n`, 'utf8');
  await writeFile(join(out, 'templates.json'), `${JSON.stringify({ version: 1, templates }, null, 2)}\n`, 'utf8');
  const byCategory = moves.reduce<Record<string, number>>((counts, move) => ({ ...counts, [move.category]: (counts[move.category] ?? 0) + 1 }), {});
  console.log(`${moves.length} moves (${moves.filter((move) => !move.baseId).length} base) · ${templates.length} templates`);
  console.log(Object.entries(byCategory).map(([category, count]) => `${category} ${count}`).join(' · '));
}
