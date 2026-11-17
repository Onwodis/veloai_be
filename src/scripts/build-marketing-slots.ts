/** Compiles /asset.md (repo root) into data/marketing/slots.json for the marketing studio. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAssetList, SLOTS_FILE } from '../marketing/slots.js';

const source = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'asset.md');
const slots = parseAssetList(await readFile(source, 'utf8'));
await mkdir(dirname(SLOTS_FILE), { recursive: true });
await writeFile(SLOTS_FILE, `${JSON.stringify(slots, null, 2)}\n`, 'utf8');
console.log(`${slots.length} slot(s) → ${SLOTS_FILE}`);
