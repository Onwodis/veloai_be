/**
 * Identity verification (KYC), in levels:
 *
 *   0  email only (every account)
 *   1  legal name, country and phone: self-declared, granted at once
 *   2  government ID + a selfie: reviewed by an admin
 *   3  business registration (CAC certificate): reviewed by an admin
 *
 * The super admin chooses the level each action needs (making commercials,
 * buying tokens). ID numbers are NEVER stored: only a keyed fingerprint (so
 * one ID on two accounts is spotted) and the last 4 characters. Documents sit
 * under kyc/<userId>/ in the bucket and are only ever read through
 * short-lived signed links, by the admin reviewing them.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { sendMail } from '../services/mail/mail.service.js';
import { kycDecisionMail } from '../services/mail/templates.js';
import { deleteObject, getObjectStream, headObject, presignPut, privateReadUrl } from '../services/storage.service.js';
import { json, sql } from '../studio/sql.js';
import { AppError } from '../utils/AppError.js';
import { fingerprint } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { buildZip, type ZipEntry } from '../utils/zip.js';

export const ID_TYPES = ['NIN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'NATIONAL_ID'] as const;
export type IdType = (typeof ID_TYPES)[number];
export const DOC_SLOTS = ['ID_FRONT', 'ID_BACK', 'SELFIE', 'BUSINESS_CERT'] as const;
export type DocSlot = (typeof DOC_SLOTS)[number];
export type KycStatus = 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';

const MAX_DOC_BYTES = 8 * 1024 * 1024;
const DOC_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
/** The selfie must be a photo; certificates and ID scans may be PDFs. */
const PHOTO_ONLY: DocSlot[] = ['SELFIE'];

// ── Settings: the level each action needs ──────────────────────────────────

export const kycSettingsSchema = z.strictObject({
  commercialLevel: z.number().int().min(0).max(3),
  purchaseLevel: z.number().int().min(0).max(3),
});
export type KycSettings = z.infer<typeof kycSettingsSchema>;
export const DEFAULT_KYC_SETTINGS: KycSettings = { commercialLevel: 1, purchaseLevel: 0 };
export type KycAction = 'commercial' | 'purchase';
const ACTION_LABEL: Record<KycAction, string> = { commercial: 'make commercials', purchase: 'buy tokens and storage' };

let settingsCache: { value: KycSettings; at: number } | null = null;

export async function getKycSettings(): Promise<KycSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 10_000) return settingsCache.value;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM platform_settings WHERE key = 'kyc'`.catch(() => []);
  const parsed = kycSettingsSchema.safeParse(row?.value);
  const value = parsed.success ? parsed.data : DEFAULT_KYC_SETTINGS;
  settingsCache = { value, at: Date.now() };
  return value;
}

export async function saveKycSettings(input: KycSettings, actorId: string): Promise<KycSettings> {
  const value = kycSettingsSchema.parse(input);
  await sql`
    INSERT INTO platform_settings (key, value, updated_by_id, updated_at) VALUES ('kyc', ${json(value)}, ${actorId}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  settingsCache = { value, at: Date.now() };
  return value;
}

// ── Profile ────────────────────────────────────────────────────────────────

interface DocRef {
  key: string;
  contentType: string;
  size: number;
  uploadedAt: string;
}
interface KycRow {
  userId: string;
  level: number;
  status: KycStatus;
  requestedLevel: number | null;
  legalName: string | null;
  country: string | null;
  phone: string | null;
  idType: IdType | null;
  idNumberHash: string | null;
  idNumberLast4: string | null;
  businessName: string | null;
  businessRegNo: string | null;
  documents: Partial<Record<DocSlot, DocRef>> & { duplicateOf?: string[] };
  submittedAt: Date | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const EMPTY = (userId: string): KycRow => ({
  userId,
  level: 0,
  status: 'NONE',
  requestedLevel: null,
  legalName: null,
  country: null,
  phone: null,
  idType: null,
  idNumberHash: null,
  idNumberLast4: null,
  businessName: null,
  businessRegNo: null,
  documents: {},
  submittedAt: null,
  reviewedById: null,
  reviewedAt: null,
  rejectionReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

async function load(userId: string): Promise<KycRow> {
  const [row] = await sql<KycRow[]>`SELECT * FROM kyc_profiles WHERE user_id = ${userId}`;
  return row ?? EMPTY(userId);
}

/** What the user sees: never the fingerprint, never the document keys. */
function ownView(row: KycRow, settings: KycSettings) {
  return {
    level: row.level,
    status: row.status,
    requestedLevel: row.requestedLevel,
    legalName: row.legalName,
    country: row.country,
    phone: row.phone,
    idType: row.idType,
    idNumberLast4: row.idNumberLast4,
    businessName: row.businessName,
    businessRegNo: row.businessRegNo,
    documents: DOC_SLOTS.filter((slot) => row.documents[slot]).map((slot) => ({ slot, uploadedAt: row.documents[slot]!.uploadedAt })),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    rejectionReason: row.status === 'REJECTED' ? row.rejectionReason : null,
    required: settings,
  };
}
export type KycView = ReturnType<typeof ownView>;

export async function myKyc(userId: string): Promise<KycView> {
  const [row, settings] = await Promise.all([load(userId), getKycSettings()]);
  return ownView(row, settings);
}

export async function kycLevel(userId: string): Promise<number> {
  const [row] = await sql<{ level: number }[]>`SELECT level FROM kyc_profiles WHERE user_id = ${userId}`;
  return row?.level ?? 0;
}

/** Throws a 403 with `{ kycRequired }` when the user's level is below what the action needs. */
export async function requireKyc(userId: string, action: KycAction): Promise<void> {
  const settings = await getKycSettings();
  const needed = action === 'commercial' ? settings.commercialLevel : settings.purchaseLevel;
  if (needed === 0) return;
  const level = await kycLevel(userId);
  if (level < needed) {
    throw new AppError(403, 'FORBIDDEN', `Verify your identity (level ${needed}) to ${ACTION_LABEL[action]}. Go to Verification in your dashboard.`, { kycRequired: needed, kycLevel: level, action });
  }
}

// ── Level 1: details ───────────────────────────────────────────────────────

export const detailsSchema = z.strictObject({
  legalName: z.string().trim().min(3, 'Enter your full legal name').max(160).regex(/^[\p{L}\p{M}' .-]+$/u, 'Use letters only'),
  country: z.string().trim().length(2).regex(/^[A-Z]{2}$/, 'Choose a country'),
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Enter the phone number with the country code, e.g. +2348012345678'),
});

export async function saveDetails(userId: string, input: z.infer<typeof detailsSchema>): Promise<KycView> {
  const current = await load(userId);
  if (current.status === 'PENDING') throw AppError.conflict('Your documents are being reviewed. You can change your details after the review.');
  // Changing the legal name after ID verification would un-verify the ID.
  if (current.level >= 2 && current.legalName && current.legalName.toLowerCase() !== input.legalName.toLowerCase()) {
    throw AppError.badRequest('Your legal name is verified against your ID. Ask support to correct it.');
  }
  await sql`
    INSERT INTO kyc_profiles (user_id, level, status, legal_name, country, phone, updated_at)
    VALUES (${userId}, 1, 'VERIFIED', ${input.legalName}, ${input.country}, ${input.phone}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      legal_name = EXCLUDED.legal_name, country = EXCLUDED.country, phone = EXCLUDED.phone,
      level = GREATEST(kyc_profiles.level, 1),
      status = CASE WHEN kyc_profiles.level = 0 THEN 'VERIFIED' ELSE kyc_profiles.status END,
      updated_at = now()`;
  return myKyc(userId);
}

// ── Documents ──────────────────────────────────────────────────────────────

/** A one-off upload URL for a document slot (8 MB, JPEG / PNG / WebP, or PDF for scans). */
export async function documentUploadUrl(userId: string, slot: DocSlot, contentType: string, size: number) {
  const ext = DOC_TYPES[contentType];
  if (!ext || (PHOTO_ONLY.includes(slot) && ext === 'pdf')) throw AppError.badRequest(PHOTO_ONLY.includes(slot) ? 'The selfie must be a JPEG, PNG or WebP photo.' : 'Upload a JPEG, PNG, WebP or PDF file.');
  if (size > MAX_DOC_BYTES) throw AppError.badRequest('Files can be up to 8 MB.');
  if (size < 10 * 1024) throw AppError.badRequest('That file is too small to read. Upload a clear photo or scan.');
  const current = await load(userId);
  if (current.status === 'PENDING') throw AppError.conflict('Your documents are being reviewed. Wait for the result before uploading new ones.');
  const key = `kyc/${userId}/${slot.toLowerCase()}-${randomBytes(9).toString('base64url')}.${ext}`;
  return { key, url: await presignPut(key, contentType, MAX_DOC_BYTES), expiresInSeconds: 900 };
}

/** Checks an uploaded key belongs to this user and slot, and exists. */
async function confirmDoc(userId: string, slot: DocSlot, key: string): Promise<DocRef> {
  const prefix = `kyc/${userId}/${slot.toLowerCase()}-`;
  if (!key.startsWith(prefix) || key.includes('..')) throw AppError.badRequest('That upload does not belong to this step.');
  const head = await headObject(key);
  if (!head) throw AppError.badRequest('The upload did not finish. Try again.');
  if (head.size > MAX_DOC_BYTES) {
    await deleteObject(key).catch(() => undefined);
    throw AppError.badRequest('Files can be up to 8 MB.');
  }
  return { key, contentType: head.contentType ?? 'application/octet-stream', size: head.size, uploadedAt: new Date().toISOString() };
}

/** Removes documents that are being replaced (best effort: the bucket is private anyway). */
async function dropDocs(previous: KycRow['documents'], slots: DocSlot[]): Promise<void> {
  await Promise.all(
    slots.map(async (slot) => {
      const doc = previous[slot];
      if (doc) await deleteObject(doc.key).catch((error: unknown) => logger.warn({ err: error, slot }, 'kyc: old document not deleted'));
    }),
  );
}

// ── Level 2: government ID + selfie ─────────────────────────────────────────

const ID_RULES: Record<IdType, { pattern: RegExp; hint: string; back: boolean }> = {
  NIN: { pattern: /^\d{11}$/, hint: 'An NIN is 11 digits.', back: false },
  PASSPORT: { pattern: /^[A-Z0-9]{6,12}$/, hint: 'A passport number is 6 to 12 letters and numbers.', back: false },
  DRIVERS_LICENSE: { pattern: /^[A-Z0-9-]{6,20}$/, hint: "Enter the licence number as printed.", back: true },
  VOTERS_CARD: { pattern: /^[A-Z0-9 ]{9,23}$/, hint: "Enter the voter's card number (VIN) as printed.", back: true },
  NATIONAL_ID: { pattern: /^[A-Z0-9-]{5,20}$/, hint: 'Enter the ID number as printed.', back: true },
};

export const identitySchema = z.strictObject({
  idType: z.enum(ID_TYPES),
  idNumber: z.string().trim().min(5).max(30),
  idFrontKey: z.string().min(10).max(200),
  idBackKey: z.string().min(10).max(200).optional(),
  selfieKey: z.string().min(10).max(200),
});

export async function submitIdentity(userId: string, input: z.infer<typeof identitySchema>): Promise<KycView> {
  const current = await load(userId);
  if (current.level < 1) throw AppError.badRequest('Add your legal name, country and phone first.');
  if (current.level >= 2) throw AppError.conflict('Your identity is already verified.');
  if (current.status === 'PENDING') throw AppError.conflict('Your documents are already being reviewed.');
  const rule = ID_RULES[input.idType];
  const number = input.idNumber.toUpperCase().replace(/\s+/g, input.idType === 'VOTERS_CARD' ? ' ' : '');
  if (!rule.pattern.test(number)) throw AppError.badRequest(rule.hint);
  if (rule.back && !input.idBackKey) throw AppError.badRequest('Upload the back of the card too.');

  const [front, back, selfie] = await Promise.all([
    confirmDoc(userId, 'ID_FRONT', input.idFrontKey),
    input.idBackKey ? confirmDoc(userId, 'ID_BACK', input.idBackKey) : Promise.resolve(undefined),
    confirmDoc(userId, 'SELFIE', input.selfieKey),
  ]);
  const hash = fingerprint(`kyc-id:${input.idType}`, number);
  // The same ID on another account: not refused (families share devices, typos
  // happen), but flagged for the reviewer.
  const duplicates = await sql<{ userId: string }[]>`SELECT user_id FROM kyc_profiles WHERE id_number_hash = ${hash} AND user_id <> ${userId} LIMIT 5`;

  const documents: KycRow['documents'] = { ...current.documents, ID_FRONT: front, SELFIE: selfie, duplicateOf: duplicates.map((row) => row.userId) };
  if (back) documents.ID_BACK = back;
  else delete documents.ID_BACK;
  await sql`
    UPDATE kyc_profiles SET id_type = ${input.idType}, id_number_hash = ${hash}, id_number_last4 = ${number.replace(/\s/g, '').slice(-4)},
      documents = ${json(documents)}, status = 'PENDING', requested_level = 2, submitted_at = now(), rejection_reason = NULL, updated_at = now()
    WHERE user_id = ${userId}`;
  await dropDocs(current.documents, (['ID_FRONT', 'ID_BACK', 'SELFIE'] as DocSlot[]).filter((slot) => current.documents[slot] && current.documents[slot]!.key !== documents[slot]?.key));
  return myKyc(userId);
}

// ── Level 3: business ──────────────────────────────────────────────────────

export const businessSchema = z.strictObject({
  businessName: z.string().trim().min(2).max(200),
  /** CAC numbers: RC / BN / IT followed by digits (other countries: as printed). */
  businessRegNo: z.string().trim().toUpperCase().regex(/^[A-Z0-9 /-]{4,60}$/, 'Enter the registration number as printed on the certificate'),
  certificateKey: z.string().min(10).max(200),
});

export async function submitBusiness(userId: string, input: z.infer<typeof businessSchema>): Promise<KycView> {
  const current = await load(userId);
  if (current.level < 2) throw AppError.badRequest('Verify your identity (level 2) before your business.');
  if (current.level >= 3) throw AppError.conflict('Your business is already verified.');
  if (current.status === 'PENDING') throw AppError.conflict('Your documents are already being reviewed.');
  if (current.country === 'NG' && !/^(RC|BN|IT|LP|LLP)\s?-?\d{3,10}$/.test(input.businessRegNo)) {
    throw AppError.badRequest('A CAC number starts with RC, BN, IT, LP or LLP followed by digits, e.g. RC 1234567.');
  }
  const certificate = await confirmDoc(userId, 'BUSINESS_CERT', input.certificateKey);
  await sql`
    UPDATE kyc_profiles SET business_name = ${input.businessName}, business_reg_no = ${input.businessRegNo},
      documents = ${json({ ...current.documents, BUSINESS_CERT: certificate })}, status = 'PENDING', requested_level = 3,
      submitted_at = now(), rejection_reason = NULL, updated_at = now()
    WHERE user_id = ${userId}`;
  if (current.documents.BUSINESS_CERT && current.documents.BUSINESS_CERT.key !== certificate.key) await dropDocs(current.documents, ['BUSINESS_CERT']);
  return myKyc(userId);
}

// ── Admin review ───────────────────────────────────────────────────────────

export async function reviewQueue(status: KycStatus = 'PENDING') {
  const rows = await sql<(KycRow & { email: string; displayName: string; accountCreatedAt: Date })[]>`
    SELECT k.*, u.email, u.display_name, u.created_at AS account_created_at
    FROM kyc_profiles k JOIN users u ON u.id = k.user_id
    WHERE k.status = ${status} AND (${status} <> 'NONE')
    ORDER BY k.submitted_at ASC NULLS LAST, k.updated_at DESC LIMIT 200`;
  const [counts] = await sql<{ pending: number; verified2: number; verified3: number; rejected: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
           count(*) FILTER (WHERE level = 2)::int AS verified2,
           count(*) FILTER (WHERE level = 3)::int AS verified3,
           count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
    FROM kyc_profiles`;
  return {
    items: rows.map((row) => ({
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      level: row.level,
      status: row.status,
      requestedLevel: row.requestedLevel,
      legalName: row.legalName,
      country: row.country,
      idType: row.idType,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      waitingHours: row.submittedAt ? Math.round((Date.now() - row.submittedAt.getTime()) / 3_600_000) : null,
      duplicate: (row.documents.duplicateOf?.length ?? 0) > 0,
      accountAgeDays: Math.floor((Date.now() - row.accountCreatedAt.getTime()) / 86_400_000),
    })),
    counts: counts ?? { pending: 0, verified2: 0, verified3: 0, rejected: 0 },
  };
}

/**
 * The whole KYC case as one ZIP (super admin): summary.txt + summary.json (details, status,
 * review history; the ID number itself is never stored, only its last 4 digits) and every
 * document in full resolution. Each download is logged with who took it.
 */
export async function downloadCase(actorId: string, userId: string): Promise<{ fileName: string; zip: Buffer }> {
  const view = await reviewCase(userId);
  const [row] = await sql<KycRow[]>`SELECT * FROM kyc_profiles WHERE user_id = ${userId}`;
  const files: ZipEntry[] = [];
  for (const slot of DOC_SLOTS) {
    const doc = row?.documents[slot];
    if (!doc) continue;
    const object = await getObjectStream(doc.key);
    if (!object) continue;
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const ext = /\.([a-z0-9]+)$/i.exec(doc.key)?.[1] ?? (doc.contentType.split('/')[1] ?? 'bin');
    files.push({ name: `documents/${slot.toLowerCase()}.${ext}`, data: Buffer.concat(chunks) });
  }
  const { documents: _documents, ...summary } = view;
  const lines = [
    `KYC case: ${view.displayName} <${view.email}>`,
    `User id: ${view.userId}`,
    `Downloaded: ${new Date().toISOString()}`,
    '',
    ...Object.entries(summary)
      .filter(([key]) => !['userId', 'email', 'displayName'].includes(key))
      .map(([key, value]) => `${key}: ${value === null || value === undefined ? '-' : typeof value === 'object' ? JSON.stringify(value) : String(value)}`),
    '',
    `Documents: ${files.map((file) => file.name).join(', ') || 'none'}`,
  ];
  files.unshift({ name: 'summary.txt', data: Buffer.from(lines.join('\n'), 'utf8') }, { name: 'summary.json', data: Buffer.from(JSON.stringify(summary, null, 2), 'utf8') });
  logger.warn({ actorId, userId, documents: files.length - 2 }, 'kyc case downloaded');
  const safe = view.displayName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'user';
  return { fileName: `kyc-${safe}-${new Date().toISOString().slice(0, 10)}.zip`, zip: buildZip(files) };
}

/** One case, with 5-minute signed links to its documents. */
export async function reviewCase(userId: string) {
  const [row] = await sql<(KycRow & { email: string; displayName: string; dateOfBirth: Date | null; accountCreatedAt: Date; reviewerName: string | null })[]>`
    SELECT k.*, u.email, u.display_name, u.date_of_birth, u.created_at AS account_created_at, r.display_name AS reviewer_name
    FROM kyc_profiles k JOIN users u ON u.id = k.user_id LEFT JOIN users r ON r.id = k.reviewed_by_id
    WHERE k.user_id = ${userId}`;
  if (!row) throw AppError.notFound('Verification');
  const documents = await Promise.all(
    DOC_SLOTS.filter((slot) => row.documents[slot]).map(async (slot) => {
      const doc = row.documents[slot]!;
      return { slot, contentType: doc.contentType, size: doc.size, uploadedAt: doc.uploadedAt, url: await privateReadUrl(doc.key, 300) };
    }),
  );
  const duplicates = row.documents.duplicateOf?.length
    ? await sql<{ id: string; email: string; displayName: string }[]>`SELECT id, email, display_name FROM users WHERE id = ANY(${row.documents.duplicateOf}::uuid[])`
    : [];
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : null,
    accountCreatedAt: row.accountCreatedAt.toISOString(),
    level: row.level,
    status: row.status,
    requestedLevel: row.requestedLevel,
    legalName: row.legalName,
    country: row.country,
    phone: row.phone,
    idType: row.idType,
    idNumberLast4: row.idNumberLast4,
    businessName: row.businessName,
    businessRegNo: row.businessRegNo,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewerName: row.reviewerName,
    rejectionReason: row.rejectionReason,
    documents,
    linksExpireInSeconds: 300,
    duplicates,
  };
}

export const decisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('APPROVE') }),
  z.strictObject({ decision: z.literal('REJECT'), reason: z.string().trim().min(10, 'Tell the user what to fix').max(400) }),
]);

export async function decide(admin: AuthContext, userId: string, input: z.infer<typeof decisionSchema>) {
  if (admin.userId === userId) throw AppError.forbidden('You cannot review your own verification.');
  const approve = input.decision === 'APPROVE';
  const [row] = await sql<{ level: number; requestedLevel: number | null; email: string }[]>`
    UPDATE kyc_profiles k SET
      level = CASE WHEN ${approve} THEN k.requested_level ELSE k.level END,
      status = CASE WHEN ${approve} THEN 'VERIFIED' ELSE 'REJECTED' END,
      rejection_reason = ${approve ? null : input.reason},
      reviewed_by_id = ${admin.userId}, reviewed_at = now(), updated_at = now()
    FROM users u
    WHERE k.user_id = ${userId} AND u.id = k.user_id AND k.status = 'PENDING' AND k.requested_level IS NOT NULL
    RETURNING k.level, k.requested_level, u.email`;
  if (!row) throw AppError.conflict('This case is no longer waiting for review.');
  // The user hears either way; a mail failure never undoes the decision.
  const reviewed = row.requestedLevel ?? row.level;
  sendMail(row.email, kycDecisionMail({ approved: approve, level: reviewed, reason: approve ? undefined : input.reason, url: `${env.WEB_APP_URL ?? ''}/dashboard/verification` })).catch(
    (error: unknown) => logger.warn({ err: error, userId }, 'kyc: decision mail not sent'),
  );
  return reviewCase(userId);
}
