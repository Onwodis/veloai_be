/**
 * Makes one YouTube film from its script, with the platform's engines (no studio / music video
 * projects involved):
 *
 *   cast stills (once per show) → each scene: a first frame with the cast (when they appear) and
 *   the shot animated by the active video model → narration (speech engine) → soundtrack
 *   (music generator) → the cut: graded, dipped between shots, an opening title, narration over
 *   a ducked score → the thumbnail (image + the hook words) → both stored.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, mediaDuration, subtitlesFilter } from '../media/ffmpeg.js';
import { assHeader, templateStyle, textEvent, type TextStyle } from '../media/textfx.js';
import { downloadToFile, readUrl, uploadFile } from '../services/storage.service.js';
import { VISUAL_STYLES, type VisualStyle } from '../studio/cinema.js';
import * as fal from '../studio/fal.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings, type StudioModel } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { animationRequest } from '../studio/videoModels.js';
import { logger } from '../utils/logger.js';
import { MOODS, type Mood } from './catalog.js';
import { getYoutubeSettings } from './settings.js';
import type { FilmScript, ShowCharacter } from './writer.js';

export interface MakerShow {
  id: string;
  workspaceId: string;
  visualStyle: string;
  mood: Mood;
  format: '16:9' | '9:16';
  narrator: string;
  characters: (ShowCharacter & { stillKey?: string | undefined })[];
}

const FRAME = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 } } as const;
const NEGATIVE = 'text, captions, subtitles, watermark, logo, distorted faces, extra fingers, warped hands, blurry, low quality, cartoonish plastic skin, oversaturated';
const showKey = (show: MakerShow, name: string): string => `youtube/${show.workspaceId}/${show.id}/${name}`;

function look(style: string): string {
  const visual = VISUAL_STYLES[style as VisualStyle];
  return visual?.look || 'Photoreal live-action cinema: natural light, real skin and fabric texture, shallow depth of field, anamorphic feel, filmic grade.';
}

async function run(model: Pick<StudioModel, 'endpoint'>, input: Record<string, unknown>, minutes: number): Promise<unknown> {
  const handle = await fal.submit(model.endpoint, input);
  return fal.wait(handle, { timeoutMs: minutes * 60_000 });
}

function audioUrl(result: unknown): string {
  const body = result as { audio?: { url?: string }; audio_file?: { url?: string }; audio_url?: string | { url?: string }; url?: string };
  const url = body.audio?.url ?? body.audio_file?.url ?? (typeof body.audio_url === 'string' ? body.audio_url : body.audio_url?.url) ?? body.url;
  if (!url) throw new Error('The audio engine returned no audio.');
  return url;
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index]!, index);
      }
    }),
  );
  return out;
}

/** A still of every recurring character, made once per show and kept (keys saved on the show). */
async function castStills(show: MakerShow): Promise<Map<string, string>> {
  const settings = await getStudioSettings();
  const stills = new Map<string, string>();
  let changed = false;
  const dir = await mkdtemp(join(tmpdir(), 'yt-cast-'));
  try {
    for (const person of show.characters) {
      if (!person.stillKey) {
        const result = await run(settings.models.textToImage, { ...settings.models.textToImage.extra, prompt: `Character reference portrait, waist up, neutral background, even soft light. ${person.name}: ${person.description}. ${look(show.visualStyle)}`, aspect_ratio: '3:4' }, 4);
        const file = join(dir, `${stills.size}.png`);
        await downloadUrl(fal.outputUrl(result, 'image'), file);
        person.stillKey = showKey(show, `cast/${person.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.png`);
        await uploadFile(person.stillKey, file, 'image/png');
        changed = true;
      }
      stills.set(person.name.trim().toLowerCase(), person.stillKey);
    }
    if (changed) await sql`UPDATE yt_shows SET characters = ${json(show.characters)}, updated_at = now() WHERE id = ${show.id}`;
    return stills;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const pickDuration = (model: StudioModel, seconds: number): string | null => {
  if (!model.durations.length) return null;
  const wanted = String(seconds);
  if (model.durations.includes(wanted)) return wanted;
  return [...model.durations].sort((a, b) => Math.abs(Number(a) - seconds) - Math.abs(Number(b) - seconds))[0] ?? null;
};

/** One shot: a first frame with the cast when they appear, else straight from text; then animated. */
async function filmScene(show: MakerShow, scene: FilmScript['scenes'][number], stills: Map<string, string>, file: string): Promise<void> {
  const { models } = await getStudioSettings();
  const aspect = show.format;
  const prompt = `${scene.visual} Camera: ${scene.camera}. ${look(show.visualStyle)}`;
  const castKeys = scene.characters.map((name) => stills.get(name.trim().toLowerCase())).filter((key): key is string => Boolean(key));
  let imageUrl: string | null = null;
  if (castKeys.length) {
    const urls = await Promise.all(castKeys.slice(0, 3).map((key) => readUrl(key)));
    const frame = await run(models.keyframe, { ...models.keyframe.extra, prompt: `A single cinematic film frame, ${aspect === '9:16' ? 'vertical 9:16' : 'widescreen 16:9'}: ${prompt} The people are exactly the people in the reference images.`, image_urls: urls, aspect_ratio: aspect }, 4);
    imageUrl = fal.outputUrl(frame, 'image');
  }
  const model = imageUrl ? models.imageToVideo : models.textToVideo;
  const result = await run(model, animationRequest(model, { prompt, negative: NEGATIVE, duration: pickDuration(model, scene.seconds), imageUrl, aspect }), 15);
  await downloadUrl(fal.outputUrl(result, 'video'), file);
}

async function narrate(show: MakerShow, text: string, file: string): Promise<number> {
  const { models } = await getStudioSettings();
  const { voices: _voices, ...extra } = models.tts.extra as Record<string, unknown>;
  const result = await run(models.tts, { ...extra, text, voice: show.narrator }, 3);
  await downloadUrl(audioUrl(result), file);
  return mediaDuration(file);
}

async function soundtrack(show: MakerShow, cue: string, seconds: number, file: string): Promise<void> {
  const settings = await getYoutubeSettings();
  const result = await run(settings.soundtrack, { ...settings.soundtrack.extra, prompt: `${MOODS[show.mood].prompt}. ${cue}. Instrumental film score, no vocals.`, duration: Math.min(180, Math.ceil(seconds) + 2) }, 6);
  await downloadUrl(audioUrl(result), file);
}

/** The opening title (first 3.5 s) as an ASS file in the cinematic template. */
async function titleFile(dir: string, title: string, frame: { width: number; height: number }): Promise<string> {
  const style: TextStyle = { ...templateStyle('cinematic'), size: frame.width < frame.height ? 0.9 : 1.1 };
  const file = join(dir, 'title.ass');
  await writeFile(file, [...assHeader(frame, [{ name: 'Title', style }]), textEvent({ styleName: 'Title', style, text: title, start: 0.4, seconds: 3.2, frame }), ''].join('\n'), 'utf8');
  return file;
}

/** The cut (exported for the render check script). */
export async function cut(input:{ dir: string; show: MakerShow; script: FilmScript; clips: string[]; voices: (string | null)[]; music: string | null; out: string }): Promise<number> {
  const { width, height } = FRAME[input.show.format];
  const starts: number[] = [];
  let total = 0;
  for (const scene of input.script.scenes) {
    starts.push(total);
    total += scene.seconds;
  }
  const args: string[] = [];
  for (const clip of input.clips) args.push('-i', clip);
  const voiceInputs: { index: number; start: number }[] = [];
  input.voices.forEach((voice, scene) => {
    if (!voice) return;
    voiceInputs.push({ index: input.clips.length + voiceInputs.length, start: starts[scene]! + 0.3 });
    args.push('-i', voice);
  });
  const musicIndex = input.music ? input.clips.length + voiceInputs.length : -1;
  if (input.music) args.push('-stream_loop', '-1', '-i', input.music);

  const title = await titleFile(input.dir, input.script.title, { width, height });
  const dip = 0.25;
  const video = input.script.scenes.map((scene, index) => {
    const end = scene.seconds;
    return (
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,` +
      `tpad=stop_mode=clone:stop_duration=${end},trim=0:${end},setpts=PTS-STARTPTS,setsar=1,` +
      `eq=contrast=1.04:saturation=1.06,vignette=PI/5,` +
      `fade=t=in:st=0:d=${index === 0 ? 0.6 : dip},fade=t=out:st=${end - (index === input.clips.length - 1 ? 1 : dip)}:d=${index === input.clips.length - 1 ? 1 : dip}[v${index}]`
    );
  });
  const concat = `${input.clips.map((_, index) => `[v${index}]`).join('')}concat=n=${input.clips.length}:v=1:a=0[cut];[cut]${subtitlesFilter(title)},format=yuv420p[video]`;

  const audio: string[] = [];
  voiceInputs.forEach((voice, at) => audio.push(`[${voice.index}:a]aresample=48000,adelay=${Math.round(voice.start * 1000)}:all=1,volume=1.15[n${at}]`));
  const hasVoice = voiceInputs.length > 0;
  if (hasVoice) audio.push(`${voiceInputs.map((_, at) => `[n${at}]`).join('')}amix=inputs=${voiceInputs.length}:normalize=0,apad=whole_dur=${total}[voice]`);
  if (musicIndex >= 0) {
    audio.push(`[${musicIndex}:a]aresample=48000,atrim=0:${total},asetpts=PTS-STARTPTS,volume=${hasVoice ? 0.5 : 0.9},afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 2.5)}:d=2.5[music]`);
    if (hasVoice) {
      audio.push('[voice]asplit=2[voice1][key]', '[music][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]', '[ducked][voice1]amix=inputs=2:normalize=0,alimiter=limit=0.95[audio]');
    } else {
      audio.push('[music]anull[audio]');
    }
  } else if (hasVoice) {
    audio.push('[voice]alimiter=limit=0.95[audio]');
  }
  const hasAudio = hasVoice || musicIndex >= 0;
  await ffmpeg(
    [
      '-y',
      ...args,
      '-filter_complex',
      [...video, concat, ...audio].join(';'),
      '-map',
      '[video]',
      ...(hasAudio ? ['-map', '[audio]', '-c:a', 'aac', '-b:a', '192k'] : []),
      '-t',
      String(total),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '19',
      '-movflags',
      '+faststart',
      input.out,
    ],
    { signal: AbortSignal.timeout(30 * 60_000) },
  );
  return total;
}

async function thumbnail(show: MakerShow, script: FilmScript, dir: string, out: string): Promise<void> {
  const { models } = await getStudioSettings();
  const result = await run(models.textToImage, { ...models.textToImage.extra, prompt: `${script.thumbnail.prompt}. ${look(show.visualStyle)} High-contrast YouTube thumbnail composition, subject large on one side, empty space for big text on the other, no text in the image.`, aspect_ratio: '16:9' }, 4);
  const image = join(dir, 'thumb.png');
  await downloadUrl(fal.outputUrl(result, 'image'), image);
  const frame = { width: 1280, height: 720 };
  const style: TextStyle = { ...templateStyle('impact'), size: 1.5, in: 'none', out: 'none', position: 'bottom', align: 'left' };
  const ass = join(dir, 'thumb.ass');
  await writeFile(ass, [...assHeader(frame, [{ name: 'Thumb', style }]), textEvent({ styleName: 'Thumb', style, text: script.thumbnail.text.toUpperCase(), start: 0, seconds: 5, frame }), ''].join('\n'), 'utf8');
  await ffmpeg(['-y', '-i', image, '-vf', `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,${subtitlesFilter(ass)}`, '-frames:v', '1', '-q:v', '2', out]);
}

export type Progress = (percent: number, stage: string) => Promise<void>;

/** Makes the film; returns the stored video + thumbnail keys and the real length. */
export async function makeFilm(show: MakerShow, filmId: string, script: FilmScript, progress: Progress): Promise<{ videoKey: string; thumbnailKey: string; seconds: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'yt-film-'));
  try {
    await progress(3, 'Casting');
    const stills = await castStills(show);
    let done = 0;
    await progress(8, 'Filming the scenes');
    const clips = await mapLimit(script.scenes, 3, async (scene, index) => {
      const file = join(dir, `scene-${index}.mp4`);
      await filmScene(show, scene, stills, file);
      done += 1;
      await progress(8 + Math.round((done / script.scenes.length) * 62), `Filmed ${done} of ${script.scenes.length} scenes`);
      return file;
    });
    await progress(72, 'Recording the narration');
    const voices = await mapLimit(script.scenes, 3, async (scene, index) => {
      if (!scene.narration.trim()) return null;
      const file = join(dir, `voice-${index}.mp3`);
      await narrate(show, scene.narration.trim(), file);
      return file;
    });
    await progress(80, 'Scoring the soundtrack');
    const totalSeconds = script.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
    const music = join(dir, 'music.audio');
    const hasMusic = await soundtrack(show, script.soundtrack, totalSeconds, music).then(
      () => true,
      (error: unknown) => {
        // A film without a score is still a film: carry on with the narration alone.
        logger.warn({ filmId, err: (error as Error).message }, 'youtube soundtrack failed; cutting without music');
        return false;
      },
    );
    await progress(86, 'Cutting the film');
    const out = join(dir, 'film.mp4');
    const seconds = await cut({ dir, show, script, clips, voices, music: hasMusic ? music : null, out });
    await progress(93, 'Designing the thumbnail');
    const thumb = join(dir, 'thumb.jpg');
    await thumbnail(show, script, dir, thumb);
    const videoKey = showKey(show, `films/${filmId}/film-${Date.now()}.mp4`);
    const thumbnailKey = showKey(show, `films/${filmId}/thumb-${Date.now()}.jpg`);
    await uploadFile(videoKey, out, 'video/mp4');
    await uploadFile(thumbnailKey, thumb, 'image/jpeg');
    return { videoKey, thumbnailKey, seconds };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Downloads a stored film + thumbnail to a temp folder for publishing; the caller removes the folder. */
export async function fetchForUpload(videoKey: string, thumbnailKey: string | null): Promise<{ dir: string; video: string; thumb: string | null }> {
  const dir = await mkdtemp(join(tmpdir(), 'yt-up-'));
  const video = join(dir, 'film.mp4');
  await downloadToFile(videoKey, video);
  let thumb: string | null = null;
  if (thumbnailKey) {
    thumb = join(dir, 'thumb.jpg');
    await downloadToFile(thumbnailKey, thumb).catch(() => {
      thumb = null;
    });
  }
  return { dir, video, thumb };
}
