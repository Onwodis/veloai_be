/**
 * Users never see the providers or models under the hood: every user-facing
 * string (take engines, engine logs, errors, identity notes) goes through
 * hideEngine(), which replaces provider/model names and endpoint paths with
 * ENGINE_NAME (default "Velo film engine"). Super-admin panels read the raw
 * settings and keep the real names.
 */
import { env } from '../config/env.js';

export const ENGINE_NAME = env.ENGINE_NAME;

const PATTERNS: RegExp[] = [
  // Endpoint paths first ("fal-ai/kling-video/v2.1/…"), then bare names.
  /\bfal-ai\/[\w./@:-]+/gi,
  /\b[\w-]+\/[\w-]+\/(?:image-to-video|text-to-video|reference-to-video|video-to-video|upscale|lipsync|lip-sync)[\w./-]*/gi,
  /\bfal(?:\.ai|\.run|\.media)?\b/gi,
  /\b(?:kling|veo\s?\d*|seedance|minimax|hailuo|hunyuan|latentsync|sync\.so|lipsync-[\w.]+|mmaudio|topaz|flux[\w.-]*|seedream|nano-banana|ideogram|recraft|wan-?\d[\w.]*|claude[\w.-]*|anthropic|openai|gpt-[\w.]+|whisper-[\w.-]+|demucs|elevenlabs)\b/gi,
];

/** The text with every provider / model name replaced by the engine name (repeats collapsed). */
export function hideEngine(text: string): string;
export function hideEngine(text: string | null): string | null;
export function hideEngine(text: string | null | undefined): string | null | undefined;
export function hideEngine(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, ENGINE_NAME);
  // "Velo film engine Velo film engine" / "Velo film engine/Velo film engine" → once.
  const escaped = ENGINE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return out.replace(new RegExp(`(${escaped})(?:[\\s/:·,-]+${escaped})+`, 'g'), '$1');
}
