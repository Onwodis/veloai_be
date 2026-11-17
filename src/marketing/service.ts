/**
 * The super admin's marketing studio: assets that promote the platform.
 *
 *   slots       every image / video the landing page needs (from asset.md),
 *               with what has been produced for each; one click makes it with
 *               the slot's own prompt and size (no watermark: platform art).
 *   VeloBot     a planner that knows the products, the app's screens and the
 *               landing page: the admin describes what they want ("a 30 s
 *               teaser for the quick master", "a flier for Lagos creators", "a
 *               tutorial on mastering a song") and gets concrete proposals:
 *               images and videos (made by the Create pipeline), fliers (a
 *               generated background with the headline, line and call to
 *               action set over it) and tutorials (a step-by-step script of
 *               the real app screens; the admin adds a screenshot per step
 *               and the video is cut with zooms, captions and a voice-over).
 *   library     everything produced, with download links.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCreation } from '../creations/service.js';
import { canBurnSubtitles, ffmpeg, filterPath, probe } from '../media/ffmpeg.js';
import { WATERMARK_FILE, watermarkAvailable } from '../media/watermark.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { downloadToFile, headObject, presignPut, readUrl, uploadFile } from '../services/storage.service.js';
import { parse } from '../studio/director.js';
import * as fal from '../studio/fal.js';
import { downloadUrl } from '../studio/files.js';
import { getStudioSettings } from '../studio/settings.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { platformKnowledge } from './knowledge.js';
import { loadSlots, type Slot } from './slots.js';

type AssetKind = 'IMAGE' | 'VIDEO' | 'FLIER' | 'TUTORIAL';
interface TutorialStep {
  title: string;
  narration: string;
  screen: string;
  imageKey?: string | null;
}
interface AssetRow {
  id: string;
  kind: AssetKind;
  title: string;
  slotId: string | null;
  aspect: '16:9' | '9:16' | '1:1';
  prompt: string;
  creationId: string | null;
  details: { headline?: string; subline?: string; cta?: string; steps?: TutorialStep[] };
  status: 'DRAFT' | 'PRODUCING' | 'READY' | 'FAILED';
  outputKey: string | null;
  error: string | null;
  createdAt: Date;
}

const ASPECT = z.enum(['16:9', '9:16', '1:1']);
const ProposalSchema = z.object({
  reply: z.string().describe('Short, plain answer to the admin: what you recommend and why (max ~120 words)'),
  proposals: z
    .array(
      z.object({
        kind: z.enum(['IMAGE', 'VIDEO', 'FLIER', 'TUTORIAL']),
        title: z.string().describe('Short working title'),
        aspect: ASPECT,
        slotId: z.string().nullable().describe('The landing-page slot id this fills, from the slot list, or null'),
        prompt: z.string().describe('IMAGE/VIDEO/FLIER: a full photoreal generation prompt in the brand look (FLIER: the background only, with clean space for text, no text in the image). TUTORIAL: one line on what it teaches.'),
        headline: z.string().nullable().describe('FLIER only: the headline (max 7 words)'),
        subline: z.string().nullable().describe('FLIER only: one supporting line'),
        cta: z.string().nullable().describe('FLIER only: the call to action, e.g. "Start free at videosmithai.com"'),
        steps: z
          .array(z.object({ title: z.string(), screen: z.string().describe('Exactly which app screen and control to show'), narration: z.string().describe('What the voice-over says (one or two sentences)') }))
          .nullable()
          .describe('TUTORIAL only: 4–10 steps using the real screens of the app'),
      }),
    )
    .max(6),
});

const SYSTEM = (slots: Slot[]): string =>
  `You are VeloBot, the platform's creative director, planning promotional assets for the platform itself (its landing page, social posts, fliers and how-to tutorials). Recommend what will help the platform most and be concrete.\n\n${platformKnowledge()}\n\n# Landing-page asset slots (id · section · kind · spec)\n${slots
    .map((slot) => `- ${slot.id} · ${slot.page} / ${slot.section} · ${slot.kind} · ${slot.spec}`)
    .join('\n')}\n\nRules: generation prompts are photoreal and in the brand look; landing-page assets carry no text or logos; fliers get their words in headline / subline / cta (never inside the image prompt); tutorials only use screens and controls that exist in the app as described above.`;

function assetView(row: AssetRow & { creationStatus?: string | null; creationOutput?: string | null }) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    slotId: row.slotId,
    aspect: row.aspect,
    prompt: row.prompt,
    details: row.details,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Assets made through Create follow their creation (status, output). */
async function syncFromCreations(): Promise<void> {
  await sql`
    UPDATE marketing_assets a SET
      status = CASE WHEN c.status = 'READY' THEN (CASE WHEN a.kind = 'FLIER' AND a.output_key IS NULL THEN 'PRODUCING' ELSE 'READY' END)
                    WHEN c.status IN ('FAILED', 'CANCELED') THEN 'FAILED' ELSE 'PRODUCING' END,
      output_key = CASE WHEN a.kind = 'FLIER' THEN a.output_key ELSE c.output_key END,
      error = CASE WHEN c.status IN ('FAILED', 'CANCELED') THEN left(coalesce(c.error, 'The engine could not make it'), 600) ELSE NULL END,
      updated_at = now()
    FROM creations c WHERE c.id = a.creation_id AND a.status IN ('PRODUCING', 'DRAFT') AND a.kind <> 'TUTORIAL'`.catch(() => undefined);
}

export async function studio() {
  await syncFromCreations();
  const [slots, assets, messages] = await Promise.all([
    loadSlots(),
    sql<AssetRow[]>`SELECT * FROM marketing_assets ORDER BY created_at DESC LIMIT 200`,
    sql<{ id: string; role: 'ADMIN' | 'BOT'; content: string; proposals: unknown[]; createdAt: Date }[]>`SELECT * FROM marketing_messages ORDER BY created_at DESC LIMIT 40`,
  ]);
  const library = await Promise.all(
    assets.map(async (row) => ({ ...assetView(row), url: row.outputKey ? await readUrl(row.outputKey, `${row.title.slice(0, 60)}.${row.kind === 'VIDEO' || row.kind === 'TUTORIAL' ? 'mp4' : row.kind === 'FLIER' ? 'png' : 'png'}`) : null })),
  );
  return {
    slots: slots.map((slot) => {
      const made = library.find((asset) => asset.slotId === slot.id);
      return { ...slot, latest: made ? { id: made.id, status: made.status, url: made.url } : null };
    }),
    library,
    messages: messages.reverse().map((message) => ({ id: message.id, role: message.role, content: message.content, proposals: message.proposals, createdAt: message.createdAt.toISOString() })),
  };
}

/** Makes an image / video through Create (the super admin's workspace; no watermark on platform art). */
async function startCreation(auth: AuthContext, workspaceId: string, kind: 'IMAGE' | 'VIDEO', prompt: string, aspect: AssetRow['aspect'], durationSec: number | null): Promise<string> {
  const result = await createCreation(auth, workspaceId, {
    mode: kind,
    prompt,
    aspect,
    ...(kind === 'VIDEO' ? { durationSec: durationSec ?? 8 } : {}),
    upscale: kind === 'IMAGE',
    direct: false,
    dryRun: false,
    brandFree: true,
  });
  const creation = (result as { creation: { id: string } | null }).creation;
  if (!creation) throw AppError.badRequest('The creation could not start.');
  return creation.id;
}

export async function produceSlot(auth: AuthContext, workspaceId: string, slotId: string, prompt?: string) {
  const slot = (await loadSlots()).find((item) => item.id === slotId);
  if (!slot) throw AppError.notFound('Slot');
  const creationId = await startCreation(auth, workspaceId, slot.kind, prompt?.trim() || slot.prompt, slot.aspect, slot.durationSec);
  const [row] = await sql<AssetRow[]>`
    INSERT INTO marketing_assets (kind, title, slot_id, aspect, prompt, creation_id, status, created_by_id)
    VALUES (${slot.kind}, ${`${slot.section}: ${slot.path}`.slice(0, 200)}, ${slot.id}, ${slot.aspect}, ${prompt?.trim() || slot.prompt}, ${creationId}, 'PRODUCING', ${auth.userId})
    RETURNING *`;
  logger.info({ slotId, creationId }, 'marketing slot production started');
  return { asset: assetView(row!) };
}

export async function chat(auth: AuthContext, message: string) {
  const text = message.trim();
  if (text.length < 3) throw AppError.badRequest('Tell VeloBot what you need.');
  const slots = await loadSlots();
  const history = await sql<{ role: string; content: string }[]>`SELECT role, content FROM marketing_messages ORDER BY created_at DESC LIMIT 8`;
  const conversation = history
    .reverse()
    .map((entry) => `${entry.role === 'ADMIN' ? 'Admin' : 'VeloBot'}: ${entry.content}`)
    .join('\n');
  await sql`INSERT INTO marketing_messages (author_id, role, content) VALUES (${auth.userId}, 'ADMIN', ${text})`;
  const { data } = await parse('other', ProposalSchema, SYSTEM(slots), [{ type: 'text', text: `${conversation ? `Earlier:\n${conversation}\n\n` : ''}Admin: ${text}` }]);
  const proposals = data.proposals.map((proposal) => ({ ...proposal, slotId: proposal.slotId && slots.some((slot) => slot.id === proposal.slotId) ? proposal.slotId : null }));
  const [reply] = await sql<{ id: string }[]>`INSERT INTO marketing_messages (role, content, proposals) VALUES ('BOT', ${data.reply}, ${json(proposals)}) RETURNING id`;
  return { message: { id: reply!.id, role: 'BOT' as const, content: data.reply, proposals } };
}

export async function produceProposal(auth: AuthContext, workspaceId: string, messageId: string, index: number) {
  const [message] = await sql<{ proposals: z.infer<typeof ProposalSchema>['proposals'] }[]>`SELECT proposals FROM marketing_messages WHERE id = ${messageId} AND role = 'BOT'`;
  const proposal = message?.proposals[index];
  if (!proposal) throw AppError.notFound('Proposal');
  const slot = proposal.slotId ? (await loadSlots()).find((item) => item.id === proposal.slotId) : undefined;
  if (proposal.kind === 'TUTORIAL') {
    const steps = (proposal.steps ?? []).slice(0, 12).map((step) => ({ ...step, imageKey: null }));
    if (steps.length < 2) throw AppError.badRequest('This tutorial has no steps. Ask VeloBot again.');
    const [row] = await sql<AssetRow[]>`
      INSERT INTO marketing_assets (kind, title, aspect, prompt, details, status, message_id, created_by_id)
      VALUES ('TUTORIAL', ${proposal.title.slice(0, 200)}, ${proposal.aspect}, ${proposal.prompt}, ${json({ steps })}, 'DRAFT', ${messageId}, ${auth.userId}) RETURNING *`;
    return { asset: assetView(row!) };
  }
  const kind = proposal.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE';
  const creationId = await startCreation(auth, workspaceId, kind, proposal.prompt, proposal.aspect, slot?.durationSec ?? 8);
  const details = proposal.kind === 'FLIER' ? { headline: proposal.headline ?? proposal.title, subline: proposal.subline ?? '', cta: proposal.cta ?? '' } : {};
  const [row] = await sql<AssetRow[]>`
    INSERT INTO marketing_assets (kind, title, slot_id, aspect, prompt, creation_id, details, status, message_id, created_by_id)
    VALUES (${proposal.kind}, ${proposal.title.slice(0, 200)}, ${proposal.slotId}, ${proposal.aspect}, ${proposal.prompt}, ${creationId}, ${json(details)}, 'PRODUCING', ${messageId}, ${auth.userId}) RETURNING *`;
  return { asset: assetView(row!) };
}

async function loadAsset(assetId: string): Promise<AssetRow> {
  const [row] = await sql<AssetRow[]>`SELECT * FROM marketing_assets WHERE id = ${assetId}`;
  if (!row) throw AppError.notFound('Asset');
  return row;
}

const SIZES = { '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1440, height: 1440 } } as const;
const assEscape = (value: string): string => value.replace(/[{}\\]/g, '').replace(/\n/g, ' ');

/** Fliers: the generated background with the headline, line and call to action set over it, plus the logo. */
export async function composeFlier(assetId: string) {
  await syncFromCreations();
  const row = await loadAsset(assetId);
  if (row.kind !== 'FLIER') throw AppError.badRequest('Only fliers are composed.');
  const [creation] = row.creationId ? await sql<{ status: string; outputKey: string | null }[]>`SELECT status, output_key FROM creations WHERE id = ${row.creationId}` : [];
  if (creation?.status !== 'READY' || !creation.outputKey) throw AppError.conflict('The background is still being made. Try again in a moment.');
  const { width, height } = SIZES[row.aspect];
  const dir = await mkdtemp(join(tmpdir(), 'flier-'));
  try {
    const background = join(dir, 'background');
    await downloadToFile(creation.outputKey, background);
    const ass = join(dir, 'text.ass');
    const big = Math.round(height / 12);
    const mid = Math.round(height / 30);
    const margin = Math.round(width * 0.07);
    await writeFile(
      ass,
      `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
        `Style: H,Arial,${big},&H00FFFFFF,&H00FFFFFF,&H80000000,&H00000000,1,0,0,0,100,100,0,0,1,0,3,1,${margin},${margin},${Math.round(height * 0.3)},1\n` +
        `Style: S,Arial,${mid},&H00E6E6E6,&H00FFFFFF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,0,2,1,${margin},${margin},${Math.round(height * 0.22)},1\n` +
        `Style: C,Arial,${mid},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00F65C8B,1,0,0,0,100,100,0,0,3,${Math.round(mid / 2.5)},0,1,${margin},${margin},${Math.round(height * 0.1)},1\n\n` +
        `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
        `Dialogue: 0,0:00:00.00,0:00:05.00,H,,0,0,0,,${assEscape(row.details.headline ?? row.title)}\n` +
        (row.details.subline ? `Dialogue: 0,0:00:00.00,0:00:05.00,S,,0,0,0,,${assEscape(row.details.subline)}\n` : '') +
        (row.details.cta ? `Dialogue: 0,0:00:00.00,0:00:05.00,C,,0,0,0,,${assEscape(row.details.cta)}\n` : ''),
      'utf8',
    );
    if (!(await canBurnSubtitles(ass).catch(() => false))) throw new AppError(503, 'INTERNAL_ERROR', "This server's ffmpeg cannot draw text (no libass).");
    const out = join(dir, 'flier.png');
    const logo = await watermarkAvailable();
    const shade = `drawbox=x=0:y=ih*0.45:w=iw:h=ih*0.55:color=black@0.45:t=fill`;
    const graph = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${shade},subtitles=${filterPath(ass)}[t]` + (logo ? `;[1:v]scale=${Math.round(width * 0.24)}:-1[l];[t][l]overlay=x=${margin}:y=${margin}[o]` : '');
    await ffmpeg(['-i', background, ...(logo ? ['-i', WATERMARK_FILE] : []), '-filter_complex', graph, '-map', logo ? '[o]' : '[t]', '-frames:v', '1', out]);
    const key = `marketing/fliers/${row.id}-${randomBytes(4).toString('hex')}.png`;
    await uploadFile(key, out, 'image/png');
    await sql`UPDATE marketing_assets SET output_key = ${key}, status = 'READY', error = NULL, updated_at = now() WHERE id = ${row.id}`;
    return { asset: assetView({ ...row, outputKey: key, status: 'READY' }) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ tutorials */

/** A one-off upload URL for the screenshot of one tutorial step. */
export async function stepUploadUrl(assetId: string, step: number, contentType: string) {
  const row = await loadAsset(assetId);
  if (row.kind !== 'TUTORIAL') throw AppError.badRequest('Screenshots belong to tutorials.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) throw AppError.badRequest('Upload a PNG, JPEG or WebP screenshot.');
  if (!row.details.steps?.[step]) throw AppError.notFound('Step');
  const key = `marketing/tutorials/${row.id}/step-${step}-${randomBytes(4).toString('hex')}.${contentType.split('/')[1]}`;
  return { key, url: await presignPut(key, contentType, 15 * 1024 * 1024) };
}

export async function setStepImage(assetId: string, step: number, key: string) {
  const row = await loadAsset(assetId);
  if (!key.startsWith(`marketing/tutorials/${row.id}/step-${step}-`) || !(await headObject(key))) throw AppError.badRequest('That upload did not finish. Try again.');
  const steps = [...(row.details.steps ?? [])];
  if (!steps[step]) throw AppError.notFound('Step');
  steps[step] = { ...steps[step]!, imageKey: key };
  await sql`UPDATE marketing_assets SET details = ${json({ ...row.details, steps })}, updated_at = now() WHERE id = ${row.id}`;
  return { asset: assetView({ ...row, details: { ...row.details, steps } }) };
}

export async function renderTutorial(assetId: string) {
  const row = await loadAsset(assetId);
  const missing = (row.details.steps ?? []).map((step, index) => (step.imageKey ? null : index + 1)).filter((value) => value !== null);
  if (row.kind !== 'TUTORIAL') throw AppError.badRequest('Only tutorials render here.');
  if (missing.length) throw AppError.badRequest(`Add a screenshot for step ${missing.join(', ')} first.`);
  await sql`UPDATE marketing_assets SET status = 'PRODUCING', error = NULL, updated_at = now() WHERE id = ${row.id}`;
  const { enqueueTutorial } = await import('../studio/queue.js');
  await enqueueTutorial(row.id);
  return { asset: assetView({ ...row, status: 'PRODUCING' }) };
}

/**
 * Worker job: each step is its screenshot with a slow push-in, the step title
 * and narration as captions, and the narration spoken (when the voice engine
 * is on; otherwise a timed caption). Steps cross-fade; a branded end card
 * closes it.
 */
export async function runTutorial(assetId: string): Promise<void> {
  const row = await loadAsset(assetId);
  if (row.status !== 'PRODUCING') return;
  const { width, height } = SIZES[row.aspect];
  const dir = await mkdtemp(join(tmpdir(), 'tutorial-'));
  try {
    const settings = await getStudioSettings();
    const voiceOn = fal.falConfigured() && settings.models.tts.enabled;
    const { voices: _voices, ...ttsExtra } = settings.models.tts.extra as Record<string, unknown>;
    const segments: string[] = [];
    for (const [index, step] of (row.details.steps ?? []).entries()) {
      const shot = join(dir, `shot-${index}`);
      await downloadToFile(step.imageKey!, shot);
      let voice: string | null = null;
      let seconds = Math.max(3.5, Math.min(9, step.narration.split(/\s+/).length / 2.6 + 1.2));
      if (voiceOn) {
        try {
          const handle = await fal.submit(settings.models.tts.endpoint, { ...ttsExtra, text: step.narration });
          const result = await fal.wait<Record<string, unknown>>(handle, { timeoutMs: 3 * 60_000 });
          const body = result as { audio?: { url?: string }; audio_url?: string | { url?: string }; url?: string };
          const url = body.audio?.url ?? (typeof body.audio_url === 'string' ? body.audio_url : body.audio_url?.url) ?? body.url;
          if (url) {
            voice = join(dir, `voice-${index}.mp3`);
            await downloadUrl(url, voice);
            seconds = Math.max(seconds, (await probe(voice)).durationSec + 0.8);
          }
        } catch (error) {
          logger.warn({ err: error, assetId, step: index }, 'tutorial voice failed; captions only');
        }
      }
      const ass = join(dir, `caption-${index}.ass`);
      const titleSize = Math.round(height / 22);
      const bodySize = Math.round(height / 34);
      const end = `0:00:${seconds.toFixed(2).padStart(5, '0')}`;
      await writeFile(
        ass,
        `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
          `Style: T,Arial,${titleSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,1,0,0,0,100,100,0,0,3,${Math.round(titleSize / 3)},0,7,40,40,40,1\n` +
          `Style: B,Arial,${bodySize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,0,0,0,0,100,100,0,0,3,${Math.round(bodySize / 3)},0,2,60,60,50,1\n\n` +
          `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
          `Dialogue: 0,0:00:00.20,${end},T,,0,0,0,,Step ${index + 1} · ${assEscape(step.title)}\n` +
          `Dialogue: 0,0:00:00.40,${end},B,,0,0,0,,${assEscape(step.narration)}\n`,
        'utf8',
      );
      const frames = Math.round(seconds * 30);
      const segment = join(dir, `segment-${index}.mp4`);
      // Slow push-in towards the centre, like a screen-recording zoom.
      const zoom = `zoompan=z='min(1+0.10*on/${frames},1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=30`;
      const video = `[0:v]scale=${width * 2}:${height * 2}:force_original_aspect_ratio=decrease,pad=${width * 2}:${height * 2}:(ow-iw)/2:(oh-ih)/2:color=0x0b0b14,${zoom},subtitles=${filterPath(ass)},format=yuv420p[v]`;
      const audio = voice ? `;[1:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${seconds.toFixed(3)}[a]` : `;anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${seconds.toFixed(3)}[a]`;
      await ffmpeg(['-loop', '1', '-i', shot, ...(voice ? ['-i', voice] : []), '-filter_complex', video + audio, '-map', '[v]', '-map', '[a]', '-t', seconds.toFixed(3), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', segment]);
      segments.push(segment);
    }
    // End card: the logo on black with the site name.
    const card = join(dir, 'card.mp4');
    const logo = await watermarkAvailable();
    await ffmpeg([
      '-f', 'lavfi', '-t', '3', '-i', `color=c=0x0b0b14:s=${width}x${height}:r=30`,
      ...(logo ? ['-i', WATERMARK_FILE] : []),
      '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', logo ? `[1:v]scale=${Math.round(width * 0.45)}:-1[l];[0:v][l]overlay=(W-w)/2:(H-h)/2,fade=t=in:d=0.6,format=yuv420p[v]` : '[0:v]format=yuv420p[v]',
      '-map', '[v]', '-map', `${logo ? 2 : 1}:a`, '-t', '3', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', card,
    ]);
    segments.push(card);
    const list = join(dir, 'list.txt');
    await writeFile(list, segments.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const out = join(dir, 'tutorial.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-af', 'loudnorm=I=-16:TP=-1.5', '-movflags', '+faststart', out]);
    const key = `marketing/tutorials/${row.id}/tutorial-${randomBytes(4).toString('hex')}.mp4`;
    await uploadFile(key, out, 'video/mp4');
    await sql`UPDATE marketing_assets SET status = 'READY', output_key = ${key}, error = NULL, updated_at = now() WHERE id = ${row.id}`;
    logger.info({ assetId, steps: segments.length - 1 }, 'tutorial rendered');
  } catch (error) {
    logger.error({ err: error, assetId }, 'tutorial render failed');
    await sql`UPDATE marketing_assets SET status = 'FAILED', error = ${(error as Error).message.slice(0, 600)}, updated_at = now() WHERE id = ${row.id}`.catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
