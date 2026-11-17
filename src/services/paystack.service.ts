/**
 * Token purchases through Paystack.
 *
 * Flow
 *   1. checkout   - we create a PENDING payment with our own unique reference
 *                   and ask Paystack for a hosted checkout URL.
 *   2. customer pays on Paystack, then is redirected to
 *      /dashboard/billing/callback?reference=…
 *   3. verify     - the callback page (and the webhook) ask Paystack's
 *                   verify API for the truth; tokens are credited only for a
 *                   `success` whose amount and currency match what we asked.
 *   4. webhook    - `charge.success` events, authenticated with HMAC-SHA512
 *                   of the raw body using the secret key, credit the payment
 *                   even if the customer never returns to the site.
 *
 * Crediting is idempotent: a conditional update on `credited_at IS NULL`
 * means the redirect and the webhook can race without double-crediting.
 *
 * Test vs live: the super admin switches `paystackMode` in token settings;
 * each payment records the mode (and therefore the key) it was created with.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentMode } from '@prisma/client';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { secret } from '../vault/secrets.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { AppError } from '../utils/AppError.js';
import { randomToken } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { getTokenSettings } from './settings.service.js';
import { applyEntry } from './token.service.js';
import { requireMembership } from './workspace.service.js';
import { requireKyc } from '../privacy/kyc.js';

const API = 'https://api.paystack.co';

function secretKey(mode: PaymentMode): string | undefined {
  return mode === 'LIVE' ? secret('PAYSTACK_LIVE_SECRET_KEY') : secret('PAYSTACK_TEST_SECRET_KEY');
}

export function keyStatus(): { TEST: boolean; LIVE: boolean } {
  return { TEST: Boolean(secret('PAYSTACK_TEST_SECRET_KEY')), LIVE: Boolean(secret('PAYSTACK_LIVE_SECRET_KEY')) };
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

export async function call<T>(mode: PaymentMode, path: string, init: RequestInit = {}): Promise<T> {
  const key = secretKey(mode);
  if (!key) {
    throw new AppError(503, 'PAYMENTS_UNAVAILABLE', `Paystack ${mode.toLowerCase()} keys are not configured. Add the ${mode.toLowerCase()} secret key in Console → Credentials.`);
  }
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    logger.error({ err: error, path }, 'paystack unreachable');
    throw new AppError(502, 'PAYMENT_FAILED', 'Could not reach Paystack. Try again in a moment.');
  }
  const body = (await response.json().catch(() => null)) as PaystackEnvelope<T> | null;
  if (!response.ok || !body?.status) {
    logger.warn({ path, status: response.status, message: body?.message }, 'paystack request rejected');
    throw new AppError(502, 'PAYMENT_FAILED', body?.message ? `Paystack: ${body.message}` : 'Paystack rejected the request.');
  }
  return body.data;
}

/* ------------------------------------------------------------------ key handshake */

export interface PaystackKeyCheck {
  mode: PaymentMode;
  configured: boolean;
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  /** Integration balances, e.g. [{ currency: 'NGN', balance: 150000 }] (minor units). */
  balances: Array<{ currency: string; balance: number }>;
  error: string | null;
}

const lastChecks: Partial<Record<PaymentMode, PaystackKeyCheck>> = {};

/** Authenticates the key against Paystack's read-only balance endpoint. */
export async function verifyKey(mode: PaymentMode): Promise<PaystackKeyCheck> {
  const checkedAt = new Date().toISOString();
  if (!secretKey(mode)) {
    const result = { mode, configured: false, ok: false, checkedAt, latencyMs: null, balances: [], error: `PAYSTACK_${mode}_SECRET_KEY is not configured (Console → Credentials)` };
    lastChecks[mode] = result;
    return result;
  }
  const started = Date.now();
  try {
    const balances = await call<Array<{ currency: string; balance: number }>>(mode, '/balance');
    const result = { mode, configured: true, ok: true, checkedAt, latencyMs: Date.now() - started, balances, error: null };
    lastChecks[mode] = result;
    return result;
  } catch (error) {
    const result = { mode, configured: true, ok: false, checkedAt, latencyMs: Date.now() - started, balances: [], error: error instanceof Error ? error.message : String(error) };
    lastChecks[mode] = result;
    return result;
  }
}

export function lastKeyChecks(): Partial<Record<PaymentMode, PaystackKeyCheck>> {
  return lastChecks;
}

/* ------------------------------------------------------------------ checkout */

export async function startCheckout(auth: AuthContext, workspaceId: string, packageId: string): Promise<{ authorizationUrl: string; reference: string; mode: PaymentMode }> {
  if (auth.role !== 'SUPER_ADMIN') {
    await requireMembership(auth.userId, workspaceId, ['OWNER']);
    await requireKyc(auth.userId, 'purchase');
  }
  const settings = await getTokenSettings();
  const pkg = settings.packages.find((item) => item.id === packageId);
  if (!pkg) throw AppError.badRequest('That token package is no longer available');

  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true } });
  const mode = settings.paystackMode;
  const reference = `${env.APP_SLUG.slice(0, 12)}_${mode === 'LIVE' ? 'L' : 'T'}_${randomToken(12)}`.replace(/[^A-Za-z0-9_-]/g, '');

  const payment = await prisma.payment.create({
    data: { workspaceId, userId: auth.userId, mode, reference, packageId: pkg.id, tokens: pkg.tokens, amount: pkg.price, currency: settings.currency },
  });

  const data = await call<{ authorization_url: string; reference: string }>(mode, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: user.email,
      amount: pkg.price,
      currency: settings.currency,
      reference,
      callback_url: `${env.WEB_APP_URL}/dashboard/billing/callback`,
      metadata: {
        paymentId: payment.id,
        workspaceId,
        packageId: pkg.id,
        tokens: pkg.tokens,
        cancel_action: `${env.WEB_APP_URL}/dashboard/billing?checkout=cancelled`,
        custom_fields: [{ display_name: 'Tokens', variable_name: 'tokens', value: String(pkg.tokens) }],
      },
    }),
  });
  logger.info({ workspaceId, reference, mode, tokens: pkg.tokens }, 'paystack checkout started');
  return { authorizationUrl: data.authorization_url, reference, mode };
}

/* ------------------------------------------------------------------ verify + credit */

interface VerifyData {
  id: number;
  status: 'success' | 'failed' | 'abandoned' | 'ongoing' | 'pending' | 'reversed' | 'queued';
  reference: string;
  amount: number;
  currency: string;
  channel: string;
  paid_at: string | null;
  gateway_response: string;
}

export interface PaymentResult {
  reference: string;
  status: string;
  tokens: number;
  amount: number;
  currency: string;
  mode: PaymentMode;
  credited: boolean;
  balance: number | null;
  message: string;
}

/** Asks Paystack for the payment's real state and credits tokens on success. */
export async function verifyAndCredit(reference: string): Promise<PaymentResult> {
  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment) throw AppError.notFound('Payment');

  const base = { reference, tokens: payment.tokens, amount: payment.amount, currency: payment.currency, mode: payment.mode };
  if (payment.creditedAt) {
    const wallet = await prisma.tokenWallet.findUnique({ where: { workspaceId: payment.workspaceId } });
    return { ...base, status: 'SUCCESS', credited: true, balance: wallet?.balance ?? null, message: 'Tokens already added to your workspace.' };
  }

  const data = await call<VerifyData>(payment.mode, `/transaction/verify/${encodeURIComponent(reference)}`);

  if (data.status !== 'success') {
    const status = data.status === 'abandoned' ? 'ABANDONED' : data.status === 'failed' || data.status === 'reversed' ? 'FAILED' : 'PENDING';
    await prisma.payment.update({ where: { id: payment.id }, data: { status, failureReason: data.gateway_response?.slice(0, 250) ?? null, providerTransactionId: String(data.id) } });
    return { ...base, status, credited: false, balance: null, message: status === 'PENDING' ? 'Payment is still processing.' : `Payment ${status.toLowerCase()}: ${data.gateway_response}` };
  }

  if (data.amount !== payment.amount || data.currency !== payment.currency) {
    logger.error({ reference, expected: payment.amount, got: data.amount, currency: data.currency }, 'paystack amount mismatch; not crediting');
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: 'Amount or currency mismatch' } });
    throw new AppError(400, 'PAYMENT_FAILED', 'The paid amount did not match this purchase. Contact support with your reference.');
  }

  const balance = await prisma.$transaction(async (tx) => {
    // Only one caller (redirect or webhook) can flip credited_at.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, creditedAt: null },
      data: {
        status: 'SUCCESS',
        creditedAt: new Date(),
        paidAt: data.paid_at ? new Date(data.paid_at) : new Date(),
        providerTransactionId: String(data.id),
        channel: data.channel?.slice(0, 32) ?? null,
      },
    });
    if (claimed.count === 0) return null;
    return applyEntry(tx, {
      workspaceId: payment.workspaceId,
      type: 'PURCHASE',
      amount: payment.tokens,
      reference,
      actorId: payment.userId,
      note: `Paystack ${payment.mode.toLowerCase()} · ${payment.packageId}`,
    });
  });

  if (balance !== null) logger.info({ reference, tokens: payment.tokens, workspaceId: payment.workspaceId }, 'tokens credited');
  const wallet = balance ?? (await prisma.tokenWallet.findUnique({ where: { workspaceId: payment.workspaceId } }))?.balance ?? null;
  return { ...base, status: 'SUCCESS', credited: true, balance: wallet, message: `${payment.tokens.toLocaleString('en')} tokens added to your workspace.` };
}

/** Callback-page verify: the caller must belong to the paying workspace. */
export async function verifyForUser(auth: AuthContext, reference: string): Promise<PaymentResult> {
  const payment = await prisma.payment.findUnique({ where: { reference }, select: { workspaceId: true } });
  if (!payment) throw AppError.notFound('Payment');
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, payment.workspaceId);
  return verifyAndCredit(reference);
}

/* ------------------------------------------------------------------ webhook */

function signatureMatches(raw: Buffer, signature: string, key: string | undefined): boolean {
  if (!key) return false;
  const expected = Buffer.from(createHmac('sha512', key).update(raw).digest('hex'), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function handleWebhook(raw: Buffer, signature: string | undefined): Promise<void> {
  if (!signature || !(signatureMatches(raw, signature, secret('PAYSTACK_TEST_SECRET_KEY')) || signatureMatches(raw, signature, secret('PAYSTACK_LIVE_SECRET_KEY')))) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid webhook signature');
  }
  const event = JSON.parse(raw.toString('utf8')) as { event?: string; data?: { reference?: string } };
  if (event.event !== 'charge.success' || !event.data?.reference) return;
  // Storage packs are their own purchases (storage/service.ts); imported lazily to avoid a cycle.
  const storage = await import('../storage/service.js');
  if (storage.isStorageReference(event.data.reference)) {
    await storage.verifyStoragePayment(event.data.reference);
    return;
  }
  const exists = await prisma.payment.findUnique({ where: { reference: event.data.reference }, select: { id: true } });
  if (!exists) {
    logger.warn({ reference: event.data.reference }, 'webhook for unknown payment reference ignored');
    return;
  }
  // Verify with the API rather than trusting the event body.
  await verifyAndCredit(event.data.reference);
}

/* ------------------------------------------------------------------ admin */

export async function paymentStats(days = 30) {
  const from = new Date(Date.now() - days * 86_400_000);
  const [byMode, recent] = await Promise.all([
    prisma.payment.groupBy({ by: ['mode', 'status'], where: { createdAt: { gte: from } }, _count: { _all: true }, _sum: { amount: true, tokens: true } }),
    prisma.payment.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { workspace: { select: { name: true } } } }),
  ]);
  return {
    byMode: byMode.map((row) => ({ mode: row.mode, status: row.status, count: row._count._all, amount: row._sum.amount ?? 0, tokens: row._sum.tokens ?? 0 })),
    recent: recent.map((row) => ({
      id: row.id,
      reference: row.reference,
      workspace: row.workspace.name,
      mode: row.mode,
      status: row.status,
      tokens: row.tokens,
      amount: row.amount,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
    })),
  };
}
