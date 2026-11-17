/** Row shapes for likeness + creations (camelCased by studio/sql.ts). */
import type { SavedFal } from '../studio/falRun.js';

export interface LikenessProfile {
  summary?: string;
  face?: string;
  skeleton?: string;
  body?: string;
  proportions?: string;
  heightImpression?: string;
  posture?: string;
  gait?: string;
  hair?: string;
  wardrobe?: string;
  /** The user's own description of their voice (models can't hear the sample). */
  voice?: string;
  /** Free text the user gave before the build. */
  selfDescription?: string;
  notes?: string;
  samePerson?: boolean;
}

export interface LikenessLora {
  status: 'PENDING' | 'TRAINING' | 'READY' | 'FAILED' | 'SKIPPED';
  triggerWord: string;
  loraKey?: string;
  endpoint?: string;
  trainedAt?: string;
  images?: number;
  error?: string;
}

export interface LikenessRow {
  userId: string;
  status: 'EMPTY' | 'ANALYZING' | 'TRAINING' | 'READY' | 'FAILED';
  consentAt: Date | null;
  consentIp: string | null;
  heightCm: number | null;
  profile: LikenessProfile | null;
  referenceKeys: string[];
  voiceKey: string | null;
  lora: LikenessLora | null;
  falRequest: SavedFal;
  workspaceId: string | null;
  reservationId: string | null;
  tokensCharged: number;
  engine: string | null;
  error: string | null;
  analyzedAt: Date | null;
  updatedAt: Date;
}

export interface LikenessAssetRow {
  id: string;
  userId: string;
  kind: 'PHOTO' | 'VIDEO';
  key: string;
  name: string;
  contentType: string;
  size: string | number;
  meta: { width?: number; height?: number; durationSec?: number; hasAudio?: boolean };
  status: 'PENDING' | 'READY';
  createdAt: Date;
}

export type CreationMode = 'IMAGE' | 'VIDEO' | 'ENHANCE';
export type CreationStatus = 'QUEUED' | 'DIRECTING' | 'IMAGING' | 'ANIMATING' | 'ENHANCING' | 'STORING' | 'READY' | 'FAILED' | 'CANCELED';
export const ACTIVE_CREATION: readonly CreationStatus[] = ['QUEUED', 'DIRECTING', 'IMAGING', 'ANIMATING', 'ENHANCING', 'STORING'];

export interface CreationOptions {
  /** Platform marketing assets made by the super admin: no watermark. */
  brandFree?: boolean;
  /** Final detail pass on stills. */
  upscale?: boolean;
  /** Let the director rewrite the prompt (default true). */
  direct?: boolean;
  /** Tokens per step, frozen at request time. */
  costs?: { direction: number; image: number; video: number; upscale: number };
  title?: string;
  motion?: string;
}

export interface CreationRow {
  id: string;
  userId: string;
  workspaceId: string;
  mode: CreationMode;
  prompt: string;
  direction: string | null;
  usesMe: boolean;
  aspect: '16:9' | '9:16' | '1:1';
  durationSec: number | null;
  sourceKey: string | null;
  options: CreationOptions;
  status: CreationStatus;
  falRequest: SavedFal;
  outputKey: string | null;
  thumbKey: string | null;
  outputSize: string | number | null;
  cost: number;
  reservationId: string | null;
  engine: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}
