/**
 * Parent-company positioning: "<APP_NAME> is a product of Meraki Group
 * Limited", shown in the footer, the auth pages and the about copy. The super
 * admin can switch it off or change the company (name + optional website).
 * Stored in platform_settings('branding'); cached briefly (read on every page).
 */
import { z } from 'zod';
import { json, sql } from '../studio/sql.js';

export const brandingSchema = z.strictObject({
  showParent: z.boolean(),
  companyName: z.string().trim().min(2).max(120),
  companyUrl: z.url().max(300).nullable(),
});
export type Branding = z.infer<typeof brandingSchema>;

export const DEFAULT_BRANDING: Branding = { showParent: true, companyName: 'Meraki Group Limited', companyUrl: null };

let cache: { value: Branding; at: number } | null = null;

export async function getBranding(): Promise<Branding> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'branding'`.catch(() => []);
  const parsed = brandingSchema.safeParse({ ...DEFAULT_BRANDING, ...(row?.value as object | undefined) });
  const value = parsed.success ? parsed.data : DEFAULT_BRANDING;
  cache = { value, at: Date.now() };
  return value;
}

export async function saveBranding(input: Branding, actorId: string): Promise<Branding> {
  const value = brandingSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('branding', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  cache = { value, at: Date.now() };
  return value;
}
