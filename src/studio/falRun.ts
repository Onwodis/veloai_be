/**
 * Resumable fal.ai call for long jobs: the request handle is persisted before
 * waiting, so a worker restart re-attaches to the same request instead of
 * paying for it twice.
 */
import * as fal from './fal.js';

export type SavedFal = (fal.FalHandle & { stage: string }) | null;

export async function runResumable(
  saved: SavedFal,
  stage: string,
  endpoint: string,
  input: Record<string, unknown>,
  persist: (handle: SavedFal) => Promise<void>,
  options: { timeoutMs?: number; onTick?: (status: string) => Promise<void> } = {},
): Promise<{ result: unknown; seconds: number }> {
  let handle: fal.FalHandle;
  if (saved && saved.stage === stage && saved.endpoint === endpoint) {
    handle = saved;
  } else {
    handle = await fal.submit(endpoint, input);
    await persist({ stage, ...handle });
  }
  const started = Date.now();
  const result = await fal.wait(handle, options);
  await persist(null);
  return { result, seconds: Math.round((Date.now() - started) / 1000) };
}
