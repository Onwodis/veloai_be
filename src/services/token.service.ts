/**
 * Token wallets, the ledger and task gating.
 *
 * Gating ("never start what you can't finish"):
 *   1. estimate  - tokens for every step of the task, plus a safety buffer
 *   2. reserve   - an atomic SQL update moves the estimate into `held` only if
 *                  available (= balance - held) covers max(estimate, minimum
 *                  start balance). Two tasks racing can never overspend.
 *   3. settle    - the task reports what it actually used; that is charged,
 *                  the rest of the hold is released.
 *      release   - a cancelled/failed task frees its hold untouched.
 *      expiry    - holds left open past their TTL are released by a sweep.
 *
 * The super admin is unmetered: their tasks are recorded (so analytics stay
 * honest) but never blocked or charged.
 */
import type { Prisma, TokenEntryType } from '@prisma/client';
import { prisma } from '../config/database.js';
import { ENGINE_TASK_PREFIX, ENGINE_TASK_TYPES, estimateTask, isEngineTask, type BilledSteps, type Estimate, type EstimateInput } from '../config/tokenSettings.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { getTokenSettings } from './settings.service.js';
import { requireMembership } from './workspace.service.js';

type Tx = Prisma.TransactionClient;

export interface WalletView {
  balance: number;
  held: number;
  available: number;
  lifetimePurchased: number;
  lifetimeUsed: number;
}

const view = (wallet: { balance: number; held: number; lifetimePurchased: number; lifetimeUsed: number }): WalletView => ({
  balance: wallet.balance,
  held: wallet.held,
  available: wallet.balance - wallet.held,
  lifetimePurchased: wallet.lifetimePurchased,
  lifetimeUsed: wallet.lifetimeUsed,
});

/**
 * Creates the wallet on first touch, empty. The welcome tokens are granted when the owner verifies
 * their email (services/emailVerification.service.ts), once per user, so throwaway accounts can't
 * farm them.
 */
async function ensureWallet(db: Tx | typeof prisma, workspaceId: string): Promise<void> {
  const exists = await db.tokenWallet.findUnique({ where: { workspaceId }, select: { workspaceId: true } });
  if (exists) return;
  try {
    await db.tokenWallet.create({ data: { workspaceId, balance: 0 } });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error; // created concurrently
  }
}

export async function getWallet(workspaceId: string): Promise<WalletView> {
  // Read once; only a workspace without a wallet yet (first visit) pays for creating it.
  const wallet = await prisma.tokenWallet.findUnique({ where: { workspaceId } });
  if (wallet) return view(wallet);
  await ensureWallet(prisma, workspaceId);
  return view(await prisma.tokenWallet.findUniqueOrThrow({ where: { workspaceId } }));
}

/**
 * Whether this caller's work is free: only the super admin, and only while
 * the token settings say UNLIMITED (METERED = they pay like a customer).
 */
export async function isUnmetered(auth: Pick<AuthContext, 'role'>): Promise<boolean> {
  if (auth.role !== 'SUPER_ADMIN') return false;
  return (await getTokenSettings()).superAdminMode !== 'METERED';
}

/** Balance for any workspace member; super admins are unmetered unless set to METERED. */
export async function walletFor(auth: AuthContext, workspaceId: string): Promise<{ wallet: WalletView; unmetered: boolean }> {
  // The membership check, the wallet read and the mode run together (one round trip). A
  // missing wallet is only created once membership is confirmed, so a non-member's request
  // never creates (or grants welcome tokens to) someone else's wallet.
  const [, existing, unmetered] = await Promise.all([
    auth.role === 'SUPER_ADMIN' ? Promise.resolve(null) : requireMembership(auth.userId, workspaceId),
    prisma.tokenWallet.findUnique({ where: { workspaceId } }),
    isUnmetered(auth),
  ]);
  return { wallet: existing ? view(existing) : await getWallet(workspaceId), unmetered };
}

/** Credits or debits the balance and writes the ledger row, atomically. */
export async function applyEntry(
  db: Tx,
  input: {
    workspaceId: string;
    type: TokenEntryType;
    amount: number;
    reference?: string;
    note?: string;
    actorId?: string;
    taskType?: string;
    /** Charge for work already delivered: goes through even if it overdraws (the next task is gated by the negative balance). */
    allowOverdraw?: boolean;
  },
): Promise<number> {
  await ensureWallet(db, input.workspaceId);
  const rows = await db.$queryRaw<Array<{ balance: number }>>`
    UPDATE token_wallets
    SET balance = balance + ${input.amount},
        lifetime_purchased = lifetime_purchased + ${input.type === 'PURCHASE' ? input.amount : 0},
        lifetime_used = lifetime_used + ${input.type === 'USAGE' ? -input.amount : 0},
        updated_at = now()
    WHERE workspace_id = ${input.workspaceId}::uuid AND (${input.allowOverdraw === true} OR balance + ${input.amount} >= held)
    RETURNING balance`;
  const balance = rows[0]?.balance;
  if (balance === undefined) throw AppError.badRequest('That adjustment would take the balance below tokens currently reserved');
  await db.tokenLedger.create({
    data: {
      workspaceId: input.workspaceId,
      type: input.type,
      amount: input.amount,
      balanceAfter: balance,
      reference: input.reference ?? null,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
      taskType: input.taskType ?? null,
    },
  });
  return balance;
}

/* ------------------------------------------------------------------ preflight */

export interface Preflight {
  estimate: Estimate;
  wallet: WalletView;
  minimumStartBalance: number;
  canStart: boolean;
  shortfall: number;
  unmetered: boolean;
}

export async function preflight(auth: AuthContext, workspaceId: string, input: EstimateInput, billed?: BilledSteps): Promise<Preflight> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId);
  const [settings, wallet] = await Promise.all([getTokenSettings(), getWallet(workspaceId)]);
  const estimate = estimateTask(settings, input, billed);
  const unmetered = settings.superAdminMode !== 'METERED' && auth.role === 'SUPER_ADMIN';
  // Can start whenever the balance covers the task's price (buffer + minimum start balance are guidance).
  const shortfall = unmetered ? 0 : Math.max(0, estimate.subtotal - wallet.available);
  return { estimate, wallet, minimumStartBalance: settings.minimumStartBalance, canStart: shortfall === 0, shortfall, unmetered };
}

/* ------------------------------------------------------------------ reservations */

export interface ReservationView {
  id: string;
  taskType: string;
  estimated: number;
  actual: number | null;
  status: string;
  unmetered: boolean;
  createdAt: string;
  expiresAt: string;
}

const reservationView = (row: {
  id: string;
  taskType: string;
  estimated: number;
  actual: number | null;
  status: string;
  unmetered: boolean;
  createdAt: Date;
  expiresAt: Date;
}): ReservationView => ({
  id: row.id,
  taskType: row.taskType,
  estimated: row.estimated,
  actual: row.actual,
  status: row.status,
  unmetered: row.unmetered,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

/**
 * Holds tokens for a task, inside the caller's transaction. The task goes ahead whenever the
 * workspace can pay its actual price (`price`): the safety buffer and the minimum start balance are
 * guidance, not a wall, so a user can always spend the balance they have. The hold is the buffered
 * estimate, trimmed to what is available (never below the price). Returns the amount held, or null
 * when the balance can't cover the price.
 */
async function holdTokens(tx: Tx, workspaceId: string, price: number, estimate: number): Promise<number | null> {
  await ensureWallet(tx, workspaceId);
  const [wallet] = await tx.$queryRaw<Array<{ balance: number; held: number; proceeding: boolean }>>`
    SELECT balance, held, coalesce(proceed_until > now(), false) AS proceeding FROM token_wallets WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`;
  const available = (wallet?.balance ?? 0) - (wallet?.held ?? 0);
  if (available < price) {
    // "Risk my balance and continue" (the user saw the warning and chose to go ahead): hold what is
    // there. Multi-step work runs until the balance is used up, then stops; nothing is ever charged
    // beyond the balance (settling caps the charge at it).
    if (!wallet?.proceeding || available <= 0) return null;
    await tx.$executeRaw`UPDATE token_wallets SET held = held + ${available}, updated_at = now() WHERE workspace_id = ${workspaceId}::uuid`;
    return available;
  }
  const hold = Math.max(price, Math.min(estimate, available));
  await tx.$executeRaw`UPDATE token_wallets SET held = held + ${hold}, updated_at = now() WHERE workspace_id = ${workspaceId}::uuid`;
  return hold;
}

/** Minutes a "continue with my balance" choice lasts for the workspace (covers background steps too). */
const PROCEED_MINUTES = 15;

/**
 * The user saw the low-balance warning and chose to go ahead with what they have: for the next
 * few minutes tasks in this workspace hold the available balance instead of being refused.
 */
export async function allowLowBalance(auth: AuthContext, workspaceId: string): Promise<{ until: string; available: number }> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  await ensureWallet(prisma, workspaceId);
  const until = new Date(Date.now() + PROCEED_MINUTES * 60_000);
  await prisma.$executeRaw`UPDATE token_wallets SET proceed_until = ${until}, updated_at = now() WHERE workspace_id = ${workspaceId}::uuid`;
  const wallet = await getWallet(workspaceId);
  logger.info({ workspaceId, userId: auth.userId, available: wallet.available }, 'low balance: user chose to continue with their balance');
  return { until: until.toISOString(), available: wallet.available };
}

/**
 * The gate. Call before creating any asset; throws 402 when the workspace
 * can't cover the task, so no AI tokens are spent on work that can't finish.
 */
export async function reserve(
  auth: AuthContext,
  workspaceId: string,
  taskType: string,
  input: EstimateInput,
  /** Steps a resumed job has already paid for; only the rest is reserved. */
  billed?: BilledSteps,
): Promise<{ reservation: ReservationView; preflight: Preflight }> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  const settings = await getTokenSettings();
  const check = await preflight(auth, workspaceId, input, billed);
  const expiresAt = new Date(Date.now() + settings.reservationTtlMinutes * 60_000);

  if (check.unmetered) {
    const row = await prisma.tokenReservation.create({
      data: { workspaceId, taskType, estimated: check.estimate.reserve, unmetered: true, createdById: auth.userId, expiresAt, input: input as Prisma.InputJsonValue },
    });
    return { reservation: reservationView(row), preflight: check };
  }

  const row = await prisma.$transaction(async (tx) => {
    const held = await holdTokens(tx, workspaceId, check.estimate.subtotal, check.estimate.reserve);
    if (held === null) {
      const shortfall = Math.max(0, check.estimate.subtotal - check.wallet.available);
      throw new AppError(
        402,
        'INSUFFICIENT_TOKENS',
        `This task costs ${check.estimate.subtotal.toLocaleString('en')} tokens; the workspace has ${check.wallet.available.toLocaleString('en')} available (${shortfall.toLocaleString('en')} short). Buy tokens, or risk your balance and continue.`,
        { required: check.estimate.subtotal, available: check.wallet.available, shortfall, workspaceId, canProceed: check.wallet.available > 0 },
      );
    }
    return tx.tokenReservation.create({
      data: { workspaceId, taskType, estimated: held, createdById: auth.userId, expiresAt, input: input as Prisma.InputJsonValue },
    });
  });
  logger.info({ workspaceId, reservationId: row.id, tokens: row.estimated }, 'tokens reserved');
  return { reservation: reservationView(row), preflight: check };
}

/**
 * The same gate for tasks priced outside the reel estimator (AI video
 * studio): reserves exactly `amount` tokens (+ the buffer), requiring
 * max(that, minimumStartBalance) to be available.
 */
export async function reserveTokens(
  auth: AuthContext,
  workspaceId: string,
  taskType: string,
  amount: number,
  input: Record<string, unknown>,
): Promise<{ reservation: ReservationView; required: number; available: number }> {
  if (auth.role !== 'SUPER_ADMIN') await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
  const [settings, wallet] = await Promise.all([getTokenSettings(), getWallet(workspaceId)]);
  const price = Math.max(1, Math.ceil(amount));
  const estimate = Math.max(price, Math.ceil(amount + (amount * settings.reserveBufferPercent) / 100));
  // What must be available to go ahead: the price itself (the buffer and the minimum start balance are guidance).
  const required = price;
  const expiresAt = new Date(Date.now() + settings.reservationTtlMinutes * 60_000);
  const data = { workspaceId, taskType, estimated: estimate, createdById: auth.userId, expiresAt, input: input as Prisma.InputJsonValue };

  if (auth.role === 'SUPER_ADMIN' && settings.superAdminMode !== 'METERED') {
    const row = await prisma.tokenReservation.create({ data: { ...data, unmetered: true } });
    return { reservation: reservationView(row), required: 0, available: wallet.available };
  }
  await assertDailyEngineCap(workspaceId, taskType, estimate, settings.dailyEngineCap);
  const row = await prisma.$transaction(async (tx) => {
    const held = await holdTokens(tx, workspaceId, price, estimate);
    if (held === null) {
      const shortfall = Math.max(0, price - wallet.available);
      throw new AppError(
        402,
        'INSUFFICIENT_TOKENS',
        `This costs ${price.toLocaleString('en')} tokens; the workspace has ${wallet.available.toLocaleString('en')} available (${shortfall.toLocaleString('en')} short). Buy tokens, or risk your balance and continue.`,
        { required: price, available: wallet.available, shortfall, workspaceId, canProceed: wallet.available > 0 },
      );
    }
    return tx.tokenReservation.create({ data: { ...data, estimated: held } });
  });
  logger.info({ workspaceId, reservationId: row.id, tokens: row.estimated, taskType }, 'tokens reserved');
  return { reservation: reservationView(row), required, available: wallet.available };
}

/**
 * The daily film-engine ceiling: today's engine holds (still open) plus engine charges
 * (settled) plus this request must stay within `cap`. Refused with 402 DAILY_CAP otherwise.
 */
async function assertDailyEngineCap(workspaceId: string, taskType: string, estimate: number, cap: number): Promise<void> {
  if (cap <= 0 || !isEngineTask(taskType)) return;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.tokenReservation.findMany({
    where: { workspaceId, OR: [{ taskType: { in: [...ENGINE_TASK_TYPES] } }, { taskType: { startsWith: ENGINE_TASK_PREFIX } }], createdAt: { gte: dayStart }, status: { in: ['HELD', 'SETTLED'] }, unmetered: false },
    select: { status: true, estimated: true, actual: true },
  });
  const spent = rows.reduce((sum, row) => sum + (row.status === 'HELD' ? row.estimated : (row.actual ?? 0)), 0);
  if (spent + estimate <= cap) return;
  throw new AppError(
    402,
    'DAILY_CAP',
    `Today's film-engine limit is ${cap.toLocaleString('en')} tokens and ${spent.toLocaleString('en')} are already used or held; this needs ${estimate.toLocaleString('en')}. It resets at midnight UTC (the platform admin can raise it).`,
    { cap, spent, needed: estimate },
  );
}

async function closeReservation(reservationId: string, workspaceId: string, outcome: 'SETTLED' | 'RELEASED' | 'EXPIRED', actual = 0, note?: string): Promise<ReservationView> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.tokenReservation.findFirst({ where: { id: reservationId, workspaceId } });
    if (!row) throw AppError.notFound('Reservation');
    // Never charge more than was reserved: the reserve is the task's ceiling.
    const charge = outcome === 'SETTLED' ? Math.min(Math.max(0, actual), row.estimated) : 0;
    if (row.status === 'EXPIRED' && outcome === 'SETTLED') {
      // The work finished after its hold lapsed (a very long render): the hold was already
      // returned, so charge the balance directly instead of losing the charge.
      const updated = await tx.tokenReservation.update({ where: { id: row.id }, data: { status: 'SETTLED', actual: charge, closedAt: new Date() } });
      if (!row.unmetered && charge > 0) {
        // Never more than the balance (the charge stops at what is available).
        const [wallet] = await tx.$queryRaw<Array<{ balance: number; held: number }>>`
          SELECT balance, held FROM token_wallets WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`;
        const billed = Math.min(charge, Math.max(0, (wallet?.balance ?? 0) - (wallet?.held ?? 0)));
        if (billed > 0) {
          await applyEntry(tx, {
            workspaceId,
            type: 'USAGE',
            amount: -billed,
            reference: row.id,
            taskType: row.taskType,
            note: `${note ?? row.taskType} (after hold expiry)`.slice(0, 255),
          });
        }
      }
      logger.warn({ reservationId, charge }, 'settled an expired hold');
      return reservationView(updated);
    }
    if (row.status !== 'HELD') throw AppError.conflict(`This reservation is already ${row.status.toLowerCase()}`);

    const updated = await tx.tokenReservation.update({
      where: { id: row.id },
      data: { status: outcome, actual: outcome === 'SETTLED' ? charge : null, closedAt: new Date() },
    });
    if (!row.unmetered) {
      await tx.$executeRaw`UPDATE token_wallets SET held = GREATEST(0, held - ${row.estimated}), updated_at = now() WHERE workspace_id = ${workspaceId}::uuid`;
      if (charge > 0) {
        // Never more than the balance: a task the user chose to run on their balance ("risk my
        // balance and continue") can cost more than was left; the charge stops at what they have.
        const [wallet] = await tx.$queryRaw<Array<{ balance: number; held: number }>>`
          SELECT balance, held FROM token_wallets WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`;
        const room = Math.max(0, (wallet?.balance ?? 0) - (wallet?.held ?? 0));
        const billed = Math.min(charge, room);
        if (billed < charge) logger.warn({ reservationId, charge, billed }, 'charge capped at the balance');
        if (billed > 0) {
          await applyEntry(tx, { workspaceId, type: 'USAGE', amount: -billed, reference: row.id, taskType: row.taskType, ...(note ? { note: note.slice(0, 255) } : {}) });
        }
      }
    } else if (outcome === 'SETTLED') {
      await tx.tokenLedger.create({
        data: {
          workspaceId,
          type: 'USAGE',
          amount: 0,
          balanceAfter: (await tx.tokenWallet.findUniqueOrThrow({ where: { workspaceId } })).balance,
          reference: row.id,
          taskType: row.taskType,
          note: `Unmetered (super admin), ${actual} tokens${note ? ` · ${note}` : ''}`.slice(0, 255),
        },
      });
    }
    return reservationView(updated);
  });
}

/**
 * Marker on holds the browser creates through POST /reservations. Only those
 * can be released by a user: every other hold belongs to a server job (a fal
 * render, a pipeline run) and is settled by that job, never by the client.
 */
export const CLIENT_HELD = 'clientHeld';

/**
 * Settling decides what a task costs: only the server (or the super admin) may
 * do it. A user settling their own hold at 0 would be free work.
 */
export async function settle(auth: AuthContext, workspaceId: string, reservationId: string, actualTokens: number): Promise<ReservationView> {
  if (auth.role !== 'SUPER_ADMIN') throw AppError.forbidden('Charges are settled by the server when the task finishes.');
  return closeReservation(reservationId, workspaceId, 'SETTLED', actualTokens);
}

export async function release(auth: AuthContext, workspaceId: string, reservationId: string): Promise<ReservationView> {
  if (auth.role !== 'SUPER_ADMIN') {
    await requireMembership(auth.userId, workspaceId, ['OWNER', 'EDITOR']);
    const row = await prisma.tokenReservation.findFirst({ where: { id: reservationId, workspaceId }, select: { input: true } });
    if (!row) throw AppError.notFound('Reservation');
    // Releasing a server job's hold mid-render would let the job finish uncharged.
    if ((row.input as Record<string, unknown> | null)?.[CLIENT_HELD] !== true) {
      throw AppError.forbidden('This hold belongs to a running task: cancel the task instead, and the unused tokens are freed.');
    }
  }
  return closeReservation(reservationId, workspaceId, 'RELEASED');
}

/* ------------------------------------------------------------------ pipeline (server-side) */

/** Settles a reservation from the media worker (no user context). */
export function settleSystem(reservationId: string, workspaceId: string, actualTokens: number, note?: string): Promise<ReservationView> {
  return closeReservation(reservationId, workspaceId, 'SETTLED', actualTokens, note);
}

export function releaseSystem(reservationId: string, workspaceId: string): Promise<ReservationView> {
  return closeReservation(reservationId, workspaceId, 'RELEASED');
}

/**
 * Grows a hold when the measured job is bigger than the estimate it was
 * reserved for (e.g. the real video is longer than the browser reported).
 * Atomic: succeeds only if the extra tokens are available right now.
 */
export async function extendReservation(reservationId: string, workspaceId: string, newEstimate: number): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.tokenReservation.findFirst({ where: { id: reservationId, workspaceId, status: 'HELD' } });
    if (!row) return false;
    const extra = newEstimate - row.estimated;
    if (extra <= 0 || row.unmetered) {
      if (row.unmetered && extra > 0) await tx.tokenReservation.update({ where: { id: row.id }, data: { estimated: newEstimate } });
      return true;
    }
    const grown = await tx.$queryRaw<Array<{ held: number }>>`
      UPDATE token_wallets SET held = held + ${extra}, updated_at = now()
      WHERE workspace_id = ${workspaceId}::uuid AND balance - held >= ${extra}
      RETURNING held`;
    if (grown.length === 0) return false;
    await tx.tokenReservation.update({ where: { id: row.id }, data: { estimated: newEstimate } });
    return true;
  });
}

/** Keeps a running job's hold from expiring (called at each pipeline stage). */
export async function touchReservation(reservationId: string): Promise<void> {
  const { reservationTtlMinutes } = await getTokenSettings();
  await prisma.tokenReservation.updateMany({
    where: { id: reservationId, status: 'HELD' },
    data: { expiresAt: new Date(Date.now() + reservationTtlMinutes * 60_000) },
  });
}

/** Releases holds whose task never reported back. Run on an interval. */
export async function expireReservations(): Promise<number> {
  const stale = await prisma.tokenReservation.findMany({
    where: { status: 'HELD', expiresAt: { lt: new Date() } },
    select: { id: true, workspaceId: true },
    take: 200,
  });
  for (const row of stale) {
    await closeReservation(row.id, row.workspaceId, 'EXPIRED').catch((error: unknown) => logger.error({ err: error, reservationId: row.id }, 'reservation expiry failed'));
  }
  return stale.length;
}

/* ------------------------------------------------------------------ overview + admin */

export async function overview(auth: AuthContext, workspaceId: string) {
  const role = auth.role === 'SUPER_ADMIN' ? 'OWNER' : await requireMembership(auth.userId, workspaceId);
  const [settings, wallet, ledger, payments, reservations] = await Promise.all([
    getTokenSettings(),
    getWallet(workspaceId),
    prisma.tokenLedger.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.payment.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 15 }),
    prisma.tokenReservation.findMany({ where: { workspaceId, status: 'HELD' }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);
  return {
    wallet,
    // The super admin can always buy (METERED mode is for living the customer experience).
    canBuy: role === 'OWNER' || auth.role === 'SUPER_ADMIN',
    unmetered: auth.role === 'SUPER_ADMIN' && settings.superAdminMode !== 'METERED',
    superAdminMode: auth.role === 'SUPER_ADMIN' ? settings.superAdminMode : undefined,
    mode: settings.paystackMode,
    currency: settings.currency,
    packages: settings.packages,
    taskCosts: settings.taskCosts,
    minimumStartBalance: settings.minimumStartBalance,
    reserveBufferPercent: settings.reserveBufferPercent,
    ledger: ledger.map((row) => ({
      id: row.id.toString(),
      type: row.type,
      amount: row.amount,
      balanceAfter: row.balanceAfter,
      taskType: row.taskType,
      reference: row.reference,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    })),
    payments: payments.map((row) => ({
      id: row.id,
      reference: row.reference,
      mode: row.mode,
      packageId: row.packageId,
      tokens: row.tokens,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      channel: row.channel,
      paidAt: row.paidAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    reservations: reservations.map(reservationView),
  };
}

export async function grant(actorId: string, workspaceId: string, amount: number, note: string): Promise<WalletView> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) throw AppError.notFound('Workspace');
  await prisma.$transaction((tx) => applyEntry(tx, { workspaceId, type: amount >= 0 ? 'GRANT' : 'ADJUSTMENT', amount, note, actorId }));
  logger.info({ actorId, workspaceId, amount }, 'tokens granted/adjusted by super admin');
  return getWallet(workspaceId);
}

export async function listWorkspacesWithWallets(search: string | undefined, page: number, pageSize: number) {
  const where: Prisma.WorkspaceWhereInput = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
          { members: { some: { user: { email: { contains: search, mode: 'insensitive' } } } } },
        ],
      }
    : {};
  const [total, rows] = await prisma.$transaction([
    prisma.workspace.count({ where }),
    prisma.workspace.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        tokenWallet: true,
        members: { where: { role: 'OWNER' }, take: 1, include: { user: { select: { email: true, displayName: true } } } },
      },
    }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      owner: row.members[0]?.user ?? null,
      wallet: row.tokenWallet ? view(row.tokenWallet) : null,
      createdAt: row.createdAt.toISOString(),
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
