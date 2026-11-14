/**
 * Companies: the business account that owns products and their ads, inside a
 * workspace (billing, tokens and storage stay per workspace). The user who
 * creates one is its OWNER and is recorded on it (KYC trail); members are
 * other users of the same workspace.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { requireMembership } from '../services/workspace.service.js';
import { readUrl } from '../services/storage.service.js';
import { sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import type { CompanyInput } from './schemas.js';

export interface CompanyRow {
  id: string;
  workspaceId: string;
  name: string;
  legalName: string | null;
  registrationNo: string | null;
  country: string | null;
  industry: string | null;
  website: string | null;
  description: string;
  tone: string;
  brandColours: string[];
  logoKey: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Workspace access: read for any member, write for OWNER / EDITOR (super admin always). */
export async function workspaceAccess(auth: AuthContext, workspaceId: string, write: boolean): Promise<void> {
  if (auth.role === 'SUPER_ADMIN') return;
  await requireMembership(auth.userId, workspaceId, write ? ['OWNER', 'EDITOR'] : undefined);
}

export async function loadCompany(workspaceId: string, companyId: string): Promise<CompanyRow> {
  const [row] = await sql<CompanyRow[]>`SELECT * FROM companies WHERE id = ${companyId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
  if (!row) throw AppError.notFound('Company');
  return row;
}

/** Company-level write: its OWNER / EDITOR members, workspace owners, the super admin. */
export async function companyAccess(auth: AuthContext, workspaceId: string, companyId: string, write: boolean): Promise<CompanyRow> {
  await workspaceAccess(auth, workspaceId, write);
  const company = await loadCompany(workspaceId, companyId);
  if (!write || auth.role === 'SUPER_ADMIN') return company;
  const [member] = await sql<{ role: string }[]>`SELECT role FROM company_members WHERE company_id = ${companyId} AND user_id = ${auth.userId}`;
  if (member && member.role !== 'VIEWER') return company;
  const role = await requireMembership(auth.userId, workspaceId);
  if (role === 'OWNER') return company;
  throw AppError.forbidden('You can view this company, but only its owner and editors can change it.');
}

export async function companyView(row: CompanyRow) {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    registrationNo: row.registrationNo,
    country: row.country,
    industry: row.industry,
    website: row.website,
    description: row.description,
    tone: row.tone,
    brandColours: row.brandColours,
    logoUrl: row.logoKey ? await readUrl(row.logoKey) : null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCompanies(auth: AuthContext, workspaceId: string) {
  await workspaceAccess(auth, workspaceId, false);
  const rows = await sql<(CompanyRow & { products: number; ads: number })[]>`
    SELECT c.*,
      (SELECT count(*)::int FROM products p WHERE p.company_id = c.id AND p.deleted_at IS NULL) AS products,
      (SELECT count(*)::int FROM ad_projects a JOIN studio_projects s ON s.id = a.project_id WHERE a.company_id = c.id AND s.deleted_at IS NULL) AS ads
    FROM companies c WHERE c.workspace_id = ${workspaceId} AND c.deleted_at IS NULL ORDER BY c.updated_at DESC`;
  return Promise.all(rows.map(async (row) => ({ ...(await companyView(row)), products: row.products, ads: row.ads })));
}

export async function createCompany(auth: AuthContext, workspaceId: string, input: CompanyInput) {
  await workspaceAccess(auth, workspaceId, true);
  const [row] = await sql<CompanyRow[]>`
    INSERT INTO companies (workspace_id, name, legal_name, registration_no, country, industry, website, description, tone, brand_colours, created_by_id)
    VALUES (${workspaceId}, ${input.name}, ${input.legalName || null}, ${input.registrationNo || null}, ${input.country ?? null}, ${input.industry || null},
      ${input.website || null}, ${input.description ?? ''}, ${input.tone ?? ''}, ${input.brandColours ?? []}::text[], ${auth.userId})
    RETURNING *`;
  await sql`INSERT INTO company_members (company_id, user_id, role, invited_by_id) VALUES (${row!.id}, ${auth.userId}, 'OWNER', ${auth.userId}) ON CONFLICT DO NOTHING`;
  return companyView(row!);
}

export async function updateCompany(auth: AuthContext, workspaceId: string, companyId: string, input: Partial<CompanyInput>) {
  const current = await companyAccess(auth, workspaceId, companyId, true);
  const [row] = await sql<CompanyRow[]>`
    UPDATE companies SET
      name = ${input.name ?? current.name}, legal_name = ${input.legalName ?? current.legalName}, registration_no = ${input.registrationNo ?? current.registrationNo},
      country = ${input.country ?? current.country}, industry = ${input.industry ?? current.industry},
      website = ${input.website === undefined ? current.website : input.website || null}, description = ${input.description ?? current.description},
      tone = ${input.tone ?? current.tone}, brand_colours = ${input.brandColours ?? current.brandColours}::text[], updated_at = now()
    WHERE id = ${companyId} RETURNING *`;
  return companyView(row!);
}

export async function deleteCompany(auth: AuthContext, workspaceId: string, companyId: string): Promise<void> {
  await companyAccess(auth, workspaceId, companyId, true);
  // Soft delete: its ads stay in the project bin rules (restorable by a super admin).
  await sql`UPDATE companies SET deleted_at = now() WHERE id = ${companyId}`;
  await sql`UPDATE studio_projects SET deleted_at = now() WHERE id IN (SELECT project_id FROM ad_projects WHERE company_id = ${companyId}) AND deleted_at IS NULL`;
}

/* ------------------------------------------------------------------ members */

export async function listMembers(auth: AuthContext, workspaceId: string, companyId: string) {
  await companyAccess(auth, workspaceId, companyId, false);
  const rows = await sql<{ userId: string; role: string; email: string; displayName: string | null; createdAt: Date }[]>`
    SELECT m.user_id, m.role, u.email, u.display_name, m.created_at FROM company_members m JOIN users u ON u.id = m.user_id
    WHERE m.company_id = ${companyId} ORDER BY m.created_at`;
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function addMember(auth: AuthContext, workspaceId: string, companyId: string, email: string, role: 'EDITOR' | 'VIEWER') {
  await companyAccess(auth, workspaceId, companyId, true);
  const [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()}`;
  if (!user) throw AppError.notFound('No account uses that email. Ask them to sign up first');
  const [inWorkspace] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${user.id}`;
  if (!inWorkspace?.n) throw AppError.badRequest('Invite them to this workspace first (Settings → Members), then add them to the company.');
  await sql`
    INSERT INTO company_members (company_id, user_id, role, invited_by_id) VALUES (${companyId}, ${user.id}, ${role}, ${auth.userId})
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
  return listMembers(auth, workspaceId, companyId);
}

export async function removeMember(auth: AuthContext, workspaceId: string, companyId: string, userId: string) {
  await companyAccess(auth, workspaceId, companyId, true);
  const [member] = await sql<{ role: string }[]>`SELECT role FROM company_members WHERE company_id = ${companyId} AND user_id = ${userId}`;
  if (member?.role === 'OWNER') throw AppError.badRequest('The company owner cannot be removed.');
  await sql`DELETE FROM company_members WHERE company_id = ${companyId} AND user_id = ${userId}`;
  return listMembers(auth, workspaceId, companyId);
}
