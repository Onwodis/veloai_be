/**
 * Environment configuration.
 *
 * Every variable the service reads is declared and validated here, once, at
 * boot. If anything is missing or malformed the process exits before it can
 * accept traffic, so the rest of the codebase can treat `env` as fully typed
 * and trustworthy.
 */
import 'dotenv/config';
import { z } from 'zod';

/** Parses "a,b,c" into a trimmed, non-empty string array. */
const commaList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

/** Accepts the usual boolean spellings found in .env files. */
const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/** JWT secrets must carry at least 256 bits of entropy for HS256. */
const jwtSecret = z
  .string()
  .min(64, 'JWT secrets must be at least 64 characters (use `openssl rand -hex 48`)');

/** "Veloai Studio" → "veloai-studio". Used for cookie names, key prefixes, JWT iss/aud. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const envSchema = z
  .object({
    /** Product name. The single source for every user-facing and derived name. */
    APP_NAME: z.string().trim().min(1).max(60),
    /** The AI director / AI capability's name (user-facing + how the LLM introduces itself). */
    BOT_NAME: z.string().trim().min(1).max(40).default('VeloBot'),
    /** What users see for the video/audio models (never the provider or model names). */
    ENGINE_NAME: z.string().trim().min(1).max(60).default('Velo film engine'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** Number of reverse-proxy hops to trust for client IP resolution. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    /** Exact origins allowed to call the API with credentials. */
    CORS_ORIGINS: commaList.pipe(z.array(z.url()).min(1)),

    JWT_ACCESS_SECRET: jwtSecret,
    JWT_REFRESH_SECRET: jwtSecret,
    /** Defaults to `<app-slug>-api` / `<app-slug>-web`. */
    JWT_ISSUER: z.string().min(1).optional(),
    JWT_AUDIENCE: z.string().min(1).optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60),

    /** Refresh cookie `Secure` flag. Only disable for plain-HTTP non-localhost dev hosts. */
    COOKIE_SECURE: booleanish.default(true),
    /** Optional cookie Domain attribute; omit to bind the cookie to the API host. */
    COOKIE_DOMAIN: z.string().min(1).optional(),

    /** Failed logins before an account is temporarily locked. */
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).default(8),
    LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().min(60).default(15 * 60),

    /**
     * Online payment provider for paid plan checkout. `none` keeps the billing
     * page fully readable while paid upgrades answer PAYMENTS_UNAVAILABLE
     * (platform admins can still assign plans directly).
     */
    BILLING_PROVIDER: z.enum(['none']).default('none'),

    /**
     * Paystack secret keys for token purchases. The super admin chooses the
     * active mode (test/live) in the dashboard; each needs its own key.
     */
    // Also accepted as PAYSTACK_TEST_SK / PAYSTACK_LIVE_SK. A value of the
    // wrong kind (e.g. a pk_ public key) is ignored with a boot warning.
    PAYSTACK_TEST_SECRET_KEY: z.string().optional(),
    PAYSTACK_LIVE_SECRET_KEY: z.string().optional(),
    PAYSTACK_TEST_SK: z.string().optional(),
    PAYSTACK_LIVE_SK: z.string().optional(),

    /** Cloudflare R2 (S3-compatible) for uploads and rendered reels. */
    CF_R2_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/, 'CF_R2_ACCOUNT_ID must be the 32-character account id').optional(),
    CF_R2_ACCESS_KEY_ID: z.string().min(16).optional(),
    CF_R2_SECRET_ACCESS_KEY: z.string().min(32).optional(),
    CF_R2_BUCKET_NAME: z.string().min(3).max(63).optional(),
    /** Public bucket URL (r2.dev or a custom domain) used for previews. Private signed URLs are used when unset. */
    CF_R2_PUBLIC_URL: z.url().optional(),
    /**
     * Upload relay (default on): browser uploads go to this API, which streams
     * them into R2, so no bucket CORS rule is needed. Set false to upload
     * straight to R2 once the bucket CORS rule is in place (less API traffic).
     */
    UPLOAD_RELAY: booleanish.default(true),
    /** Public base URL of this API (relay links). Default http://localhost:<PORT>. */
    API_PUBLIC_URL: z.url().optional(),

    /**
     * Transcription engine: any OpenAI-compatible /audio/transcriptions API
     * with word timestamps (OpenAI Whisper, Groq Whisper, …).
     */
    TRANSCRIPTION_API_URL: z.url().default('https://api.openai.com/v1'),
    TRANSCRIPTION_API_KEY: z.string().min(10).optional(),
    TRANSCRIPTION_MODEL: z.string().min(2).default('whisper-1'),

    /** OpenAI key: used for transcription when TRANSCRIPTION_API_KEY is unset, and selectable for hooks. */
    OPENAI_API_KEY: z.string().min(10).optional(),

    /** Claude (hook detection, titles). The SDK also reads ANTHROPIC_API_KEY itself. */
    ANTHROPIC_API_KEY: z.string().min(10).optional(),
    CLAUDE_MODEL: z.string().min(5).default('claude-opus-5-5'),

    /**
     * fal.ai key for the AI video studio (keyframes, image-to-video, lip
     * sync, upscaling). Models are chosen by the super admin per stage.
     */
    FAL_KEY: z.string().min(10).optional(),
    /**
     * Non-pooled Neon URL for schema migrations (`pnpm studio:migrate`).
     * Defaults to DATABASE_URL with the `-pooler` host suffix removed.
     */
    DIRECT_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),

    /** Run the media worker inside the API process (simplest for local dev). */
    MEDIA_WORKER_INLINE: booleanish.default(true),
    MEDIA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),

    /** Public web origin used in emailed links. Defaults to the first CORS origin. */
    WEB_APP_URL: z.url().optional(),

    /**
     * 32-byte key (64 hex chars) for encrypting TOTP secrets and SMTP
     * passwords at rest. Required in production. In development a key is
     * derived from JWT_ACCESS_SECRET so the app boots without it.
     */
    DATA_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'DATA_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)')
      .optional(),
    /**
     * The key being rotated away from. Secrets encrypted with it still
     * decrypt until `pnpm secrets:rotate` re-encrypts them; then remove it.
     */
    DATA_ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'DATA_ENCRYPTION_KEY_PREVIOUS must be 64 hex characters')
      .optional(),

    /**
     * Super admin seeded on boot and by `pnpm db:seed`. The password is not
     * held to the user policy (it is operator-chosen); a weak one is logged.
     */
    ADMIN_EMAIL: z.email().optional(),
    ADMIN_PASSWORD: z.string().min(1).max(128).optional(),
    ADMIN_NAME: z.string().trim().min(2).max(80).optional(),
    /** Super admin's real name (the overview greets by last name). Names as the user wrote them in .env. */
    First_name: z.string().trim().min(1).max(40).optional(),
    Last_name: z.string().trim().min(1).max(40).optional(),
    ADMIN_GENDER: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']).default('MALE'),

    /** Default SMTP account, mirrored into the dashboard's credential list. */
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_SECURE: booleanish.optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(3).optional(),
    /** Alias for SMTP_FROM. */
    SMTP_FROM_EMAIL: z.string().min(3).optional(),
    SMTP_FROM_NAME: z.string().min(1).max(80).optional(),
  })
  .refine((cfg) => cfg.NODE_ENV !== 'production' || cfg.DATA_ENCRYPTION_KEY !== undefined, {
    message: 'DATA_ENCRYPTION_KEY is required in production',
    path: ['DATA_ENCRYPTION_KEY'],
  })
  .refine((cfg) => cfg.JWT_ACCESS_SECRET !== cfg.JWT_REFRESH_SECRET, {
    message: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ',
    path: ['JWT_REFRESH_SECRET'],
  })
  .refine((cfg) => slugify(cfg.APP_NAME).length > 0, {
    message: 'APP_NAME must contain at least one letter or digit',
    path: ['APP_NAME'],
  })
  .transform((cfg) => {
    const APP_SLUG = slugify(cfg.APP_NAME);
    const CONFIG_WARNINGS: string[] = [];
    const paystackKey = (value: string | undefined, prefix: string, name: string): string | undefined => {
      if (!value) return undefined;
      if (value.startsWith(prefix)) return value;
      CONFIG_WARNINGS.push(`${name} does not start with ${prefix} (a ${value.slice(0, 8)}… key was given); Paystack ${prefix.includes('live') ? 'live' : 'test'} mode is disabled until the secret key is set.`);
      return undefined;
    };
    return {
      ...cfg,
      APP_SLUG,
      CONFIG_WARNINGS,
      PAYSTACK_TEST_SECRET_KEY: paystackKey(cfg.PAYSTACK_TEST_SECRET_KEY ?? cfg.PAYSTACK_TEST_SK, 'sk_test_', 'PAYSTACK_TEST_SK'),
      PAYSTACK_LIVE_SECRET_KEY: paystackKey(cfg.PAYSTACK_LIVE_SECRET_KEY ?? cfg.PAYSTACK_LIVE_SK, 'sk_live_', 'PAYSTACK_LIVE_SK'),
      SMTP_FROM: cfg.SMTP_FROM ?? cfg.SMTP_FROM_EMAIL,
      R2_ENABLED: Boolean(cfg.CF_R2_ACCOUNT_ID && cfg.CF_R2_ACCESS_KEY_ID && cfg.CF_R2_SECRET_ACCESS_KEY && cfg.CF_R2_BUCKET_NAME),
      JWT_ISSUER: cfg.JWT_ISSUER ?? `${APP_SLUG}-api`,
      JWT_AUDIENCE: cfg.JWT_AUDIENCE ?? `${APP_SLUG}-web`,
      WEB_APP_URL: (cfg.WEB_APP_URL ?? cfg.CORS_ORIGINS[0] ?? 'http://localhost:3000').replace(/\/+$/, ''),
    };
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // The logger depends on env, so validation failures go straight to stderr.
    process.stderr.write(
      `Invalid environment configuration:\n${z.prettifyError(parsed.error)}\n`,
    );
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
