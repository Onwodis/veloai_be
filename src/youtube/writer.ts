/**
 * The YouTube film writer: one film's script from the show (niche, kind, look, cast, length,
 * language) and what the show already published (so ideas never repeat). Returns the title,
 * description, tags, a thumbnail idea, a soundtrack cue and the scenes, each one a filmable
 * shot with its narration, held to the film length.
 */
import { z } from 'zod';
import { parse } from '../studio/director.js';
import { FILM_KINDS, MOODS, type FilmKind, type Mood } from './catalog.js';

export interface ShowCharacter {
  name: string;
  description: string;
}

export interface WriterShow {
  name: string;
  niche: string;
  filmKind: FilmKind;
  visualStyle: string;
  mood: Mood;
  format: '16:9' | '9:16';
  language: string;
  audience: string;
  notes: string;
  characters: ShowCharacter[];
}

const sceneSchema = z.object({
  seconds: z.number().int().describe('5 or 10'),
  visual: z.string().describe('One concrete, filmable shot: who, where, doing what, the light and the lens. No text, logos or captions in the picture.'),
  camera: z.string().describe('The camera move, e.g. "slow push-in", "low-angle tracking shot", "aerial descent", "handheld follow"'),
  characters: z.array(z.string()).describe('Names (from the cast) who appear in this shot; empty for none'),
  narration: z.string().describe('What the narrator says over this shot (about 2.3 words per second of the shot), or empty'),
});

export const filmScriptSchema = z.object({
  title: z.string().describe('The YouTube title: curiosity-driven, honest, at most 70 characters, no clickbait lies, no emoji'),
  description: z.string().describe('The YouTube description: 2-4 short paragraphs, then 3-5 hashtags on the last line'),
  tags: z.array(z.string()).describe('8-15 search tags'),
  thumbnail: z.object({
    prompt: z.string().describe('A striking photographic thumbnail image: one subject, big emotion or contrast, clean background, no text'),
    text: z.string().describe('2-4 punchy words to print on the thumbnail'),
  }),
  soundtrack: z.string().describe('The score in one line: instruments, tempo, how it builds'),
  scenes: z.array(sceneSchema),
});
export type FilmScript = z.infer<typeof filmScriptSchema>;
export type FilmScene = FilmScript['scenes'][number];

const SYSTEM =
  'You write cinematic films for a YouTube channel. Each film must hold attention from the first second: open on the strongest image and a hook line, ' +
  'escalate, and land a payoff or ending in the last scene. Every scene is a single filmable shot (5 or 10 seconds) described concretely so a video model can film it: ' +
  'subject, place, action, light, lens. Never ask for text, captions, logos or watermarks inside the picture. Keep named characters consistent with their descriptions. ' +
  'Narration is natural, spoken English unless another language is given, about 2.3 words per second of the scene it sits on, never longer. ' +
  'The scene seconds MUST add up to the requested length (within 5 seconds). Titles are honest: the film must deliver what the title promises. ' +
  'Never copy an existing film, show, character or brand; never depict real living people.';

/** Holds the scenes to 5 or 10 s and the total to the film length (trims or extends the last scenes). */
export function fitScenes(scenes: FilmScene[], lengthSeconds: number): FilmScene[] {
  const out = scenes.filter((scene) => scene.visual.trim()).map((scene) => ({ ...scene, seconds: scene.seconds >= 8 ? 10 : 5 }));
  let total = out.reduce((sum, scene) => sum + scene.seconds, 0);
  while (total > lengthSeconds + 4 && out.length > 1) {
    const last = out[out.length - 1]!;
    if (last.seconds === 10) {
      last.seconds = 5;
      total -= 5;
    } else {
      out.pop();
      total -= 5;
    }
  }
  for (let index = 0; total < lengthSeconds - 4 && index < out.length * 2; index += 1) {
    const scene = out[index % out.length]!;
    if (scene.seconds === 5) {
      scene.seconds = 10;
      total += 5;
    }
  }
  // Narration that can't be said in the time is cut at a sentence (or word) boundary.
  return out.map((scene) => {
    const words = scene.narration.trim().split(/\s+/).filter(Boolean);
    const max = Math.floor(scene.seconds * 2.6);
    if (words.length <= max) return scene;
    const cut = words.slice(0, max).join(' ');
    const sentence = cut.lastIndexOf('.');
    return { ...scene, narration: sentence > cut.length / 2 ? cut.slice(0, sentence + 1) : `${cut}…` };
  });
}

export async function writeFilm(input: { show: WriterShow; lengthSeconds: number; idea: string; earlierTitles: string[] }): Promise<FilmScript & { engine: string }> {
  const { show } = input;
  const kind = FILM_KINDS[show.filmKind];
  const brief = [
    `Channel / show: ${show.name}. Niche: ${show.niche}.`,
    `Kind of film: ${kind.label}. ${kind.brief}`,
    `Look: ${show.visualStyle === 'human' ? 'photoreal live action, natural light, real textures' : show.visualStyle}. Frame: ${show.format === '9:16' ? 'vertical 9:16 (YouTube Shorts)' : 'widescreen 16:9'}.`,
    `Score mood: ${MOODS[show.mood].label}.`,
    `Length: ${input.lengthSeconds} seconds in total (about ${Math.max(1, Math.round(input.lengthSeconds / 7))} scenes).`,
    `Language of the narration, title and description: ${show.language}.`,
    show.audience ? `Audience: ${show.audience}.` : '',
    show.characters.length ? `Recurring cast (keep them exactly like this):\n${show.characters.map((person) => `- ${person.name}: ${person.description}`).join('\n')}` : 'No recurring cast: invent the people this story needs, described consistently.',
    show.notes ? `The channel's own notes: ${show.notes}` : '',
    input.idea ? `This episode's idea: ${input.idea}` : 'Pick a fresh, specific idea for this episode that suits the niche and would make people click.',
    input.earlierTitles.length ? `Already made (never repeat these ideas):\n${input.earlierTitles.map((title) => `- ${title}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const { data, engine } = await parse('youtube', filmScriptSchema, SYSTEM, [{ type: 'text', text: brief }]);
  return {
    ...data,
    title: data.title.trim().slice(0, 100),
    tags: data.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 15),
    thumbnail: { prompt: data.thumbnail.prompt, text: data.thumbnail.text.trim().split(/\s+/).slice(0, 5).join(' ') },
    scenes: fitScenes(data.scenes, input.lengthSeconds),
    engine,
  };
}
