/**
 * Token economy settings (super admin editable, stored in platform_settings).
 *
 * Tokens are the prepaid unit every AI task is charged in. Task costs are
 * per unit (per source minute or per reel); a task's estimate is the sum of
 * its steps, plus a safety buffer, and must be covered (and the workspace
 * must hold at least `minimumStartBalance`) before the task may start.
 */
import { z } from 'zod';

export const TASK_STEPS = ['TRANSCRIPTION', 'HOOK_DETECTION', 'REFRAME', 'CAPTIONS', 'EXPORT', 'AI_TITLES'] as const;
export type TaskStep = (typeof TASK_STEPS)[number];

/** Which input each step is billed on. */
export const STEP_UNIT: Record<TaskStep, 'minute' | 'reel'> = {
  TRANSCRIPTION: 'minute',
  HOOK_DETECTION: 'minute',
  REFRAME: 'minute',
  CAPTIONS: 'reel',
  EXPORT: 'reel',
  AI_TITLES: 'reel',
};

export const STEP_LABEL: Record<TaskStep, string> = {
  TRANSCRIPTION: 'Transcription',
  HOOK_DETECTION: 'Hook detection',
  REFRAME: 'Smart reframe',
  CAPTIONS: 'Animated captions',
  EXPORT: 'Render & export',
  AI_TITLES: 'Titles & hashtags',
};

const packageSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,48}$/, { error: 'Package ids are lowercase letters, digits and dashes' }),
  name: z.string().trim().min(2).max(40),
  tokens: z.number().int().min(1).max(100_000_000),
  /** Price in the currency's minor unit (kobo for NGN). */
  price: z.number().int().min(100).max(1_000_000_000),
  highlighted: z.boolean().default(false),
});

export const tokenSettingsSchema = z.strictObject({
  currency: z.enum(['NGN', 'USD', 'GHS', 'ZAR', 'KES']).default('NGN'),
  paystackMode: z.enum(['TEST', 'LIVE']).default('TEST'),
  packages: z.array(packageSchema).min(1).max(12),
  taskCosts: z.strictObject(Object.fromEntries(TASK_STEPS.map((step) => [step, z.number().int().min(0).max(100_000)])) as Record<TaskStep, z.ZodNumber>),
  /** A task may only start if the workspace holds at least this many available tokens. */
  minimumStartBalance: z.number().int().min(0).max(10_000_000),
  /** Extra % reserved on top of the estimate, released on settlement. */
  reserveBufferPercent: z.number().int().min(0).max(200),
  /** Unsettled reservations expire (and are released) after this many minutes. */
  reservationTtlMinutes: z.number().int().min(5).max(24 * 60),
  /** Tokens credited to every new workspace. */
  signupBonus: z.number().int().min(0).max(1_000_000),
  /**
   * The super admin's own work: UNLIMITED (never blocked or charged) or
   * METERED (charged like any customer: every low-balance gate applies, and
   * they buy tokens the same way, to experience the product as users do).
   */
  superAdminMode: z.enum(['UNLIMITED', 'METERED']).default('UNLIMITED'),
  /**
   * Safety ceiling: tokens a workspace may commit to film-engine work (videos,
   * upscales, masters, photo shoots, likeness) per UTC day. 0 = no ceiling.
   * Stops a runaway job or a loop from draining a balance in one go.
   */
  dailyEngineCap: z.number().int().min(0).max(10_000_000).default(20_000),
  /**
   * While Paystack is in TEST mode on the live site, who may "buy" with Paystack's test cards (tokens
   * are credited for free): EVERYONE (pre-launch testing), TESTERS (the super admin + testerEmails),
   * or SUPER_ADMIN only. Ignored in LIVE mode.
   */
  testPurchases: z.enum(['EVERYONE', 'TESTERS', 'SUPER_ADMIN']).default('EVERYONE'),
  testerEmails: z.array(z.string().trim().toLowerCase().email()).max(100).default([]),
});

/** Task types that spend on the film engine (counted against dailyEngineCap). */
export const ENGINE_TASK_TYPES = ['STUDIO_TAKES', 'STUDIO_ASSEMBLY', 'MV_CHARACTER_PHOTOS', 'LIKENESS', 'MV_QUICK_CLIP', 'YOUTUBE_FILM'] as const;
/** Creations reserve as CREATE_<mode> (image, video, …): all film-engine work too. */
export const ENGINE_TASK_PREFIX = 'CREATE_';
export const isEngineTask = (taskType: string): boolean => (ENGINE_TASK_TYPES as readonly string[]).includes(taskType) || taskType.startsWith(ENGINE_TASK_PREFIX);

export type TokenSettings = z.infer<typeof tokenSettingsSchema>;
export type TokenPackage = TokenSettings['packages'][number];

export const DEFAULT_TOKEN_SETTINGS: TokenSettings = {
  currency: 'NGN',
  paystackMode: 'TEST',
  packages: [
    { id: 'starter', name: 'Starter', tokens: 1_000, price: 500_000, highlighted: false },
    { id: 'creator', name: 'Creator', tokens: 5_000, price: 2_000_000, highlighted: true },
    { id: 'studio', name: 'Studio', tokens: 20_000, price: 7_000_000, highlighted: false },
  ],
  taskCosts: { TRANSCRIPTION: 10, HOOK_DETECTION: 6, REFRAME: 8, CAPTIONS: 15, EXPORT: 5, AI_TITLES: 3 },
  minimumStartBalance: 100,
  reserveBufferPercent: 15,
  reservationTtlMinutes: 120,
  // No free tokens: every account starts at 0 and buys (owner decision, 2026-11-23).
  signupBonus: 0,
  superAdminMode: 'UNLIMITED',
  dailyEngineCap: 20_000,
  testPurchases: 'EVERYONE',
  testerEmails: [],
};

/* ------------------------------------------------------------------ estimating */

export const estimateInputSchema = z.strictObject({
  sourceMinutes: z.coerce.number().min(0.1).max(600),
  reels: z.coerce.number().int().min(1).max(100),
});
export type EstimateInput = z.infer<typeof estimateInputSchema>;

export interface EstimateLine {
  step: TaskStep;
  label: string;
  unit: 'minute' | 'reel';
  quantity: number;
  rate: number;
  tokens: number;
}

export interface Estimate {
  lines: EstimateLine[];
  subtotal: number;
  buffer: number;
  /** Tokens reserved before the task starts (subtotal + buffer). */
  reserve: number;
  /** Available tokens required to start: max(reserve, minimumStartBalance). */
  requiredToStart: number;
}

/** Quantity (minutes or reels) already charged per step, for resumed jobs. */
export type BilledSteps = Partial<Record<TaskStep, number>>;

/**
 * Estimates a task. `billed` subtracts what a resumed job has already paid
 * for, so a retry only reserves the work that is still left.
 */
export function estimateTask(settings: TokenSettings, input: EstimateInput, billed: BilledSteps = {}): Estimate {
  const minutes = Math.ceil(input.sourceMinutes);
  const lines = TASK_STEPS.map((step) => {
    const unit = STEP_UNIT[step];
    const quantity = Math.max(0, (unit === 'minute' ? minutes : input.reels) - (billed[step] ?? 0));
    const rate = settings.taskCosts[step];
    return { step, label: STEP_LABEL[step], unit, quantity, rate, tokens: quantity * rate };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.tokens, 0);
  const buffer = Math.ceil((subtotal * settings.reserveBufferPercent) / 100);
  const reserve = subtotal + buffer;
  return { lines, subtotal, buffer, reserve, requiredToStart: Math.max(reserve, settings.minimumStartBalance) };
}
