/**
 * Privacy (NDPR): consent records, data-subject requests and the data export.
 *
 *   consents        append-only; the current state of a purpose is its latest
 *                   row. Required purposes (terms, privacy, age) are recorded
 *                   at sign-up and cannot be switched off (closing the account
 *                   is a DELETION request); optional ones change any time.
 *   data requests   access / export / correction / deletion / objection /
 *                   restriction, each due 30 days after it is made; one open
 *                   request per type at a time. Admins work the queue.
 *   export          everything we hold about the user as one JSON document
 *                   (ID numbers are never stored, so never exported).
 */
import { env } from '../config/env.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { sendMail } from '../services/mail/mail.service.js';
import { dataRequestClosedMail } from '../services/mail/templates.js';
import type { RequestMeta } from '../services/securityEvent.service.js';
import { logger } from '../utils/logger.js';
import { sql, type Tx } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { POLICY_VERSIONS, PURPOSES, policyVersionFor, purposeInfo, type Purpose } from './policy.js';

export const REQUEST_TYPES = ['ACCESS', 'EXPORT', 'CORRECTION', 'DELETION', 'OBJECTION', 'RESTRICTION'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'REJECTED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
const RESPONSE_DAYS = 30;
type Source = 'SIGNUP' | 'SETTINGS' | 'ADMIN';

export interface ConsentState {
  purpose: Purpose;
  label: string;
  description: string;
  required: boolean;
  lawfulBasis: string;
  granted: boolean;
  /** The policy version the user accepted (null = never recorded). */
  policyVersion: string | null;
  /** True when the accepted version is older than the current one. */
  outdated: boolean;
  at: string | null;
}

interface ConsentRow {
  purpose: Purpose;
  granted: boolean;
  policyVersion: string;
  createdAt: Date;
}

const clip = (value: string | null, max: number): string | null => (value ? value.slice(0, max) : null);

async function insertConsent(db: Tx | typeof sql, userId: string, purpose: Purpose, granted: boolean, source: Source, meta: RequestMeta): Promise<void> {
  await db`
    INSERT INTO consent_records (user_id, purpose, lawful_basis, granted, policy_version, source, ip_address, user_agent)
    VALUES (${userId}, ${purpose}, ${purposeInfo(purpose).lawfulBasis}, ${granted}, ${policyVersionFor(purpose)}, ${source},
            ${clip(meta.ipAddress, 64)}, ${clip(meta.userAgent, 512)})`;
}

export interface SignupConsents {
  terms: true;
  privacy: true;
  age: true;
  marketing: boolean;
  productResearch: boolean;
}

/** Every purpose shown at sign-up, recorded together (optional ones as given). */
export async function recordSignupConsents(userId: string, consents: SignupConsents, meta: RequestMeta): Promise<void> {
  const choices: [Purpose, boolean][] = [
    ['TERMS', consents.terms],
    ['PRIVACY', consents.privacy],
    ['AGE', consents.age],
    ['MARKETING', consents.marketing],
    ['PRODUCT_RESEARCH', consents.productResearch],
  ];
  await sql.begin(async (tx) => {
    for (const [purpose, granted] of choices) await insertConsent(tx, userId, purpose, granted, 'SIGNUP', meta);
  });
}

export async function currentConsents(userId: string): Promise<ConsentState[]> {
  const rows = await sql<ConsentRow[]>`
    SELECT DISTINCT ON (purpose) purpose, granted, policy_version, created_at
    FROM consent_records WHERE user_id = ${userId} ORDER BY purpose, created_at DESC`;
  const latest = new Map(rows.map((row) => [row.purpose, row]));
  return PURPOSES.map((info) => {
    const row = latest.get(info.purpose);
    return {
      purpose: info.purpose,
      label: info.label,
      description: info.description,
      required: info.required,
      lawfulBasis: info.lawfulBasis,
      granted: row?.granted ?? false,
      policyVersion: row?.policyVersion ?? null,
      outdated: !!row && row.granted && row.policyVersion !== policyVersionFor(info.purpose),
      at: row ? row.createdAt.toISOString() : null,
    };
  });
}

/**
 * Grant or withdraw an optional consent. A required one can only be
 * (re-)accepted, for example when the policy has a new version.
 */
export async function setConsent(userId: string, purpose: Purpose, granted: boolean, meta: RequestMeta): Promise<ConsentState[]> {
  const info = purposeInfo(purpose);
  if (info.required && !granted) {
    throw AppError.badRequest(`“${info.label}” is needed to use the platform. To stop, ask for your account to be deleted.`);
  }
  await insertConsent(sql, userId, purpose, granted, 'SETTINGS', meta);
  return currentConsents(userId);
}

/** Re-accept every required purpose whose policy version changed. */
export async function acceptCurrentPolicies(userId: string, meta: RequestMeta): Promise<ConsentState[]> {
  const states = await currentConsents(userId);
  const stale = states.filter((state) => state.required && (!state.granted || state.outdated));
  if (stale.length) {
    await sql.begin(async (tx) => {
      for (const state of stale) await insertConsent(tx, userId, state.purpose, true, 'SETTINGS', meta);
    });
  }
  return stale.length ? currentConsents(userId) : states;
}

export async function consentHistory(userId: string) {
  const rows = await sql<(ConsentRow & { id: string; source: Source; lawfulBasis: string; ipAddress: string | null })[]>`
    SELECT id, purpose, granted, policy_version, source, lawful_basis, ip_address, created_at
    FROM consent_records WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 200`;
  return rows.map((row) => ({ ...row, id: String(row.id), label: purposeInfo(row.purpose).label, createdAt: row.createdAt.toISOString() }));
}

/** True when the user agreed to marketing email (checked before any campaign mail). */
export async function hasConsent(userId: string, purpose: Purpose): Promise<boolean> {
  const [row] = await sql<{ granted: boolean }[]>`
    SELECT granted FROM consent_records WHERE user_id = ${userId} AND purpose = ${purpose} ORDER BY created_at DESC LIMIT 1`;
  return row?.granted ?? false;
}

// ── Data-subject requests ────────────────────────────────────────────────────

interface RequestRow {
  id: string;
  userId: string;
  type: RequestType;
  status: RequestStatus;
  details: string;
  response: string | null;
  dueAt: Date;
  handledById: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

const requestView = (row: RequestRow) => {
  const open = row.status === 'OPEN' || row.status === 'IN_PROGRESS';
  const msLeft = row.dueAt.getTime() - Date.now();
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    details: row.details,
    response: row.response,
    dueAt: row.dueAt.toISOString(),
    daysLeft: open ? Math.ceil(msLeft / 86_400_000) : null,
    overdue: open && msLeft < 0,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
};
export type DataRequestView = ReturnType<typeof requestView>;

export async function myRequests(userId: string): Promise<DataRequestView[]> {
  const rows = await sql<RequestRow[]>`SELECT * FROM data_requests WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100`;
  return rows.map(requestView);
}

export async function createRequest(userId: string, type: RequestType, details: string): Promise<DataRequestView> {
  if ((type === 'CORRECTION' || type === 'OBJECTION' || type === 'RESTRICTION') && details.trim().length < 10) {
    throw AppError.badRequest('Tell us what to correct, stop or limit (at least a sentence).');
  }
  const [open] = await sql<{ id: string }[]>`
    SELECT id FROM data_requests WHERE user_id = ${userId} AND type = ${type} AND status IN ('OPEN', 'IN_PROGRESS') LIMIT 1`;
  if (open) throw AppError.conflict('You already have an open request of this type. We will answer it within 30 days.');
  const [row] = await sql<RequestRow[]>`
    INSERT INTO data_requests (user_id, type, details, due_at)
    VALUES (${userId}, ${type}, ${details.trim()}, now() + make_interval(days => ${RESPONSE_DAYS}))
    RETURNING *`;
  return requestView(row!);
}

/** The user withdraws their own open request. */
export async function cancelRequest(userId: string, requestId: string): Promise<DataRequestView> {
  const [row] = await sql<RequestRow[]>`
    UPDATE data_requests SET status = 'REJECTED', response = 'Withdrawn by you', closed_at = now()
    WHERE id = ${requestId} AND user_id = ${userId} AND status = 'OPEN' RETURNING *`;
  if (!row) throw AppError.notFound('Open request');
  return requestView(row);
}

export async function adminRequests(filter: { status?: RequestStatus; type?: RequestType }) {
  const rows = await sql<(RequestRow & { email: string; displayName: string; handlerName: string | null })[]>`
    SELECT r.*, u.email, u.display_name, h.display_name AS handler_name
    FROM data_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users h ON h.id = r.handled_by_id
    WHERE (${filter.status ?? null}::text IS NULL OR r.status = ${filter.status ?? null})
      AND (${filter.type ?? null}::text IS NULL OR r.type = ${filter.type ?? null})
    ORDER BY (r.status IN ('OPEN', 'IN_PROGRESS')) DESC, r.due_at ASC LIMIT 300`;
  const [counts] = await sql<{ open: number; overdue: number; dueSoon: number }[]>`
    SELECT count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS'))::int AS open,
           count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS') AND due_at < now())::int AS overdue,
           count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS') AND due_at BETWEEN now() AND now() + interval '7 days')::int AS due_soon
    FROM data_requests`;
  return {
    requests: rows.map((row) => ({ ...requestView(row), user: { id: row.userId, email: row.email, displayName: row.displayName }, handlerName: row.handlerName })),
    counts: counts ?? { open: 0, overdue: 0, dueSoon: 0 },
  };
}

export async function updateRequest(admin: AuthContext, requestId: string, patch: { status: RequestStatus; response?: string }): Promise<DataRequestView> {
  const closing = patch.status === 'DONE' || patch.status === 'REJECTED';
  if (closing && !patch.response?.trim()) throw AppError.badRequest('Write the answer the user will see before closing the request.');
  const [row] = await sql<RequestRow[]>`
    UPDATE data_requests
    SET status = ${patch.status}, response = COALESCE(${patch.response?.trim() || null}, response), handled_by_id = ${admin.userId},
        closed_at = ${closing ? sql`now()` : null}
    WHERE id = ${requestId} AND status IN ('OPEN', 'IN_PROGRESS') RETURNING *`;
  if (!row) throw AppError.conflict('This request is already closed.');
  if (closing && row.response) {
    const [user] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${row.userId}`;
    if (user) {
      sendMail(user.email, dataRequestClosedMail({ type: row.type, status: row.status as 'DONE' | 'REJECTED', response: row.response, url: `${env.WEB_APP_URL ?? ''}/dashboard/privacy` })).catch(
        (error: unknown) => logger.warn({ err: error, requestId }, 'privacy: request-closed mail not sent'),
      );
    }
  }
  return requestView(row);
}

// ── Export ──────────────────────────────────────────────────────────────────

/** Everything we hold about the user, as one document (Right of access / portability). */
export async function exportData(userId: string) {
  const [user] = await sql`
    SELECT id, email, display_name, role, gender, date_of_birth, created_at, last_login_at, totp_enabled_at IS NOT NULL AS two_factor
    FROM users WHERE id = ${userId}`;
  if (!user) throw AppError.notFound('User');
  const [workspaces, consents, kyc, likeness, projects, payments, support, security, requests, moves] = await Promise.all([
    sql`SELECT w.id, w.name, m.role, m.created_at FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ${userId}`,
    consentHistory(userId),
    sql`SELECT level, status, legal_name, country, phone, id_type, id_number_last4, business_name, business_reg_no, submitted_at, reviewed_at, rejection_reason
        FROM kyc_profiles WHERE user_id = ${userId}`,
    sql`SELECT status, consent_at, height_cm, profile, analyzed_at, updated_at FROM likeness_profiles WHERE user_id = ${userId}`,
    sql`SELECT id, kind, title, status, created_at FROM studio_projects WHERE created_by_id = ${userId} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 2000`,
    sql`SELECT reference, package_id, tokens, amount, currency, status, paid_at, created_at FROM payments WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 2000`,
    sql`SELECT number, subject, category, status, created_at FROM support_tickets WHERE user_id = ${userId} ORDER BY created_at DESC`,
    sql`SELECT type, ip_address, user_agent, created_at FROM security_events WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 500`,
    myRequests(userId),
    sql`SELECT move_id, name, cue, detail, created_at FROM custom_moves WHERE owner_id = ${userId} AND deleted_at IS NULL`,
  ]);
  return {
    exportedAt: new Date().toISOString(),
    policyVersions: POLICY_VERSIONS,
    note: 'Government ID numbers are never stored (only a fingerprint and the last 4 characters), so they are not in this file. Your media files are listed by project; download them from each project.',
    account: user,
    workspaces,
    consents,
    identityVerification: kyc[0] ?? null,
    likeness: likeness[0] ?? null,
    projects,
    payments,
    supportTickets: support,
    securityEvents: security,
    dataRequests: requests,
    customMoves: moves,
  };
}
