/** Row shapes for the studio tables (camelCased by sql.ts). */
import type { Aspect, Look, PerformanceEmotion, Shot, Transition } from './cinema.js';
import type { SceneMove } from '../moves/types.js';

export type StudioKind = 'AI_VIDEO' | 'MUSIC_VIDEO' | 'COMMERCIAL';
export type StudioStatus = 'DRAFT' | 'ASSEMBLING' | 'READY' | 'FAILED';
export const REVIEW_ISSUES = ['WEAK', 'OFF_STORY', 'OUT_OF_SCOPE', 'POOR_QUALITY', 'LIP_SYNC', 'TOO_AI', 'INCONSISTENT', 'TIMING', 'MISFIT'] as const;
export const REVIEW_FIXES = ['RETAKE', 'REWRITE_SCRIPT', 'SOFTER_DELIVERY', 'CHECK_CAST', 'TRIM', 'KEEP'] as const;

export interface TakeReview {
  status: 'RUNNING' | 'DONE' | 'FAILED';
  verdict?: 'GOOD' | 'FLAG';
  /** 1 (unusable) … 10 (broadcast ready). */
  score?: number;
  summary?: string;
  issues?: { kind: (typeof REVIEW_ISSUES)[number]; severity: 'high' | 'medium' | 'low'; detail: string }[];
  fixes?: { action: (typeof REVIEW_FIXES)[number]; label: string }[];
  at: string;
  /** The artist kept the take anyway: no red flag. */
  dismissedAt?: string | null;
  error?: string;
}

export type TakeStatus ='QUEUED' | 'KEYFRAME' | 'ANIMATING' | 'LIPSYNC' | 'STORING' | 'READY' | 'FAILED' | 'CANCELED';
export const ACTIVE_TAKE: readonly TakeStatus[] = ['QUEUED', 'KEYFRAME', 'ANIMATING', 'LIPSYNC', 'STORING'];

export interface Brief {
  /** AI video: the script / brief the shot list is planned from. */
  script?: string;
  /** Overall look and mood ("moody Lagos night, neon, rain"). */
  style?: string;
  /** Music video: where in the song the video starts (seconds). */
  songStart?: number;
}

export interface Finish {
  look: Look;
  /** 0-20; film grain strength. */
  grain: number;
  /** 2.39:1 bars on 16:9 output. */
  letterbox: boolean;
  /** Run the upscale model over each chosen take first. */
  enhance: boolean;
  /** 0-1; soundtrack level (AI video with uploaded music). */
  musicVolume: number;
  /** Master resolution: 1080p, or 2160p (4K) built from the upscaled takes. */
  resolution: '1080p' | '2160p';
  /** Integrated loudness of the master in LUFS (-14 = streaming standard, true peak -1 dBTP). */
  loudnessLufs: number;
  /** Music-video mastering desk (Master page, under the preview): applied to the song before loudness. */
  audio?: MasterAudio;
  /** Music videos: master only this part of the song (seconds after the song start); null = all of it. */
  range?: { start: number; end: number } | null;
  /** VeloBot's AI-master report (musicvideo/mastering.ts), shown on the master page. */
  aiReport?: unknown;
}

export interface MasterAudio {
  /** Input gain, dB (-12…+12). */
  gainDb: number;
  /** 3-band EQ, dB (-12…+12): low shelf 100 Hz, bell 1 kHz, high shelf 8 kHz. */
  lowDb: number;
  midDb: number;
  highDb: number;
  /** Glue compression 0 (off) … 1 (heavy). */
  compress: number;
  /** Stereo width 0 (mono) … 1 (as is) … 2 (wide). */
  width: number;
}

export const DEFAULT_MASTER_AUDIO: MasterAudio = { gainDb: 0, lowDb: 0, midDb: 0, highDb: 0, compress: 0, width: 1 };

/** ffmpeg filters for the mastering desk (empty when every control is neutral). */
export function masterAudioFilters(audio: MasterAudio | undefined): string[] {
  if (!audio) return [];
  const filters: string[] = [];
  if (audio.gainDb) filters.push(`volume=${audio.gainDb.toFixed(1)}dB`);
  if (audio.lowDb) filters.push(`bass=g=${audio.lowDb.toFixed(1)}:f=100:width_type=o:width=0.7`);
  if (audio.midDb) filters.push(`equalizer=f=1000:width_type=o:width=1.2:g=${audio.midDb.toFixed(1)}`);
  if (audio.highDb) filters.push(`treble=g=${audio.highDb.toFixed(1)}:f=8000:width_type=o:width=0.7`);
  if (audio.compress > 0) {
    // Glue: gentle ratio, slow attack so transients survive; heavier = lower threshold + higher ratio.
    const threshold = -10 - audio.compress * 14;
    const ratio = 1.5 + audio.compress * 2.5;
    filters.push(`acompressor=threshold=${threshold.toFixed(1)}dB:ratio=${ratio.toFixed(2)}:attack=25:release=180:makeup=${(1 + audio.compress * 2).toFixed(2)}`);
  }
  if (Math.abs(audio.width - 1) > 0.01) filters.push(`extrastereo=m=${audio.width.toFixed(2)}:c=false`);
  return filters;
}

// AI enhance is the paid upscale on every shot: opt-in, never on by default.
export const DEFAULT_FINISH: Finish = { look: 'filmic', grain: 6, letterbox: false, enhance: false, musicVolume: 1, resolution: '1080p', loudnessLufs: -14 };

export interface Identity {
  profile: string;
  photoAssetIds: string[];
  notes: string;
  samePerson: boolean;
  analyzedAt: string;
  engine: string;
}

export interface LogEntry {
  at: string;
  stage: string;
  engine: string;
  ms: number;
  detail?: string;
}

export interface ProjectRow {
  id: string;
  workspaceId: string;
  createdById: string | null;
  kind: StudioKind;
  title: string;
  status: StudioStatus;
  aspect: Aspect;
  brief: Brief;
  identity: Identity | null;
  consentAt: Date | null;
  consentIp: string | null;
  musicAssetId: string | null;
  finish: Partial<Finish>;
  progress: number;
  stage: string | null;
  outputKey: string | null;
  thumbKey: string | null;
  outputDuration: number | null;
  outputSize: string | null;
  assemblyReservationId: string | null;
  tokensCharged: number;
  cancelRequested: boolean;
  /** With cancelRequested: keep what's done as a playable preview (migration 020). */
  cancelKeep?: boolean;
  error: string | null;
  engineLog: LogEntry[];
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface AssetRow {
  id: string;
  projectId: string;
  workspaceId: string;
  role: 'PHOTO' | 'MUSIC' | 'VIDEO' | 'SFX' | 'MIX' | 'VOICE';
  key: string;
  name: string;
  contentType: string;
  size: string;
  meta: { width?: number; height?: number; durationSec?: number; subject?: boolean; caption?: string };
  status: 'PENDING' | 'READY';
  createdAt: Date;
}

export interface SceneRow {
  id: string;
  projectId: string;
  position: number;
  description: string;
  prompt: string | null;
  shot: Shot;
  transition: Transition;
  durationSec: number;
  featuresSubject: boolean;
  lipSync: boolean;
  photoAssetIds: string[];
  selectedTakeId: string | null;
  /** Music video director (migration 004). */
  kind: 'INTRO' | 'STORY' | 'OUTRO';
  /** The artist's names for the scene (migration 038); labels only. */
  title?: string;
  subtitle?: string;
  characterIds: string[];
  costume: string | null;
  location: string | null;
  timeOfDay: string | null;
  lyric: string | null;
  /** MANUAL = the artist's transition; AI = chosen from the music at stitch time. */
  transitionMode: 'MANUAL' | 'AI';
  /** Music videos: burn the lyric subtitles over this scene (when subtitles are on). */
  subtitles?: boolean;
  /** CapCut-style clip edits (migration 016): see clipEdits.ts. */
  edits?: unknown;
  /** Music videos (migration 017): how the scene relates to the song. */
  mode?: 'PERFORMANCE' | 'NARRATIVE' | 'BROLL' | null;
  /** Lip-synced scenes (migration 018): how the line is delivered + how far (1-3). */
  emotion?: PerformanceEmotion | null;
  intensity?: number | null;
  /** Commercials (migration 025): the scene's spoken line (VOICE asset), mixed in at the master. */
  voiceAssetId?: string | null;
  /** Performance moves on the scene's characters (migration 028), woven into the prompt. */
  moves?: SceneMove[];
  approvedAt: Date | null;
  shotApprovedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything a take needs, frozen when it was requested. */
export interface TakeSpec {
  kind: StudioKind;
  aspect: Aspect;
  description: string;
  prompt: string;
  shot: Shot;
  durationSec: number;
  featuresSubject: boolean;
  lipSync: boolean;
  style?: string | undefined;
  identityProfile?: string | undefined;
  /** Reference photos of the creator (R2 keys). */
  identityKeys: string[];
  /**
   * Music videos: each on-screen character's photos, kept per person (R2 keys, best first),
   * so the video model gets one identity reference element per character, not a pooled set.
   */
  identityElements?: { name: string; keys: string[] }[] | undefined;
  /** Scene photo to start from (R2 key), if any. */
  sceneKey?: string | undefined;
  /** Music video lip sync: song key + where this scene sits in it. */
  music?:
    | {
        key: string;
        start: number;
        /** Sung lines under this shot, seconds from the shot start: the mouth only moves inside these. */
        vocals?: { start: number; end: number }[] | undefined;
      }
    | undefined;
  /** Music videos: the words sung under this shot (lip-synced shots). */
  lyric?: string | undefined;
  /** Lip-synced shots: delivery (face in the base video, emotion + temperature for the expressive lip sync). */
  performance?: { emotion: PerformanceEmotion | null; intensity: number } | undefined;
  /**
   * Post-processing: this take is an edit of another take's finished video
   * (remove on-screen text, match a character's photos, fix artifacts…).
   * No keyframe / animation: the edit model works on `sourceVideoKey`, then
   * lip sync re-runs when `lipSync` is set.
   */
  edit?:
    | {
        sourceTakeId: string;
        sourceVideoKey: string;
        seconds: number;
        kind: 'remove-text' | 'likeness' | 'fix-artifacts' | 'custom';
        instruction: string;
        /** Reference photos for "look more like" (R2 keys, best first). */
        referenceKeys: string[];
      }
    | undefined;
  /** Music videos: the song under this shot (tempo, section, energy). */
  rhythm?: { bpm: number | null; section: string; energy: number } | undefined;
  /** Music videos: who is on screen and where it is shot (the artist's cast background + location, or the song's regional cue). */
  place?: string | undefined;
  /** Music videos: bold, sharp AI camera work (creative mode). */
  creative?: boolean | undefined;
  /** Music videos: how hard the camera works (natural / bold / wild, studio/cinema.ts CAMERA_ENERGY). */
  energy?: 'natural' | 'bold' | 'wild' | undefined;
  /** The video's opening shot: built to stop the scroll. */
  hook?: boolean | undefined;
  /** Music videos: pop short-film performance standard in every prompt. */
  musicVideo?: boolean | undefined;
  /** @me with a trained identity model: keyframes come from the likeness model (sharper identity). */
  likeness?: { loraKey: string; triggerWord: string } | undefined;
}

export interface TakeRow {
  id: string;
  sceneId: string;
  projectId: string;
  workspaceId: string;
  status: TakeStatus;
  spec: TakeSpec;
  falRequest: { stage: string; endpoint: string; requestId: string; statusUrl: string; responseUrl: string } | null;
  /** Paid fal.ai results by stage, kept so a resumed take never pays twice. */
  outputs: Record<string, unknown>;
  keyframeKey: string | null;
  /** VeloBot's review of a finished music-video take (migration 022, musicvideo/review.ts). */
  review?: TakeReview | null;
  videoKey: string | null;
  thumbKey: string | null;
  durationSec: number | null;
  cost: number;
  reservationId: string | null;
  settled: boolean;
  engine: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}
