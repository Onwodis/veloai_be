/**
 * Super admin seed, driven by ADMIN_EMAIL / ADMIN_PASSWORD, with the name from
 * First_name / Last_name (else ADMIN_NAME) and ADMIN_GENDER (default MALE).
 *
 * Idempotent: creates the account (with its own workspace) when missing, and
 * otherwise only makes sure it holds SUPER_ADMIN. An existing password is
 * never overwritten, so a password changed through the app survives
 * restarts. The account must still enrol TOTP at first sign-in, like
 * everyone else.
 */
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { newId } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { hashPassword } from '../utils/password.js';

export async function seedSuperAdmin(): Promise<'created' | 'promoted' | 'unchanged' | 'skipped'> {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) {
    logger.info('ADMIN_EMAIL / ADMIN_PASSWORD not set; super admin seed skipped');
    return 'skipped';
  }
  if (password.length < 12 || !/\d/.test(password) || !/[A-Za-z]/.test(password)) {
    logger.warn('ADMIN_PASSWORD is weaker than the user password policy (12+ chars, letter and digit); change it soon');
  }

  // First_name / Last_name in .env are the source of truth for the super admin's name.
  const envName = [env.First_name, env.Last_name].filter(Boolean).join(' ');
  const displayName = envName || env.ADMIN_NAME || `${env.APP_NAME} Admin`;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true, displayName: true, gender: true } });
  if (existing) {
    const profile = {
      ...(envName && existing.displayName !== envName ? { displayName: envName } : {}),
      ...(existing.gender !== env.ADMIN_GENDER ? { gender: env.ADMIN_GENDER } : {}),
    };
    if (Object.keys(profile).length) {
      await prisma.user.update({ where: { id: existing.id }, data: profile });
      logger.info({ email, ...profile }, 'super admin profile synced from .env');
    }
    if (existing.role === 'SUPER_ADMIN') return 'unchanged';
    await prisma.user.update({ where: { id: existing.id }, data: { role: 'SUPER_ADMIN' } });
    logger.info({ email }, 'existing account promoted to super admin');
    return 'promoted';
  }

  await prisma.user.create({
    data: {
      email,
      gender: env.ADMIN_GENDER,
      passwordHash: await hashPassword(password),
      displayName,
      role: 'SUPER_ADMIN',
      memberships: {
        create: {
          role: 'OWNER',
          workspace: { create: { name: `${env.APP_NAME} HQ`, slug: `hq-${newId().slice(0, 8)}` } },
        },
      },
    },
  });
  logger.info({ email }, 'super admin seeded');
  return 'created';
}
