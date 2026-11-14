/**
 * Commercials studio: request schemas and the shapes stored in jsonb.
 * Ads never run longer than 60 seconds (MAX_AD_SECONDS), enforced everywhere.
 */
import { z } from 'zod';
import { categorySchema } from '../config/categories.js';

export const MAX_AD_SECONDS = 60;
export const AD_STAGES = ['BRIEF', 'CHARACTERS', 'DIRECTOR', 'SCRIPT', 'SHOOT', 'MASTER'] as const;
export type AdStage = (typeof AD_STAGES)[number];
export const AD_OBJECTIVES = ['AWARENESS', 'LAUNCH', 'SALES', 'APP_INSTALL', 'EVENT', 'RECRUITMENT'] as const;
export const AD_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK', 'LINKEDIN', 'TV', 'WEB'] as const;

const text = (max: number) => z.string().trim().max(max);

export const companySchema = z.strictObject({
  name: text(120).min(2),
  legalName: text(200).optional(),
  registrationNo: text(60).optional(),
  country: z.string().trim().regex(/^[A-Z]{2}$/).optional(),
  industry: text(80).optional(),
  website: z.union([z.url().max(300), z.literal('')]).optional(),
  description: text(2000).optional(),
  tone: text(300).optional(),
  brandColours: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).optional(),
});
export type CompanyInput = z.infer<typeof companySchema>;

export const memberSchema = z.strictObject({ email: z.email().max(200), role: z.enum(['EDITOR', 'VIEWER']).default('EDITOR') });

export const audienceSchema = z.strictObject({
  ageRange: text(40).optional(),
  gender: text(40).optional(),
  locations: text(200).optional(),
  interests: text(300).optional(),
  income: text(60).optional(),
});

export const productSchema = z.strictObject({
  name: text(120).min(2),
  category: text(80).optional(),
  description: text(4000).optional(),
  price: text(60).optional(),
  usps: z.array(text(200).min(1)).max(8).optional(),
  audience: audienceSchema.optional(),
});
export type ProductInput = z.infer<typeof productSchema>;

export const productAssetSchema = z.strictObject({
  kind: z.enum(['PHOTO', 'LOGO', 'PACKSHOT', 'VIDEO']),
  fileName: text(200).min(1),
  contentType: z.string().regex(/^(image\/(jpeg|png|webp)|video\/(mp4|quicktime|webm))$/),
  size: z.number().int().min(1).max(500 * 1024 * 1024),
});

/** A default cast member every scene can use (voice = text-to-speech per character). */
export const adCharacterSchema = z.strictObject({
  name: text(60).min(1),
  role: text(80).optional(),
  age: text(30).optional(),
  gender: text(30).optional(),
  look: text(400).optional(),
  voice: z.strictObject({ language: text(40).optional(), accent: text(60).optional(), tone: text(80).optional() }).optional(),
});

/** The general rules every scene inherits (each scene may override them later). */
export const adRulesSchema = z.strictObject({
  environment: text(300).optional(),
  location: text(200).optional(),
  country: text(80).optional(),
  castEthnicity: text(120).optional(),
  language: text(60).optional(),
  accent: text(80).optional(),
  education: text(120).optional(),
  composure: text(120).optional(),
  costume: text(300).optional(),
  dressSense: text(200).optional(),
  music: text(200).optional(),
  characters: z.array(adCharacterSchema).max(6).optional(),
});
export type AdRules = z.infer<typeof adRulesSchema>;

export const createAdSchema = z.strictObject({
  title: text(120).min(2),
  aspect: z.enum(['16:9', '9:16', '1:1']).default('9:16'),
  /** Industry focus (required at creation). */
  category: categorySchema,
});

export const briefSchema = z.strictObject({
  title: text(120).min(2).optional(),
  aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
  objective: z.enum(AD_OBJECTIVES).optional(),
  platform: z.enum(AD_PLATFORMS).optional(),
  lengthSec: z.number().int().min(6).max(MAX_AD_SECONDS).optional(),
  goal: text(2000).optional(),
  callToAction: text(160).optional(),
  rules: adRulesSchema.optional(),
});
export type BriefInput = z.infer<typeof briefSchema>;

/** One scene of the script, as the director writes it and the artist edits it. */
export const scriptSceneSchema = z.strictObject({
  seconds: z.number().min(1).max(10),
  visual: text(1200).min(1),
  speaker: text(60).optional(),
  line: text(400).optional(),
  onScreenText: text(120).optional(),
  camera: text(200).optional(),
});

export const scriptSchema = z.strictObject({
  title: text(120).min(1),
  hook: text(300),
  voiceStyle: text(200),
  scenes: z.array(scriptSceneSchema).min(1).max(12),
  callToAction: text(160),
  why: text(1500).optional(),
});
export type AdScript = z.infer<typeof scriptSchema>;

/** The end card: logo + call to action over the last seconds of the ad (inside the length, never added on). */
export const endCardSchema = z.strictObject({
  enabled: z.boolean(),
  seconds: z.number().min(2).max(5),
  headline: text(60),
  subline: text(80),
  useLogo: z.boolean(),
  /** Tint over the blurred last shot (#rrggbb), or null for the blurred shot alone. */
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
});
export type EndCard = z.infer<typeof endCardSchema>;

export const VERSION_ASPECTS = ['9:16', '1:1', '4:5', '16:9'] as const;
export type VersionAspect = (typeof VERSION_ASPECTS)[number];
/** blur = the whole picture over a blurred fill (nothing cut off); crop = fill the frame, centre crop. */
export const versionsSchema = z.strictObject({
  aspects: z.array(z.enum(VERSION_ASPECTS)).min(1).max(4),
  fit: z.enum(['blur', 'crop']).default('blur'),
});

export const scriptRequestSchema = z.strictObject({ notes: text(1500).optional() }).optional();
