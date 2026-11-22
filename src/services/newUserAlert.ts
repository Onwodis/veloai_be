/**
 * Tells every super admin when a new account is created (after its email code was confirmed).
 * Best effort: a mail problem never affects the sign-up.
 */
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sendMail } from './mail/mail.service.js';
import { newUserMail } from './mail/templates.js';

export async function notifyNewUser(user: { id: string; name: string; email: string; role: string }): Promise<void> {
  try {
    const [admins, total] = await Promise.all([prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true } }), prisma.user.count()]);
    const mail = newUserMail({ name: user.name, email: user.email, role: user.role, total, url: `${env.WEB_APP_URL}/dashboard/admin/users/${user.id}` });
    await Promise.all(admins.map((admin) => sendMail(admin.email, mail).catch((error: unknown) => logger.warn({ err: error }, 'new-user email to a super admin failed'))));
  } catch (error) {
    logger.warn({ err: error, userId: user.id }, 'new-user alert not sent');
  }
}