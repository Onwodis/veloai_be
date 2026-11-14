/**
 * Weaves a scene's moves into its shot prompt as performance direction, framed
 * so the film engine plays them like a person, not a routine: loose timing,
 * weight shifts, breath, nothing mirrored or perfectly on the beat. The base
 * prompt is shortened if needed so the direction is never cut off.
 */
import type { SceneMove } from './types.js';

const MAX_PROMPT = 2000;

export function performanceDirection(moves: SceneMove[] | null | undefined): string {
  if (!moves?.length) return '';
  const byCharacter = new Map<string, string[]>();
  for (const move of moves) byCharacter.set(move.characterName, [...(byCharacter.get(move.characterName) ?? []), move.cue.replace(/[.\s]+$/, '')]);
  const lines = [...byCharacter.entries()].map(([name, cues]) => `${name} ${cues.join(', and later ')}`);
  return (
    `Performance direction: ${lines.join('; ')}. ` +
    'Played like a real person, never robotic: loose and slightly imperfect, natural weight shifts and breath, timing a hair behind the beat, nothing mirrored or perfectly symmetrical, and the move grows out of the feeling of the line.'
  );
}

export function withMoves(prompt: string, moves: SceneMove[] | null | undefined): string {
  const direction = performanceDirection(moves);
  if (!direction) return prompt;
  const room = Math.max(200, MAX_PROMPT - direction.length - 2);
  const base = prompt.trim().slice(0, room).trim();
  return `${base}${/[.!?]$/.test(base) ? '' : '.'} ${direction}`;
}
