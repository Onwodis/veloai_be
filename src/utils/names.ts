/**
 * Song titles and people's names are always capitalised: the first letter of
 * every word goes upper case, the rest is kept as typed ("dj tunez" → "Dj
 * Tunez", "McQueen" stays "McQueen", "don't stop" → "Don't Stop").
 * Keep in sync with fe/src/utils/names.ts.
 */
export function titleCase(value: string): string {
  return value.replace(/(^|[\s\-/(["“‘])(\p{Ll})/gu, (_match, before: string, letter: string) => `${before}${letter.toLocaleUpperCase()}`);
}
