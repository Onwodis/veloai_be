/**
 * `pnpm render:check`: exercises the reel editor with no external services.
 * Synthesises a 30 s 1280×720 test video with a tone, fakes a transcript with
 * pauses (so jump cuts trigger) and flashpoint words, then renders:
 *   original aspect · 9:16 fit · 9:16 crop muted
 * and verifies size, audio, that pauses were cut and the thumbnail exists.
 * Pass `--keep` to leave the files in the temp folder for viewing.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG, ffmpeg, probe } from '../media/ffmpeg.js';
import { DEFAULT_STYLE, renderReel, type Framing } from '../media/render.js';
import type { CaptionStyle } from '../media/captions.js';
import type { Word } from '../media/transcribe.js';

const keep = process.argv.includes('--keep');
const dir = await mkdtemp(join(tmpdir(), 'render-check-'));
const source = join(dir, 'source.mp4');

console.log(`ffmpeg: ${FFMPEG}`);
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', source]);

// Three phrases separated by 1.5 s pauses, with a number and an exclamation.
const phrases = ['This is the moment everyone gets wrong about short form video', 'Here is the one simple fix that made 10000 dollars', 'It changes everything for your channel!'];
const words: Word[] = [];
let at = 2;
for (const phrase of phrases) {
  for (const w of phrase.split(' ')) {
    words.push({ w, s: +at.toFixed(2), e: +(at + 0.38).toFixed(2) });
    at += 0.42;
  }
  at += 1.5;
}
const clip = { start: 1.5, end: Math.min(29, at) };

const cases: { framing: Framing; caption: CaptionStyle; muted: boolean; size: [number, number] }[] = [
  { framing: 'original', caption: 'pop', muted: false, size: [1280, 720] },
  { framing: 'fit', caption: 'karaoke', muted: false, size: [1080, 1920] },
  { framing: 'crop', caption: 'minimal', muted: true, size: [1080, 1920] },
];

let ok = true;
for (const item of cases) {
  const started = Date.now();
  const label = `${item.framing}/${item.caption}${item.muted ? '/muted' : ''}`;
  try {
    const out = await renderReel({
      source,
      workDir: dir,
      reelId: `reel-${item.framing}`,
      ...clip,
      words,
      framing: item.framing,
      captionStyle: item.caption,
      hasAudio: true,
      sourceSize: { width: 1280, height: 720 },
      style: { ...DEFAULT_STYLE, muted: item.muted },
      plan: { hookText: 'Nobody tells you this', beats: [{ t: words[17]!.s, kind: 'text', text: '$10,000' }] },
    });
    const media = await probe(out.video);
    const size = (await stat(out.video)).size;
    const thumb = (await stat(out.thumb)).size;
    const cutShorter = media.durationSec < clip.end - clip.start - 1.5;
    const pass = media.width === item.size[0] && media.height === item.size[1] && media.hasAudio === !item.muted && cutShorter && out.cuts >= 2 && thumb > 0;
    ok &&= pass;
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${label}: ${media.width}×${media.height}, ${media.durationSec.toFixed(2)} s (from ${(clip.end - clip.start).toFixed(1)} s, ${out.cuts} cuts, ${out.effects} effects), audio ${media.hasAudio}, ${(size / 1024).toFixed(0)} KB, ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  } catch (error) {
    ok = false;
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
    if ((error as { stderrTail?: string }).stderrTail) console.log((error as { stderrTail: string }).stderrTail);
  }
}

if (keep) console.log(`files kept in ${dir}`);
else await rm(dir, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
