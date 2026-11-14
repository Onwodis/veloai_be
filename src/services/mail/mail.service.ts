/**
 * Outgoing mail over SMTP (nodemailer).
 *
 * Credentials live in `smtp_credentials`. The row with source ENV mirrors
 * the SMTP_* variables on every boot; the super admin can add more from the
 * dashboard, run an SMTP handshake (`verify`) against each, and choose which
 * one is active. Only a credential whose last handshake passed can be made
 * active. Every send is recorded in `mail_logs`.
 */
import type { SmtpCredential } from '@prisma/client';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import nodemailer, { type Transporter } from 'nodemailer';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { decryptSecret, encryptSecret } from '../../utils/encryption.js';
import { logger } from '../../utils/logger.js';
import type { RenderedMail } from './templates.js';
import { testMail } from './templates.js';

const TIMEOUT_MS = 12_000;

export interface PublicSmtpCredential {
  id: string;
  label: string;
  source: 'ENV' | 'DASHBOARD';
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string | null;
  isActive: boolean;
  lastVerifiedAt: string | null;
  lastVerifyOk: boolean | null;
  lastVerifyError: string | null;
  createdAt: string;
}

export interface NewSmtpCredential {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName?: string | undefined;
}

function toPublic(row: SmtpCredential): PublicSmtpCredential {
  return {
    id: row.id,
    label: row.label,
    source: row.source,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    isActive: row.isActive,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyOk: row.lastVerifyOk,
    lastVerifyError: row.lastVerifyError,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * nodemailer resolves the host with its own DNS queries, which time out on
 * networks with a slow or filtered DNS server (EDNS "DNS lookup … timed out")
 * even though the operating system resolves the name fine. So the host is
 * resolved here with the OS resolver, the connection goes to that address, and
 * TLS still verifies the certificate against the real host name.
 */
/** Last address each SMTP host resolved to: a slow DNS moment reuses it instead of failing. */
const knownAddresses = new Map<string, string>();

/**
 * Resolves with the OS resolver, retrying (DNS here is slow / flaky), then
 * falls back to the last good address. Never hands a bare host name to
 * nodemailer, whose own DNS client is what times out ("DNS lookup … timed out").
 */
async function resolveHost(host: string): Promise<string> {
  if (isIP(host)) return host;
  let lastError: unknown = null;
  for (const attempt of [0, 1, 2]) {
    try {
      const { address } = await lookup(host, { family: attempt === 2 ? 0 : 4 });
      knownAddresses.set(host, address);
      return address;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  const known = knownAddresses.get(host);
  if (known) return known;
  throw new AppError(502, 'MAIL_UNAVAILABLE', `Could not resolve the mail server ${host}: ${describeError(lastError)}`);
}

/**
 * Port and TLS mode must agree: 465 is implicit TLS, 587 / 25 / 2525 start in
 * plain text and upgrade (STARTTLS, required). A mismatch is the classic cause
 * of "wrong version number" or a handshake that hangs until it times out.
 */
function tlsMode(row: Pick<SmtpCredential, 'port' | 'secure'>): { secure: boolean; requireTLS: boolean } {
  if (row.port === 465) return { secure: true, requireTLS: false };
  if ([587, 25, 2525].includes(row.port)) return { secure: false, requireTLS: true };
  return { secure: row.secure, requireTLS: !row.secure };
}

async function buildTransport(row: SmtpCredential, override?: { port: number }): Promise<Transporter> {
  const port = override?.port ?? row.port;
  return nodemailer.createTransport({
    host: await resolveHost(row.host),
    port,
    ...tlsMode({ port, secure: row.secure }),
    // The connection goes to the IP; TLS still verifies the certificate for the real host name.
    tls: { servername: row.host, minVersion: 'TLSv1.2' },
    name: row.host.replace(/^smtp\./, ''),
    auth: { user: row.username, pass: decryptSecret(row.passwordEnc) },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 2,
  });
}

/** Network blips worth a second attempt (not wrong passwords). */
const TRANSIENT = /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|Greeting never received/i;

/** Strips credentials from SMTP error text before it is stored or shown. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(auth|pass(word)?)[^\s]*\s*[:=]\s*\S+/gi, '$1=***').slice(0, 480);
}

/** Plain-language hint for the super admin next to the raw SMTP error. */
function explain(error: string): string {
  if (/535|auth|credentials|Username and Password/i.test(error)) return `${error} — the mail server rejected the username / password (for Zoho, Gmail and Outlook with 2FA, use an app-specific password).`;
  if (/wrong version number|EPROTO|ssl3_get_record/i.test(error)) return `${error} — port and TLS mode disagree: use 465 with SSL, or 587 with STARTTLS.`;
  if (/certificate|self signed|altnames/i.test(error)) return `${error} — the server's TLS certificate does not match the host name; use the provider's official SMTP host.`;
  if (TRANSIENT.test(error)) return `${error} — the network could not reach the mail server in time; it was retried. Check the host / port, or try again.`;
  return error;
}

/* ------------------------------------------------------------------ env sync */

export function envSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

/**
 * Upserts the ENV credential from SMTP_* and makes it the default sender when
 * nothing else is active. A new or changed account gets a handshake straight
 * away (in the background), so the mail page opens with a verified default.
 */
export async function syncEnvCredential(options: { verify?: boolean } = {}): Promise<void> {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM } = env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    logger.info('SMTP_* not fully set; skipping env SMTP credential sync');
    return;
  }
  const port = env.SMTP_PORT ?? 465;
  const data = {
    label: 'Default (.env)',
    host: SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ?? port === 465,
    username: SMTP_USER,
    passwordEnc: encryptSecret(SMTP_PASS),
    fromAddress: SMTP_FROM,
    fromName: env.SMTP_FROM_NAME ?? env.APP_NAME,
  };

  const existing = await prisma.smtpCredential.findFirst({ where: { source: 'ENV' } });
  const changed =
    !existing ||
    existing.host !== data.host ||
    existing.port !== data.port ||
    existing.username !== data.username ||
    decryptSecret(existing.passwordEnc) !== SMTP_PASS;

  const row = existing
    ? await prisma.smtpCredential.update({
        where: { id: existing.id },
        // A changed account must pass a fresh handshake.
        data: { ...data, ...(changed ? { lastVerifyOk: null, lastVerifyError: null, lastVerifiedAt: null } : {}) },
      })
    : await prisma.smtpCredential.create({ data: { ...data, source: 'ENV' } });

  const active = await prisma.smtpCredential.count({ where: { isActive: true } });
  if (active === 0) {
    await prisma.smtpCredential.update({ where: { id: row.id }, data: { isActive: true } });
    logger.info('env SMTP credential set as active mail account');
  }
  cachedTransport = null;

  if ((options.verify ?? true) && (changed || row.lastVerifyOk === null)) {
    void verifyCredential(row.id).catch((error: unknown) => logger.warn({ err: error }, 'env SMTP handshake could not run'));
  }
}

/* ------------------------------------------------------------------ admin CRUD */

export async function listCredentials(): Promise<PublicSmtpCredential[]> {
  // The .env account is always listed: create it now if boot sync didn't
  // (e.g. the table was migrated after the API started).
  if (envSmtpConfigured() && (await prisma.smtpCredential.count({ where: { source: 'ENV' } })) === 0) {
    await syncEnvCredential({ verify: false });
  }
  const rows = await prisma.smtpCredential.findMany({ orderBy: [{ source: 'asc' }, { createdAt: 'asc' }] });
  return rows.map(toPublic);
}

/** Runs the handshake on every account; used by the "Verify all" button and the daily job. */
export async function verifyAllCredentials(): Promise<{ ok: number; failed: number }> {
  const rows = await prisma.smtpCredential.findMany({ select: { id: true } });
  const results = await Promise.all(rows.map((row) => verifyCredential(row.id)));
  const ok = results.filter((row) => row.lastVerifyOk).length;
  return { ok, failed: results.length - ok };
}

export async function createCredential(input: NewSmtpCredential, actorId: string): Promise<PublicSmtpCredential> {
  const row = await prisma.smtpCredential.create({
    data: {
      label: input.label,
      host: input.host,
      port: input.port,
      secure: input.secure,
      username: input.username,
      passwordEnc: encryptSecret(input.password),
      fromAddress: input.fromAddress,
      fromName: input.fromName ?? null,
      source: 'DASHBOARD',
      createdById: actorId,
    },
  });
  return toPublic(row);
}

export async function deleteCredential(id: string): Promise<void> {
  const row = await prisma.smtpCredential.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('SMTP credential');
  if (row.source === 'ENV') throw AppError.badRequest('The .env credential is managed through server configuration');
  if (row.isActive) throw AppError.badRequest('Activate another credential before deleting the active one');
  await prisma.smtpCredential.delete({ where: { id } });
}

/** Opens a connection, negotiates TLS and authenticates, without sending mail. */
export async function verifyCredential(id: string): Promise<PublicSmtpCredential> {
  const row = await prisma.smtpCredential.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('SMTP credential');

  // Connect → TLS → EHLO → AUTH, retried on network blips (never on a rejected login).
  let ok = false;
  let error: string | null = null;
  for (const attempt of [0, 1, 2]) {
    let transport: Transporter | null = null;
    try {
      transport = await buildTransport(row);
      await transport.verify();
      ok = true;
      error = null;
      break;
    } catch (caught) {
      error = describeError(caught);
      if (!TRANSIENT.test(error) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    } finally {
      transport?.close();
    }
  }

  const updated = await prisma.smtpCredential.update({
    where: { id },
    data: { lastVerifiedAt: new Date(), lastVerifyOk: ok, lastVerifyError: error ? explain(error).slice(0, 480) : null },
  });
  logger.info({ credentialId: id, ok, error }, 'smtp handshake verified');
  return toPublic(updated);
}

export async function activateCredential(id: string): Promise<PublicSmtpCredential[]> {
  const row = await prisma.smtpCredential.findUnique({ where: { id } });
  if (!row) throw AppError.notFound('SMTP credential');
  if (row.lastVerifyOk !== true) {
    throw AppError.badRequest('Run a successful handshake on this credential before activating it');
  }
  await prisma.$transaction([
    prisma.smtpCredential.updateMany({ where: { isActive: true }, data: { isActive: false } }),
    prisma.smtpCredential.update({ where: { id }, data: { isActive: true } }),
  ]);
  cachedTransport = null;
  return listCredentials();
}

/* ------------------------------------------------------------------ sending */

let cachedTransport: { key: string; transport: Transporter; row: SmtpCredential } | null = null;

async function activeTransport(): Promise<{ transport: Transporter; row: SmtpCredential }> {
  // The active account, else the .env account as the default.
  const row =
    (await prisma.smtpCredential.findFirst({ where: { isActive: true } })) ?? (await prisma.smtpCredential.findFirst({ where: { source: 'ENV' } }));
  if (!row) throw new AppError(503, 'MAIL_UNAVAILABLE', 'Email is not configured yet. Contact support.');
  const key = `${row.id}:${row.updatedAt.getTime()}`;
  if (cachedTransport?.key !== key) {
    cachedTransport?.transport.close();
    cachedTransport = { key, transport: await buildTransport(row), row };
  }
  return cachedTransport;
}

export async function sendMail(to: string, mail: RenderedMail, credentialId?: string): Promise<void> {
  let transport: Transporter;
  let row: SmtpCredential;
  if (credentialId) {
    const found = await prisma.smtpCredential.findUnique({ where: { id: credentialId } });
    if (!found) throw AppError.notFound('SMTP credential');
    row = found;
    transport = await buildTransport(found);
  } else {
    ({ transport, row } = await activeTransport());
  }

  const from = row.fromName ? `"${row.fromName.replace(/"/g, '')}" <${row.fromAddress}>` : row.fromAddress;
  try {
    const message = { from, to, subject: mail.subject, html: mail.html, text: mail.text };
    const info = (await transport.sendMail(message).catch(async (first: unknown) => {
      // A pooled connection can go stale, or the network blip: one fresh retry.
      if (!TRANSIENT.test(describeError(first))) throw first;
      if (!credentialId) cachedTransport = null;
      const fresh = await buildTransport(row);
      try {
        return await fresh.sendMail(message);
      } finally {
        fresh.close();
      }
    })) as { messageId?: string };
    await prisma.mailLog.create({
      data: { credentialId: row.id, to, subject: mail.subject, template: mail.template, status: 'SENT', messageId: info.messageId ?? null },
    });
    // A delivered message proves the handshake: keep the status honest.
    if (row.lastVerifyOk !== true) {
      await prisma.smtpCredential.update({ where: { id: row.id }, data: { lastVerifyOk: true, lastVerifyError: null, lastVerifiedAt: new Date() } }).catch(() => undefined);
    }
  } catch (caught) {
    const error = describeError(caught);
    await prisma.mailLog.create({
      data: { credentialId: row.id, to, subject: mail.subject, template: mail.template, status: 'FAILED', error },
    });
    logger.error({ credentialId: row.id, template: mail.template, error }, 'mail send failed');
    throw new AppError(502, 'MAIL_UNAVAILABLE', `The mail server rejected the message: ${error}`);
  } finally {
    if (credentialId) transport.close();
  }
}

/** Sends a test message through a specific credential (or the active one). */
export async function sendTestMail(to: string, credentialId?: string): Promise<void> {
  const row = credentialId
    ? await prisma.smtpCredential.findUnique({ where: { id: credentialId } })
    : ((await prisma.smtpCredential.findFirst({ where: { isActive: true } })) ?? (await prisma.smtpCredential.findFirst({ where: { source: 'ENV' } })));
  if (!row) throw new AppError(503, 'MAIL_UNAVAILABLE', 'No SMTP credential to send with');
  await sendMail(to, testMail(row.label), row.id);
}

export async function recentMail(limit = 25): Promise<
  Array<{ id: string; to: string; subject: string; template: string; status: string; error: string | null; createdAt: string; credentialLabel: string | null }>
> {
  const rows = await prisma.mailLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { credential: { select: { label: true } } },
  });
  return rows.map((row) => ({
    id: row.id.toString(),
    to: row.to,
    subject: row.subject,
    template: row.template,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    credentialLabel: row.credential?.label ?? null,
  }));
}
