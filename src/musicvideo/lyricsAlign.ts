/**
 * Lyrics the artist typed, timed to the song: the speech model hears the song (word timings, often
 * with misheard words), the artist knows the words. Their lyrics are matched to the heard words
 * word by word (a global alignment that tolerates misheard, missing and extra words), and each of
 * their lines takes the timing of the words it matched; lines with no match sit between their
 * neighbours. Returns null when too little matches (the typed text isn't this song).
 */

export interface TimedWord {
  w: string;
  s: number;
  e: number;
}

export interface TimedLine {
  start: number;
  end: number;
  text: string;
}

const norm = (word: string): string =>
  word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9']/g, '')
    .replace(/'/g, '');

/** Similarity of two normalised words (1 = same, ~0.7+ = probably the same word misheard). */
function similar(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return 1 - previous[cols - 1]! / Math.max(a.length, b.length);
}

/** Lines of typed lyrics, without section labels like "[Chorus]" or "Verse 2:". */
export function lyricLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[[(].*[\])]$/.test(line) && !/^(verse|chorus|hook|bridge|intro|outro|pre-?chorus|refrain)\b[\s\d:.-]*$/i.test(line));
}

/** Typed lyrics worth aligning to: several lines and enough words to be the song, not a few samples. */
export function looksLikeFullLyrics(text: string | undefined): boolean {
  if (!text) return false;
  const lines = lyricLines(text);
  return lines.length >= 6 && lines.join(' ').split(/\s+/).length >= 40;
}

export function alignKnownLyrics(heard: TimedWord[], typed: string): TimedLine[] | null {
  const lines = lyricLines(typed);
  const known = lines.flatMap((line, index) => line.split(/\s+/).map((word) => ({ word: norm(word), line: index }))).filter((item) => item.word);
  const said = heard.map((word) => ({ ...word, n: norm(word.w) })).filter((word) => word.n);
  if (!known.length || !said.length) return null;

  // Global alignment (Needleman–Wunsch): match = similarity, gaps cost a little.
  const GAP = -0.4;
  const n = known.length;
  const m = said.length;
  const score = new Float32Array((n + 1) * (m + 1));
  const move = new Uint8Array((n + 1) * (m + 1)); // 1 diagonal, 2 up (skip typed), 3 left (skip heard)
  const at = (i: number, j: number): number => i * (m + 1) + j;
  for (let i = 1; i <= n; i += 1) {
    score[at(i, 0)] = i * GAP;
    move[at(i, 0)] = 2;
  }
  for (let j = 1; j <= m; j += 1) {
    score[at(0, j)] = j * GAP;
    move[at(0, j)] = 3;
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sim = similar(known[i - 1]!.word, said[j - 1]!.n);
      const diagonal = score[at(i - 1, j - 1)]! + (sim >= 0.6 ? sim : -0.6);
      const up = score[at(i - 1, j)]! + GAP;
      const left = score[at(i, j - 1)]! + GAP;
      const best = Math.max(diagonal, up, left);
      score[at(i, j)] = best;
      move[at(i, j)] = best === diagonal ? 1 : best === up ? 2 : 3;
    }
  }

  // Walk back: which heard word each typed word landed on.
  const matched = new Array<TimedWord | null>(n).fill(null);
  let good = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const step = move[at(i, j)];
    if (step === 1) {
      if (similar(known[i - 1]!.word, said[j - 1]!.n) >= 0.6) {
        matched[i - 1] = said[j - 1]!;
        good += 1;
      }
      i -= 1;
      j -= 1;
    } else if (step === 2) i -= 1;
    else j -= 1;
  }
  if (good / n < 0.3) return null;

  // Each typed line: from its first matched word to its last.
  const timed: (TimedLine | null)[] = lines.map((text, index) => {
    const words = known.map((item, k) => (item.line === index ? matched[k] : null)).filter((word): word is TimedWord => word !== null);
    return words.length ? { text, start: words[0]!.s, end: Math.max(words[words.length - 1]!.e, words[0]!.s + 0.3) } : null;
  });
  // Unmatched lines: spread between the neighbours that matched.
  for (let index = 0; index < timed.length; index += 1) {
    if (timed[index]) continue;
    let run = index;
    while (run < timed.length && !timed[run]) run += 1;
    const from = index > 0 ? timed[index - 1]!.end : Math.max(0, (timed[run]?.start ?? 1) - 2 * (run - index));
    const to = run < timed.length ? timed[run]!.start : from + 2.5 * (run - index);
    const span = Math.max(0.6, (to - from) / (run - index));
    for (let k = index; k < run; k += 1) timed[k] = { text: lines[k]!, start: +(from + (k - index) * span).toFixed(2), end: +(from + (k - index + 1) * span).toFixed(2) };
    index = run - 1;
  }
  // Keep lines in order and non-overlapping.
  const out = timed as TimedLine[];
  for (let index = 1; index < out.length; index += 1) {
    if (out[index]!.start < out[index - 1]!.end) out[index - 1]!.end = Math.max(out[index - 1]!.start + 0.2, out[index]!.start);
  }
  return out.map((line) => ({ text: line.text, start: +line.start.toFixed(2), end: +line.end.toFixed(2) }));
}
