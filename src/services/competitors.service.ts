/**
 * Competitor comparison (super admin, internal): a feature matrix of the
 * platform against the kinds of products people compare it with, plus
 * positioning notes. Stored in platform_settings('competitors'), fully
 * editable in the console.
 *
 * The defaults compare product CATEGORIES (with example names), at a typical
 * level, as a starting point: they are marked "verify before publishing" and
 * are not claims about any single company's current product.
 */
import { z } from 'zod';
import { json, sql } from '../studio/sql.js';

const mark = z.enum(['YES', 'PARTIAL', 'NO', 'UNKNOWN']);
export type Mark = z.infer<typeof mark>;

export const competitorsSchema = z.strictObject({
  columns: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().trim().min(2).max(60), examples: z.string().trim().max(160), note: z.string().trim().max(400) })).max(10),
  rows: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]{2,60}$/),
        group: z.string().trim().min(2).max(40),
        feature: z.string().trim().min(2).max(120),
        ours: mark,
        values: z.record(z.string(), mark),
      }),
    )
    .max(80),
  positioning: z.array(z.string().trim().min(3).max(400)).max(20),
  verifiedAt: z.string().nullable(),
});
export type Competitors = z.infer<typeof competitorsSchema>;

const COLUMNS: Competitors['columns'] = [
  { id: 'ai-video', name: 'AI video generators', examples: 'e.g. Runway, Pika, Kling, Luma', note: 'Prompt → clip tools. Strong raw generation; you assemble the production yourself.' },
  { id: 'clippers', name: 'Reel clippers', examples: 'e.g. OpusClip, Vizard', note: 'Long video → short clips with captions. No original footage.' },
  { id: 'avatars', name: 'Avatar & presenter tools', examples: 'e.g. Synthesia, HeyGen', note: 'Talking presenters and voice for training / marketing. Not music.' },
  { id: 'editors', name: 'Video editors', examples: 'e.g. CapCut, Premiere', note: 'You edit footage you already have; some AI helpers.' },
];

type Row = [id: string, group: string, feature: string, ours: Mark, aiVideo: Mark, clippers: Mark, avatars: Mark, editors: Mark];
const ROWS: Row[] = [
  ['text-to-video', 'Generation', 'Generate scenes from a written prompt', 'YES', 'YES', 'NO', 'PARTIAL', 'PARTIAL'],
  ['character-consistency', 'Generation', 'Same cast across every scene (from their photos)', 'YES', 'PARTIAL', 'NO', 'YES', 'NO'],
  ['lip-sync', 'Generation', 'Lip sync to a song (sung lines only, soft lines gentle)', 'YES', 'PARTIAL', 'NO', 'PARTIAL', 'NO'],
  ['performance-moves', 'Generation', 'Library of ~1,000 performance moves + VeloBot suggestions', 'YES', 'NO', 'NO', 'NO', 'NO'],
  ['music-video-workflow', 'Productions', 'Full music-video production (song → cast → scenes → storyboard → shoot → master)', 'YES', 'NO', 'NO', 'NO', 'PARTIAL'],
  ['commercials', 'Productions', 'Commercials studio (brief → director → script → shoot → master, ≤ 60 s)', 'YES', 'NO', 'NO', 'PARTIAL', 'NO'],
  ['voices', 'Productions', 'Spoken lines in each character’s voice (TTS) mixed at their scenes', 'YES', 'NO', 'NO', 'YES', 'PARTIAL'],
  ['reels', 'Productions', 'Reels from long videos (hooks, reframe, captions)', 'YES', 'NO', 'YES', 'NO', 'PARTIAL'],
  ['ai-director', 'Direction', 'An AI director you talk to, who writes and reviews every shot', 'YES', 'NO', 'NO', 'PARTIAL', 'NO'],
  ['shot-review', 'Direction', 'Automatic review of every shot with fixes (weak, off-brief, “looks AI”)', 'YES', 'NO', 'NO', 'NO', 'NO'],
  ['mastering', 'Finishing', 'Audio mastering desk + AI master with scores', 'YES', 'NO', 'NO', 'NO', 'PARTIAL'],
  ['end-card', 'Finishing', 'Ad end card (logo + call to action) and platform versions from one master', 'YES', 'NO', 'PARTIAL', 'PARTIAL', 'PARTIAL'],
  ['price-first', 'Money', 'Every paid step shows its price before it starts; pause / cancel stops spending', 'YES', 'PARTIAL', 'PARTIAL', 'PARTIAL', 'UNKNOWN'],
  ['local-payments', 'Money', 'Local payments (Paystack, naira)', 'YES', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
  ['share-links', 'Collaboration', 'Encrypted, expiring view-only / download links', 'YES', 'PARTIAL', 'PARTIAL', 'PARTIAL', 'PARTIAL'],
  ['contributions', 'Collaboration', 'Push / review / revert checkpoints for teams', 'YES', 'NO', 'NO', 'PARTIAL', 'PARTIAL'],
];

export const DEFAULT_COMPETITORS: Competitors = {
  columns: COLUMNS,
  rows: ROWS.map(([id, group, feature, ours, aiVideo, clippers, avatars, editors]) => ({ id, group, feature, ours, values: { 'ai-video': aiVideo, clippers, avatars, editors } })),
  positioning: [
    'Not a clip generator: a production studio. The director, the stages and the approvals turn clips into a finished music video or ad.',
    'Built for African music and business first: Afrobeats / Amapiano-aware direction, local payments, naira pricing.',
    'Real-life look by default (natural light, real skin, subtle camera), never the glossy "AI" look.',
    'You never pay twice and never pay blind: prices before every paid step, pause stops spending, retries reuse what was paid for.',
  ],
  verifiedAt: null,
};

export async function getCompetitors(): Promise<Competitors> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'competitors'`.catch(() => []);
  const parsed = competitorsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_COMPETITORS;
}

export async function saveCompetitors(input: Competitors, actorId: string): Promise<Competitors> {
  const value = competitorsSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('competitors', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  return value;
}
