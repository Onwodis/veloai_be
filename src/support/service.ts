/**
 * Support tickets (tables: studio/migrations/014).
 *
 *   user   opens a ticket (subject, category, first message), replies, closes
 *   staff  (super admin) replies, adds internal notes, sets status / priority,
 *          resolves with a written resolution and optionally credits tokens
 *          back to the user's workspace (refunds, goodwill), which goes through
 *          the normal token ledger so it is audited like any other grant.
 *
 * The user is emailed when staff reply or resolve (best effort).
 */
import { env } from '../config/env.js';
import type { AuthContext } from '../middleware/authenticate.js';
import { prisma } from '../config/database.js';
import { sendMail } from '../services/mail/mail.service.js';
import { supportStaffMail, supportUpdateMail } from '../services/mail/templates.js';
import { grant } from '../services/token.service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { sql } from '../studio/sql.js';

export const CATEGORIES = ['GENERAL', 'BILLING', 'GENERATION', 'ACCOUNT', 'BUG', 'FEATURE'] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const;

export interface TicketRow {
  id: string;
  number: number;
  userId: string;
  workspaceId: string | null;
  subject: string;
  category: (typeof CATEGORIES)[number];
  priority: (typeof PRIORITIES)[number];
  status: (typeof STATUSES)[number];
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  credited: number;
  lastReplyBy: 'USER' | 'STAFF';
  createdAt: Date;
  updatedAt: Date;
}

interface MessageRow {
  id: string;
  ticketId: string;
  authorId: string | null;
  isStaff: boolean;
  internal: boolean;
  body: string;
  createdAt: Date;
}

const isStaff = (auth: AuthContext): boolean => auth.role === 'SUPER_ADMIN' || auth.role === 'ADMIN';

function ticketView(row: TicketRow & { userEmail?: string; userName?: string; messages?: number }) {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    credited: row.credited,
    lastReplyBy: row.lastReplyBy,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.userEmail ? { user: { id: row.userId, email: row.userEmail, name: row.userName ?? '' } } : {}),
    ...(row.messages !== undefined ? { messages: row.messages } : {}),
  };
}
export type TicketView = ReturnType<typeof ticketView>;

async function loadTicket(auth: AuthContext, ticketId: string): Promise<TicketRow> {
  const [row] = await sql<TicketRow[]>`SELECT * FROM support_tickets WHERE id = ${ticketId}`;
  if (!row || (!isStaff(auth) && row.userId !== auth.userId)) throw AppError.notFound('Ticket');
  return row;
}

async function personalWorkspace(userId: string): Promise<string | null> {
  const member = await prisma.workspaceMember.findFirst({ where: { userId, role: 'OWNER' }, orderBy: { createdAt: 'asc' }, select: { workspaceId: true } });
  return member?.workspaceId ?? null;
}

/** Best-effort email to the ticket owner (the team replied / resolved it). */
async function notify(ticket: TicketRow, heading: string, message: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: ticket.userId }, select: { email: true, displayName: true } });
    if (!user) return;
    await sendMail(
      user.email,
      supportUpdateMail({ name: user.displayName, number: ticket.number, subject: ticket.subject, heading, message, url: `${env.WEB_APP_URL}/dashboard/support/${ticket.id}` }),
    );
  } catch (error) {
    logger.warn({ err: error, ticketId: ticket.id }, 'support email not sent');
  }
}

/** Best-effort email to every super admin: a new ticket, or a user's reply. */
async function notifyStaff(ticket: TicketRow, kind: 'new' | 'reply', body: string): Promise<void> {
  try {
    const [user, admins] = await Promise.all([
      prisma.user.findUnique({ where: { id: ticket.userId }, select: { email: true, displayName: true } }),
      prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true } }),
    ]);
    if (!user) return;
    const mail = supportStaffMail({ kind, number: ticket.number, subject: ticket.subject, category: ticket.category, from: user.displayName, email: user.email, body, url: `${env.WEB_APP_URL}/dashboard/admin/support/${ticket.id}` });
    await Promise.all(admins.map((admin) => sendMail(admin.email, mail).catch((error: unknown) => logger.warn({ err: error }, 'support staff email not sent'))));
  } catch (error) {
    logger.warn({ err: error, ticketId: ticket.id }, 'support staff email not sent');
  }
}

/* ------------------------------------------------------------------ user */

export async function listMine(auth: AuthContext) {
  const rows = await sql<(TicketRow & { messages: number })[]>`
    SELECT t.*, (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = t.id AND NOT m.internal) AS messages
    FROM support_tickets t WHERE t.user_id = ${auth.userId} ORDER BY t.updated_at DESC LIMIT 100`;
  return rows.map(ticketView);
}

export async function create(auth: AuthContext, input: { subject: string; category: TicketRow['category']; body: string; workspaceId?: string | undefined }) {
  const [open] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM support_tickets WHERE user_id = ${auth.userId} AND status IN ('OPEN', 'PENDING')`;
  if ((open?.count ?? 0) >= 10) throw AppError.badRequest('You have 10 open tickets: reply to or close one before opening another.');
  const workspaceId = input.workspaceId ?? (await personalWorkspace(auth.userId));
  const priority = input.category === 'BILLING' ? 'HIGH' : 'NORMAL';
  const [ticket] = await sql<TicketRow[]>`
    INSERT INTO support_tickets (user_id, workspace_id, subject, category, priority)
    VALUES (${auth.userId}, ${workspaceId}, ${input.subject}, ${input.category}, ${priority}) RETURNING *`;
  await sql`INSERT INTO support_messages (ticket_id, author_id, is_staff, body) VALUES (${ticket!.id}, ${auth.userId}, false, ${input.body})`;
  void notifyStaff(ticket!, 'new', input.body);
  return get(auth, ticket!.id);
}

export async function get(auth: AuthContext, ticketId: string) {
  const ticket = await loadTicket(auth, ticketId);
  const staff = isStaff(auth);
  const messages = await sql<(MessageRow & { authorName: string | null })[]>`
    SELECT m.*, u.display_name AS author_name FROM support_messages m LEFT JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = ${ticketId} AND (${staff} OR NOT m.internal) ORDER BY m.created_at`;
  const [owner] = await sql<{ email: string; displayName: string }[]>`SELECT email, display_name FROM users WHERE id = ${ticket.userId}`;
  return {
    ticket: ticketView({ ...ticket, ...(owner ? { userEmail: owner.email, userName: owner.displayName } : {}) }),
    messages: messages.map((message) => ({
      id: message.id,
      isStaff: message.isStaff,
      internal: message.internal,
      // Staff names stay private to users: they see the team.
      author: message.isStaff && !staff ? `${env.APP_NAME} support` : (message.authorName ?? 'Deleted user'),
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

export async function reply(auth: AuthContext, ticketId: string, body: string, internal = false) {
  const ticket = await loadTicket(auth, ticketId);
  const staff = isStaff(auth);
  if (!staff && ticket.status === 'CLOSED') throw AppError.badRequest('This ticket is closed: open a new one.');
  await sql`INSERT INTO support_messages (ticket_id, author_id, is_staff, internal, body) VALUES (${ticketId}, ${auth.userId}, ${staff}, ${staff && internal}, ${body})`;
  if (!(staff && internal)) {
    // A user reply re-opens a resolved ticket; a staff reply waits for the user.
    const status = staff ? (ticket.status === 'OPEN' ? 'PENDING' : ticket.status) : ticket.status === 'RESOLVED' || ticket.status === 'PENDING' ? 'OPEN' : ticket.status;
    await sql`UPDATE support_tickets SET status = ${status}, last_reply_by = ${staff ? 'STAFF' : 'USER'}, updated_at = now() WHERE id = ${ticketId}`;
    if (staff) void notify(ticket, 'New reply from support', `our team replied to your ticket: “${body.slice(0, 1500)}”`);
    else void notifyStaff(ticket, 'reply', body);
  }
  return get(auth, ticketId);
}

export async function closeMine(auth: AuthContext, ticketId: string) {
  await loadTicket(auth, ticketId);
  await sql`UPDATE support_tickets SET status = 'CLOSED', updated_at = now() WHERE id = ${ticketId}`;
  return get(auth, ticketId);
}

/* ------------------------------------------------------------------ staff */

export async function listAll(query: { status?: string | undefined; search?: string | undefined; userId?: string | undefined; page: number; pageSize: number }) {
  const search = query.search ? `%${query.search}%` : null;
  const where = sql`
    WHERE (${query.status ?? null}::text IS NULL OR t.status = ${query.status ?? null})
      AND (${query.userId ?? null}::uuid IS NULL OR t.user_id = ${query.userId ?? null})
      AND (${search}::text IS NULL OR t.subject ILIKE ${search} OR u.email ILIKE ${search} OR t.number::text = ${query.search ?? ''})`;
  const [rows, [total]] = await Promise.all([
    sql<(TicketRow & { userEmail: string; userName: string; messages: number })[]>`
      SELECT t.*, u.email AS user_email, u.display_name AS user_name,
        (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = t.id) AS messages
      FROM support_tickets t JOIN users u ON u.id = t.user_id ${where}
      ORDER BY CASE t.status WHEN 'OPEN' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
        CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, t.updated_at DESC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM support_tickets t JOIN users u ON u.id = t.user_id ${where}`,
  ]);
  const [counts] = await sql<{ open: number; pending: number; resolved: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'OPEN')::int AS open, count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE status = 'RESOLVED' AND resolved_at > now() - interval '30 days')::int AS resolved
    FROM support_tickets`;
  return { items: rows.map(ticketView), total: total?.count ?? 0, page: query.page, pageSize: query.pageSize, counts: counts ?? { open: 0, pending: 0, resolved: 0 } };
}

export async function updateTicket(auth: AuthContext, ticketId: string, patch: { status?: TicketRow['status'] | undefined; priority?: TicketRow['priority'] | undefined; category?: TicketRow['category'] | undefined }) {
  const ticket = await loadTicket(auth, ticketId);
  await sql`
    UPDATE support_tickets SET status = ${patch.status ?? ticket.status}, priority = ${patch.priority ?? ticket.priority}, category = ${patch.category ?? ticket.category}, updated_at = now()
    WHERE id = ${ticketId}`;
  return get(auth, ticketId);
}

/** Resolves with a written resolution; optional token credit goes through the audited ledger. */
export async function resolve(auth: AuthContext, ticketId: string, input: { resolution: string; creditTokens?: number | undefined }) {
  const ticket = await loadTicket(auth, ticketId);
  const credit = Math.max(0, Math.floor(input.creditTokens ?? 0));
  if (credit > 0) {
    if (auth.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the super admin can credit tokens.');
    const workspaceId = ticket.workspaceId ?? (await personalWorkspace(ticket.userId));
    if (!workspaceId) throw AppError.badRequest('This user has no workspace to credit.');
    await grant(auth.userId, workspaceId, credit, `Support ticket #${ticket.number}: ${input.resolution}`.slice(0, 255));
  }
  await sql`
    UPDATE support_tickets SET status = 'RESOLVED', resolution = ${input.resolution}, resolved_by = ${auth.userId}, resolved_at = now(),
      credited = credited + ${credit}, last_reply_by = 'STAFF', updated_at = now()
    WHERE id = ${ticketId}`;
  await sql`INSERT INTO support_messages (ticket_id, author_id, is_staff, body) VALUES (${ticketId}, ${auth.userId}, true, ${`Resolved: ${input.resolution}${credit ? `\n\n${credit.toLocaleString('en')} tokens were credited to your workspace.` : ''}`})`;
  void notify(ticket, 'Your ticket is resolved', `your ticket was resolved: “${input.resolution}”.${credit ? ` We credited ${credit.toLocaleString('en')} tokens to your workspace.` : ''} Reply on the ticket if anything is still wrong and it re-opens.`);
  return get(auth, ticketId);
}
