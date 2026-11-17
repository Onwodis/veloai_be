/**
 * The site's asset slots: every image and video the landing page (and other
 * public pages) show, compiled from /asset.md at the repo root (the list the
 * code's `ASSET:` comments point to). `pnpm marketing:slots` rebuilds
 * be/data/marketing/slots.json; the API reads that file at runtime.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Slot {
  /** Stable id from the file path, e.g. "landing-hero-loop-mp4". */
  id: string;
  page: string;
  section: string;
  /** Where the site serves it, e.g. "/media/landing/hero-loop.mp4". */
  path: string;
  kind: 'IMAGE' | 'VIDEO';
  spec: string;
  aspect: '16:9' | '9:16' | '1:1';
  /** Clip length for videos (capped at what the engine makes in one go). */
  durationSec: number | null;
  prompt: string;
}

const aspectOf = (spec: string): Slot['aspect'] => {
  const size = /(\d{3,4})\s*[×x]\s*(\d{3,4})/.exec(spec);
  if (!size) return '16:9';
  const ratio = Number(size[1]) / Number(size[2]);
  return ratio > 1.15 ? '16:9' : ratio < 0.87 ? '9:16' : '1:1';
};

const durationOf = (spec: string): number | null => {
  const range = /(\d+)\s*(?:[–-]\s*(\d+))?\s*s\b/.exec(spec);
  if (!range) return null;
  return Math.min(10, Number(range[2] ?? range[1]));
};

/**
 * Parses asset.md. Two layouts are understood:
 *   one asset per table   "| **File** | `path` |", "| **Spec** | … |", then a "> prompt" quote
 *   a section table       "**Spec…:** …" + "**Add this style suffix…:** …" lines, then rows
 *                         "| `path` | prompt |" (or "| `name.jpg` / `.mp4` | prompt |" under a
 *                         "Files (`folder/…`)" header, giving both files)
 */
export function parseAssetList(markdown: string): Slot[] {
  const slots: Slot[] = [];
  let page = '';
  let section = '';
  let sectionSpec = '';
  let suffix = '';
  let folder = '';
  let current: Partial<Slot> | null = null;
  const add = (path: string, spec: string, prompt: string): void => {
    if (slots.some((slot) => slot.path === path)) return;
    const video = /\.(mp4|webm|mov)$/i.test(path);
    slots.push({
      id: path.replace(/^\/+/, '').replace(/^media\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      page,
      section,
      path,
      kind: video ? 'VIDEO' : 'IMAGE',
      spec,
      aspect: aspectOf(spec),
      durationSec: video ? (durationOf(spec) ?? 8) : null,
      prompt,
    });
  };
  const flush = (): void => {
    if (current?.path && current.prompt) add(current.path, current.spec ?? '', current.prompt);
    current = null;
  };
  const withSuffix = (prompt: string): string => (suffix ? `${prompt.replace(/[.\s]+$/, '')}, ${suffix}` : prompt);
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const pageMatch = /^##\s+(?:\d+\.\s*)?(.+?)(?::\s*`.*`)?$/.exec(line);
    if (pageMatch && !line.startsWith('###')) {
      flush();
      page = pageMatch[1]!.replace(/`/g, '').trim();
      sectionSpec = suffix = folder = '';
      continue;
    }
    if (line.startsWith('### ')) {
      flush();
      section = line.slice(4).replace(/`/g, '').trim();
      sectionSpec = suffix = folder = '';
      continue;
    }
    const specLine = /^\*\*Spec[^*]*:\*\*\s*(.+)$/.exec(line);
    if (specLine) {
      sectionSpec = specLine[1]!.trim();
      continue;
    }
    const suffixLine = /^\*\*Add this style suffix[^*]*:\*\*\s*(.+)$/.exec(line);
    if (suffixLine) {
      suffix = suffixLine[1]!.trim();
      continue;
    }
    const folderHeader = /^\|\s*Files\s*\(`([^`]+?)\/?…?`\)/.exec(line);
    if (folderHeader) {
      folder = folderHeader[1]!.replace(/^fe\/public/, '').replace(/…$/, '').replace(/\/+$/, '');
      continue;
    }
    // Section tables: "| `path` | prompt |" or "| `name.jpg` / `.mp4` | prompt |".
    const row = /^\|\s*`([^`]+)`(?:\s*\/\s*`(\.[a-z0-9]+)`)?\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (row && !line.includes('**')) {
      const first = row[1]!.startsWith('fe/public') ? row[1]!.replace(/^fe\/public/, '') : `${folder}/${row[1]}`;
      const prompt = withSuffix(row[3]!);
      if (row[2]) {
        // A video and its poster: the video first (its poster is a still of it).
        add(first.replace(/\.[a-z0-9]+$/i, row[2]), sectionSpec, prompt);
        add(first, sectionSpec, `${prompt} (single still frame, the poster of the video)`);
      } else {
        add(first, sectionSpec, prompt);
      }
      continue;
    }
    const file = /^\|\s*\*\*File\*\*\s*\|\s*`([^`]+)`/.exec(line);
    if (file) {
      flush();
      current = { path: file[1]!.replace(/^fe\/public/, '') };
      continue;
    }
    const spec = /^\|\s*\*\*Spec\*\*\s*\|\s*(.+?)\s*\|?$/.exec(line);
    if (spec && current) {
      current.spec = spec[1]!;
      continue;
    }
    if (line.startsWith('>') && current) {
      current.prompt = `${current.prompt ? `${current.prompt} ` : ''}${line.replace(/^>\s?/, '')}`.trim();
    }
  }
  flush();
  return slots;
}

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'marketing', 'slots.json');
let cache: Slot[] | null = null;

export async function loadSlots(): Promise<Slot[]> {
  cache ??= JSON.parse(await readFile(DATA, 'utf8').catch(() => '[]')) as Slot[];
  return cache;
}

export const SLOTS_FILE = DATA;
